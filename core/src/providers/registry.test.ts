import { describe, expect, it } from 'vitest';
import { createMockClient } from '../../../packages/mock-runtime/src/index.ts';
import { WIRE_VERSION } from '../../../packages/contracts/src/wire.ts';
import type { CoreMessage } from '../../../packages/contracts/src/index.ts';
import { createCore } from '../core.ts';
import type { Core } from '../core.ts';
import { createProviderRegistry } from './registry.ts';

/**
 * 注册表的状态判断（ADR-016）。
 *
 * 端口是函数而不是值，正是为了让「提供方什么时候连上」这件事每次都能读到最新
 * 实情。这些用例守住那个区别：连上之前是「没运行」，没登记是「没安装」，
 * 少报能力是「没授权」—— 三者给三种不同的引导，合起来用户就只能干瞪眼。
 */

const CALENDAR_ABILITIES = [
  'calendar.list',
  'calendar.create',
  'calendar.update',
  'calendar.remove',
];

function setup() {
  const core: Core = createCore(createMockClient(), {
    version: 'test',
    installed: ['local.calendar'],
  });
  const registry = createProviderRegistry(core, [
    { id: 'local.calendar', kind: 'calendar' },
  ]);
  const sent: CoreMessage[] = [];
  return { core, registry, sent };
}

function join(core: Core, sent: CoreMessage[], capabilities: string[]) {
  const session = core.connect(
    {
      send: (message: CoreMessage) => sent.push(message),
      close: () => undefined,
    },
    {
      t: 'hello',
      v: WIRE_VERSION,
      client: {
        role: 'provider',
        provider: 'local.calendar',
        label: '本地日历',
        capabilities,
      },
    },
  );
  if (!session) throw new Error('握手被拒');
  return session;
}

describe('提供方注册表', () => {
  it('提供方没连上时报「装了没运行」，而不是「没安装」', () => {
    const { registry } = setup();
    expect(registry.calendar()).toMatchObject({
      status: 'stopped',
      id: 'local.calendar',
    });
  });

  it('提供方连上后同一对象立刻变成就绪 —— 状态是现读的', () => {
    const { core, registry, sent } = setup();
    expect(registry.calendar()?.status).toBe('stopped');
    join(core, sent, CALENDAR_ABILITIES);
    // 同一个引用，不该有"需要重启本体才认得它"这种事。
    expect(registry.calendar()?.status).toBe('ready');
  });

  it('断开后立刻回到「没运行」', () => {
    const { core, registry, sent } = setup();
    const session = join(core, sent, CALENDAR_ABILITIES);
    expect(registry.calendar()?.status).toBe('ready');
    core.disconnect(session.info.id);
    expect(registry.calendar()?.status).toBe('stopped');
  });

  it('少报一个能力就算没授权，不放行半残的提供方', () => {
    const { core, registry, sent } = setup();
    join(
      core,
      sent,
      CALENDAR_ABILITIES.filter((name) => name !== 'calendar.remove'),
    );
    const slot = registry.calendar();
    expect(slot?.status).toBe('denied');
    expect(slot?.missingPermissions).toEqual(['calendar.remove']);
  });

  it('没有登记的种类一律按没安装处理', () => {
    const { registry } = setup();
    // 笔记压根没登记：这不是"装了没运行"，用户该看到的是"还没接笔记源"。
    expect(registry.notes()).toBeUndefined();
  });

  it('呈现形式冒用 provider 身份不算数', () => {
    const { core, registry, sent } = setup();
    core.connect(
      {
        send: (message: CoreMessage) => sent.push(message),
        close: () => undefined,
      },
      {
        t: 'hello',
        v: WIRE_VERSION,
        client: {
          role: 'pet',
          provider: 'local.calendar',
          label: '冒充的宠物',
          capabilities: CALENDAR_ABILITIES,
        },
      },
    );
    // 角色是 pet 就不算提供方上线：否则任何客户端都能自称日历源骗过本体。
    expect(registry.calendar()?.status).toBe('stopped');
  });

  it('本体进程里不留日历实体：调用只是转发', async () => {
    const { core, registry, sent } = setup();
    const calendarSide: CoreMessage[] = [];
    core.connect(
      {
        send: (message: CoreMessage) => calendarSide.push(message),
        close: () => undefined,
      },
      {
        t: 'hello',
        v: WIRE_VERSION,
        client: {
          role: 'provider',
          provider: 'local.calendar',
          label: '本地日历',
          capabilities: CALENDAR_ABILITIES,
        },
      },
    );
    join(core, sent, CALENDAR_ABILITIES);
    const provider = registry.calendar()?.provider;
    if (!provider) throw new Error('没有就绪的端口');
    const context = {
      requestId: 'r',
      workspaceId: 'personal',
      source: 'ui' as const,
    };
    // 不等回执：这个用例只关心"本体是不是把请求转出去了"。测试里没有真的提供方
    // 应答，等下去只会耗到超时 —— 那正是它该有的行为，但与本用例无关。
    void provider
      .create(context, {
        title: '会议',
        startsAt: '2026-10-07T15:00:00+08:00',
        endsAt: '2026-10-07T16:00:00+08:00',
        timeZone: 'Asia/Shanghai',
        idempotencyKey: 'k',
      })
      .catch(() => undefined);

    // 数据在提供方那边：本体发出的能力名不带 pet 之类的前缀，只说做什么。
    const invoked = calendarSide.filter((m) => m.t === 'invoke');
    expect(invoked).toHaveLength(1);
    const message = invoked[0] as Extract<CoreMessage, { t: 'invoke' }>;
    expect(message.capability).toBe('calendar.create');
    expect(message.args).toMatchObject({
      context: { workspaceId: 'personal' },
    });
  });
});
