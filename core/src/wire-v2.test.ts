import { describe, expect, it } from 'vitest';
import { createMemoryRuntime } from '../../packages/mock-runtime/src/index.ts';
import {
  CAPABILITY,
  WIRE_VERSION,
  isProviderId,
  isParticipantRole,
  parseClientMessage,
  parseCoreMessage,
} from '../../packages/contracts/src/index.ts';
import { createCore } from './core.ts';
import type { Core } from './core.ts';

/**
 * 协议 v2 的关键主张（ADR-017）。
 *
 * 旧协议把三种东西塞进一个 `ClientKind` 枚举，于是任何日历提供方来握手都会被
 * 当成非法帧拒掉 —— 协议层面就不允许第三方存在。这里的每一条都是那个缺陷的反面：
 * 提供方能进来、能被寻址，老版本被明确拒绝而不是靠猜。
 */

function coreWith(installed: string[] = ['pet']): Core {
  return createCore(createMemoryRuntime(), { version: 'test', installed });
}

function pipe() {
  const sent: unknown[] = [];
  return {
    sent,
    connection: {
      send: (message: unknown) => sent.push(message),
      close: () => sent.push('CLOSED'),
    },
  };
}

const hello = (client: Record<string, unknown>, v = WIRE_VERSION) =>
  ({ t: 'hello', v, client }) as never;

describe('寻址键与角色', () => {
  it('接受小写分段的形式，拒绝会造成歧义的写法', () => {
    for (const good of ['pet', 'desktop', 'cli', 'local.calendar', 'a-b.c']) {
      expect(isProviderId(good)).toBe(true);
    }
    // 寻址键会进日志、进命令行、进 one-plugin:// 的 host 部分。
    // 空格与斜杠在那三个地方都会被重新解释，等于给了别人冒充的入口。
    for (const bad of [
      '',
      'Pet',
      'local calendar',
      'local/calendar',
      '../x',
      '1pet',
    ]) {
      expect(isProviderId(bad)).toBe(false);
    }
    expect(isParticipantRole('pet')).toBe(true);
    expect(isParticipantRole('Provider')).toBe(false);
  });

  it('角色不穷举：换一个角色不必改协议', () => {
    // 枚举每加一种就要改一次协议，把注册表写死在代码里。
    const helloFrame = parseClientMessage(
      hello({
        role: 'provider',
        provider: 'local.calendar',
        label: '日历',
        capabilities: [],
      }),
    );
    expect(helloFrame).not.toBeNull();
  });

  it('角色与寻址键必须各司其职，缺一不可', () => {
    const base = { label: '日历', capabilities: [] };
    expect(
      parseClientMessage(hello({ provider: 'local.calendar', ...base })),
    ).toBeNull();
    expect(parseClientMessage(hello({ role: 'provider', ...base }))).toBeNull();
  });
});

describe('本体接受参与者', () => {
  it('日历提供方能握手并出现在名册里', () => {
    const core = coreWith(['pet', 'local.calendar']);
    const { connection, sent } = pipe();
    const session = core.connect(
      connection,
      hello({
        role: 'provider',
        provider: 'local.calendar',
        label: '本地日历',
        capabilities: ['calendar.list'],
      }),
    );
    expect(session).not.toBeNull();
    expect(core.roster()).toMatchObject([
      { provider: 'local.calendar', role: 'provider' },
    ]);
    expect(core.installed()).toContain('local.calendar');
    expect(sent[0]).toMatchObject({ t: 'welcome', v: WIRE_VERSION });
  });

  it('角色相同但寻址键不同的两个参与者不会互相顶掉', () => {
    const core = coreWith(['local.calendar', 'outlook.calendar']);
    core.connect(
      pipe().connection,
      hello({
        role: 'provider',
        provider: 'local.calendar',
        label: '本地',
        capabilities: ['calendar.list'],
      }),
    );
    core.connect(
      pipe().connection,
      hello({
        role: 'provider',
        provider: 'outlook.calendar',
        label: 'Outlook',
        capabilities: ['calendar.list'],
      }),
    );
    expect(core.roster().map((item) => item.provider)).toEqual([
      'local.calendar',
      'outlook.calendar',
    ]);
  });

  it('老版本客户端被明确拒绝，不做兼容猜测', () => {
    const core = coreWith();
    const { connection, sent } = pipe();
    const session = core.connect(
      connection,
      hello(
        { role: 'pet', provider: 'pet', label: '宠物', capabilities: [] },
        1,
      ),
    );
    expect(session).toBeNull();
    expect(sent[0]).toMatchObject({ t: 'rejected' });
    expect((sent[0] as { message: string }).message).toContain(
      '协议版本不兼容',
    );
  });

  it('v1 的 hello 形状本身也解析不过去，旧客户端连帧都发不出来', () => {
    // 双重保险：解析层按 v2 形状读，读不出 kind 就直接拒。
    expect(
      parseClientMessage({
        t: 'hello',
        v: 1,
        client: { kind: 'pet', label: '宠物', capabilities: [] },
      }),
    ).toBeNull();
  });
});

