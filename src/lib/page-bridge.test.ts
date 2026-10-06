import { describe, expect, it } from 'vitest';
import { createMockClient } from '../../packages/mock-runtime/src/index.ts';
import {
  CALENDAR_CAPABILITIES,
  ClientError,
  NOTES_CAPABILITIES,
  PAGE_DOMAIN_COMMANDS,
  PAGE_PROTOCOL,
  PAGE_READ_CAPABILITY,
  isPagePath,
  parsePageRequest,
  pluginPageUrl,
} from '../../packages/contracts/src/index.ts';
import { attachPluginPage } from './page-bridge';
import type { CoreClient } from './core-link';

/**
 * 宿主 ↔ 插件页面的桥（ADR-018）。
 *
 * 页面跑在不透明来源里，说的话是敌意的输入。下面的断言都在同一件事上：**页面能
 * 要到的东西，就只有它自己那一份**。
 */

/** 一个够用的假宿主：只需要收消息与退订。 */
function fakeHost() {
  const listeners = new Set<(event: MessageEvent) => void>();
  return {
    host: {
      addEventListener: (
        _type: string,
        listener: (event: MessageEvent) => void,
      ) => listeners.add(listener),
      removeEventListener: (
        _type: string,
        listener: (event: MessageEvent) => void,
      ) => listeners.delete(listener),
    },
    send(data: unknown, source: unknown) {
      for (const listener of listeners) {
        listener({ data, source } as MessageEvent);
      }
    },
    get size() {
      return listeners.size;
    },
  };
}

/** 假 iframe：它自己的 contentWindow 既是收件人也是"来源"。 */
function fakeFrame() {
  const posted: { data: unknown; origin: string }[] = [];
  const contentWindow = {
    postMessage: (data: unknown, origin: string) =>
      posted.push({ data, origin }),
  };
  return {
    frame: { contentWindow } as unknown as HTMLIFrameElement,
    contentWindow,
    posted,
  };
}