describe('名册与安装清单', () => {
  it('名册用 participants，安装清单只收合法寻址键', () => {
    const parsed = parseCoreMessage({
      t: 'roster',
      participants: [
        {
          id: 'a',
          role: 'pet',
          provider: 'pet',
          label: '宠物',
          capabilities: [],
          connectedAt: '2026-10-07T00:00:00Z',
        },
        { id: 'b', kind: '旧的形状', capabilities: [], connectedAt: 'x' },
      ],
      installed: ['pet', 'Bad Id', 'local.calendar'],
    });
    expect(parsed?.t === 'roster' && parsed.participants).toHaveLength(1);
    expect(parsed?.t === 'roster' && parsed.installed).toEqual([
      'pet',
      'local.calendar',
    ]);
  });

  it('install 之后才算装上了：连上来不等于装了', () => {
    const core = coreWith(['pet']);
    expect(core.installed()).not.toContain('desktop');
    core.markInstalled('desktop');
    expect(core.installed()).toContain('desktop');
  });
});

describe('能力名', () => {
  it('协议层不校验名字长什么样，只约定它不带实现前缀', () => {
    // 解析器不猜名字：它只是字符串。真正的约束是命名约定，由 Rust 与 TS
    // 两边的测试各自断言字面量（见 main.rs 的 capability_names_...）。
    const frame = parseClientMessage(
      hello({
        role: 'pet',
        provider: 'pet',
        label: '宠物',
        capabilities: [CAPABILITY.bubbleOpen],
      }),
    );
    expect(frame?.t === 'hello' && frame.client.capabilities).toEqual([
      'bubble.open',
    ]);
  });

  it('契约里的能力名确实不带实现前缀', () => {
    for (const name of Object.values(CAPABILITY)) {
      expect(name).not.toMatch(/^(pet|desktop)\./);
    }
    expect(Object.values(CAPABILITY)).toContain('bubble.open');
  });

  it('按寻址键转发，而不是按角色：宠物与提供方同名能力互不干扰', () => {
    const core = coreWith(['pet', 'local.calendar']);
    const petSide = pipe();
    const calendarSide = pipe();
    const cliSide = pipe();
    core.connect(
      petSide.connection,
      hello({
        role: 'pet',
        provider: 'pet',
        label: '宠物',
        capabilities: ['window.show'],
      }),
    );
    core.connect(
      calendarSide.connection,
      hello({
        role: 'provider',
        provider: 'local.calendar',
        label: '日历',
        capabilities: ['window.show'],
      }),
    );
    const cli = core.connect(
      cliSide.connection,
      hello({
        role: 'cli',
        provider: 'cli',
        label: '命令行',
        capabilities: [],
      }),
    );
    if (!cli) throw new Error('cli 握手被拒');
    core.handleMessage(cli, {
      t: 'capability.call',
      id: 'x',
      target: 'local.calendar',
      capability: 'window.show',
    });
    // 提供方收到了，宠物没有 —— 两者同名能力不相干。
    expect(
      calendarSide.sent.some((m) => (m as { t: string }).t === 'invoke'),
    ).toBe(true);
    expect(petSide.sent.some((m) => (m as { t: string }).t === 'invoke')).toBe(
      false,
    );
  });
});