/** 只实现桥用到的那几个方法的假 link。 */
function fakeLink(
  callCommand: (command: string, args: unknown[]) => Promise<unknown>,
): CoreClient {
  return {
    callCommand,
    snapshot: () => createMockClient().getSnapshot(),
  } as unknown as CoreClient;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('页面消息', () => {
  it('不认识的消息与能力名一律丢掉，不回话', () => {
    expect(parsePageRequest(null)).toBeNull();
    expect(parsePageRequest('hello')).toBeNull();
    expect(
      parsePageRequest({ id: '1', capability: 'calendar.list' }),
    ).toBeNull();
    expect(
      parsePageRequest({
        protocol: 'somebody.else/v1',
        id: '1',
        capability: 'calendar.list',
      }),
    ).toBeNull();
    expect(
      parsePageRequest({
        protocol: PAGE_PROTOCOL,
        id: '',
        capability: 'calendar.list',
      }),
    ).toBeNull();
    // 表外的能力连解析都过不去 —— 页面自报的身份在这里毫无分量。
    expect(
      parsePageRequest({
        protocol: PAGE_PROTOCOL,
        id: '1',
        capability: 'pet.windowShow',
      }),
    ).toBeNull();
    expect(
      parsePageRequest({
        protocol: PAGE_PROTOCOL,
        id: '1',
        capability: 'calendar.list',
        args: undefined,
      })?.args,
    ).toBeUndefined();
  });

  it('能力表与领域能力一一对应，不多不少', () => {
    const domain = [...CALENDAR_CAPABILITIES, ...NOTES_CAPABILITIES];
    expect(Object.keys(PAGE_DOMAIN_COMMANDS).sort()).toEqual(
      [...domain].sort(),
    );
    // 命令名与能力名是两套词：remove 的命令叫 delete，靠拼字符串得不到它。
    expect(PAGE_DOMAIN_COMMANDS['calendar.remove']).toBe('calendarDelete');
    expect(PAGE_DOMAIN_COMMANDS['notes.remove']).toBe('notesDelete');
  });

  it('页面路径挡住目录穿越', () => {
    for (const bad of [
      '../secrets',
      'a/../../b',
      'C:/windows/system32',
      'a\\b',
      '/absolute.html',
      'trailing/',
      '',
    ]) {
      expect(isPagePath(bad)).toBe(false);
    }
    expect(isPagePath('index.html')).toBe(true);
    expect(isPagePath('views/day.html')).toBe(true);
  });

  it('页面地址的基址由壳按平台给出，寻址键放路径里', () => {
    // Windows 上必须直接写 wry 改写后的形式：iframe 的资源请求匹配不上
    // `one-plugin://` 原地址，匹配不上就永远到不了协议处理器，表现为一片空白。
    expect(
      pluginPageUrl(
        'http://one-plugin.localhost',
        'local.calendar',
        'index.html',
      ),
    ).toBe('http://one-plugin.localhost/local.calendar/index.html');
    expect(
      pluginPageUrl('one-plugin://localhost', 'local.notes', 'index.html'),
    ).toBe('one-plugin://localhost/local.notes/index.html');
  });
});

describe('宿主这一侧的桥', () => {
  it('把能力名换成本体命令，并自己补上命令上下文', async () => {
    const calls: { command: string; args: unknown[] }[] = [];
    const link = fakeLink((command, args) => {
      calls.push({ command, args });
      return Promise.resolve({ items: [] });
    });
    const { host, send } = fakeHost();
    const { frame, contentWindow, posted } = fakeFrame();
    const bridge = attachPluginPage({
      link,
      provider: 'local.calendar',
      frame,
      host,
    });

    send(
      {
        protocol: PAGE_PROTOCOL,
        id: 'p1',
        capability: 'calendar.list',
        args: { rangeStart: 'a', rangeEnd: 'b', timeZone: 'Asia/Shanghai' },
      },
      contentWindow,
    );
    await tick();

    expect(calls[0]?.command).toBe('calendarList');
    // 上下文由宿主给：页面说了不算，也没法说。
    const [context] = calls[0]?.args as [
      { workspaceId: string; source: string },
      unknown,
    ];
    expect(context.workspaceId).toBe('personal');
    expect(context.source).toBe('ui');
    expect(posted[0]?.data).toMatchObject({
      protocol: PAGE_PROTOCOL,
      id: 'p1',
      ok: true,
    });
    bridge.dispose();
  });

  it('只认自己那个 iframe：别的窗口发来的一律不理', async () => {
    let called = 0;
    const link = fakeLink(() => {
      called += 1;
      return Promise.resolve({});
    });
    const { host, send } = fakeHost();
    const { frame, contentWindow, posted } = fakeFrame();
    const bridge = attachPluginPage({
      link,
      provider: 'local.calendar',
      frame,
      host,
    });

    // 另一个窗口（比如另一个插件的页面）发来一条格式完全正确的请求。
    send(
      { protocol: PAGE_PROTOCOL, id: 'x', capability: 'notes.list', args: {} },
      { postMessage: () => undefined },
    );
    await tick();
    expect(called).toBe(0);
    expect(posted).toHaveLength(0);

    // 自己那个窗口发同样的请求，就有人应了。
    send(
      { protocol: PAGE_PROTOCOL, id: 'y', capability: 'notes.list', args: {} },
      contentWindow,
    );
    await tick();
    expect(called).toBe(1);
    expect(posted).toHaveLength(1);
    bridge.dispose();
  });

  it('本体拒绝时把原因送回页面，不装作成功', async () => {
    const link = fakeLink(() =>
      Promise.reject(
        new ClientError('PERMISSION_DENIED', '日历源缺少授权：calendar.list'),
      ),
    );
    const { host, send } = fakeHost();
    const { frame, contentWindow, posted } = fakeFrame();
    const bridge = attachPluginPage({
      link,
      provider: 'local.calendar',
      frame,
      host,
    });

    send(
      {
        protocol: PAGE_PROTOCOL,
        id: 'p9',
        capability: 'calendar.create',
        args: {},
      },
      contentWindow,
    );
    await tick();

    expect(posted[0]?.data).toMatchObject({
      id: 'p9',
      ok: false,
      message: '日历源缺少授权：calendar.list',
    });
    bridge.dispose();
  });

  it('退订之后不再应答', async () => {
    let called = 0;
    const link = fakeLink(() => {
      called += 1;
      return Promise.resolve({});
    });
    // 不解构 `size`：解构会把 getter 读成一个当时的值，后面再看就永远是 0。
    const events = fakeHost();
    const { frame, contentWindow, posted } = fakeFrame();
    const bridge = attachPluginPage({
      link,
      provider: 'local.calendar',
      frame,
      host: events.host,
    });
    expect(events.size).toBe(1);
    bridge.dispose();
    expect(events.size).toBe(0);

    events.send(
      { protocol: PAGE_PROTOCOL, id: 'z', capability: 'notes.list', args: {} },
      contentWindow,
    );
    await tick();
    expect(called).toBe(0);
    expect(posted).toHaveLength(0);
  });
});

describe('提供方申报的页面', () => {
  it('取页面用的能力名不带实现前缀', () => {
    expect(PAGE_READ_CAPABILITY).toBe('page.read');
    expect(PAGE_READ_CAPABILITY).not.toContain('local');
  });
});
