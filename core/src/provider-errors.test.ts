import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMemoryProviders,
  createMemoryRuntime,
} from '../../packages/mock-runtime/src/index.ts';
import type { MemoryProviders } from '../../packages/mock-runtime/src/index.ts';
import type {
  CalendarProvider,
  CommandContext,
  ConversationRuntime,
  CoreMessage,
  ProviderSlot,
} from '../../packages/contracts/src/index.ts';
import {
  PROVIDER_CONTRACT_VERSION,
  parseClientMessage,
  providerNotAuthorized,
  providerNotInstalled,
  providerNotRunning,
  providerVersionConflict,
  resolveProvider,
} from '../../packages/contracts/src/index.ts';
import { WIRE_VERSION } from '../../packages/contracts/src/wire.ts';
import { createCore } from './core.ts';
import type { Core, DomainPorts } from './core.ts';

/**
 * 领域端口的四类失败必须彼此可分（ADR-016）。合成一句「出了点问题」，
 * 界面就只能给一句废话，用户既不知道该装还是该授权，也不知道该升级谁。
 */

const context: CommandContext = {
  requestId: 'r',
  workspaceId: 'personal',
  source: 'ui',
};

const meeting = {
  title: '面试',
  startsAt: '2026-10-07T15:00:00+08:00',
  endsAt: '2026-10-07T16:00:00+08:00',
  timeZone: 'Asia/Shanghai',
  idempotencyKey: 'k1',
};

/** 返回值刻意不带 undefined，好让 {...ready(p)} 展开后仍是完整的 slot。 */
const ready = (providers: MemoryProviders, id = 'local.calendar') => ({
  id,
  kind: 'calendar' as const,
  status: 'ready' as const,
  providerVersion: PROVIDER_CONTRACT_VERSION,
  provider: providers.calendar,
});

describe('provider availability semantics', () => {
  it('separates the four reasons instead of one vague failure', () => {
    const providers = createMemoryProviders();
    const cases = [
      {
        thrown: () => resolveProvider(undefined, 'calendar'),
        code: 'UNAVAILABLE',
        reason: 'not-installed',
        message: /还没有接日历源/,
      },
      {
        thrown: () =>
          resolveProvider(
            { id: 'local.calendar', kind: 'calendar', status: 'stopped' },
            'calendar',
          ),
        code: 'UNAVAILABLE',
        reason: 'not-running',
        message: /没有连上/,
      },
      {
        thrown: () =>
          resolveProvider(
            {
              id: 'outlook.calendar',
              kind: 'calendar',
              status: 'denied',
              missingPermissions: ['Mail.Read'],
            },
            'calendar',
          ),
        code: 'PERMISSION_DENIED',
        reason: 'not-authorized',
        message: /Mail.Read/,
      },
      {
        thrown: () =>
          resolveProvider(
            {
              id: 'local.calendar',
              kind: 'calendar',
              status: 'ready',
              providerVersion: 99,
              provider: providers.calendar,
            },
            'calendar',
          ),
        code: 'CONFLICT',
        reason: 'version-conflict',
        message: /插件 99/,
      },
    ];

    const seen = new Set<string>();
    for (const item of cases) {
      let caught: unknown;
      try {
        item.thrown();
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: item.code,
        message: expect.stringMatching(item.message),
        details: { providerProblem: { reason: item.reason } },
      });
      // 没装与没运行都是 UNAVAILABLE，只有结构化 reason 能把它们分开。
      seen.add(
        `${String(caught && (caught as { code: string }).code)}:${item.reason}`,
      );
    }
    expect(seen.size).toBe(4);
    expect(providerNotInstalled('notes').code).toBe('UNAVAILABLE');
    expect(providerNotRunning('notes', 'x').code).toBe('UNAVAILABLE');
    expect(providerNotAuthorized('notes', 'x', ['a']).code).toBe(
      'PERMISSION_DENIED',
    );
    expect(providerVersionConflict('notes', 'x', 1, 2).code).toBe('CONFLICT');
    providers.dispose();
  });

  it('names the missing permissions and both versions in the details', () => {
    expect(
      providerNotAuthorized('calendar', 'outlook.calendar', [
        'Mail.Read',
        'Calendars.ReadWrite',
      ]).details,
    ).toMatchObject({
      providerProblem: {
        reason: 'not-authorized',
        provider: 'outlook.calendar',
        missing: ['Mail.Read', 'Calendars.ReadWrite'],
      },
    });
    expect(
      providerVersionConflict('calendar', 'local.calendar', 99, 1).details,
    ).toMatchObject({
      providerProblem: {
        reason: 'version-conflict',
        providerVersion: 99,
        coreVersion: 1,
      },
    });
  });
});

describe('core dispatching domain commands', () => {
  let runtime: ConversationRuntime;
  let providers: MemoryProviders;
  let core: Core;
  let sent: CoreMessage[];
  /** handleMessage 要的是会话，不是连接；connect 会把它返回来。 */
  let session: ReturnType<Core['connect']>;

  /** 端口现在是函数：状态每次现读。这里包一层，把固定的 slot 固定下来。 */
  const fixed =
    (
      slot: ProviderSlot<CalendarProvider> | undefined,
    ): (() => ProviderSlot<CalendarProvider> | undefined) =>
    () =>
      slot;

  const connect = (domains?: (p: MemoryProviders) => DomainPorts) => {
    runtime = createMemoryRuntime();
    providers = createMemoryProviders();
    core = createCore(runtime, {
      version: 'test',
      installed: ['pet'],
      // 端口必须绑到这一轮新建的 providers 上，否则断言读的是另一份数据。
      ...(domains ? { domains: domains(providers) } : {}),
    });
    sent = [];
    session = core.connect(
      {
        send: (message: CoreMessage) => sent.push(message),
        close: () => undefined,
      },
      {
        t: 'hello',
        v: WIRE_VERSION,
        client: {
          role: 'pet',
          provider: 'pet',
          label: 'pet',
          capabilities: [],
        },
      },
    );
    if (!session) throw new Error('handshake refused');
    sent = [];
  };

  const call = async (cmd: string, args: unknown[]) => {
    if (!session) throw new Error('not connected');
    core.handleMessage(session, { t: 'call', id: 'r1', cmd, args });
    await Promise.resolve();
    await Promise.resolve();
    const last = sent.filter((item) => item.t === 'result').at(-1);
    if (!last || last.t !== 'result') throw new Error('no result');
    return last;
  };

  /** 失败结果的判别联合要靠 ok 收窄，否则读不到 error。 */
  const failureOf = (
    frame: Extract<CoreMessage, { t: 'result' }>,
  ): Extract<Extract<CoreMessage, { t: 'result' }>, { ok: false }>['error'] => {
    if (frame.ok || !('error' in frame)) throw new Error('expected failure');
    return frame.error;
  };

  beforeEach(() => connect());

  afterEach(() => {
    core.unsubscribe();
    runtime.dispose();
    providers.dispose();
  });

  it('reports each unavailable reason back over the wire, one by one', async () => {
    connect();
    expect(await call('calendarCreate', [context, meeting])).toMatchObject({
      ok: false,
      error: { code: 'UNAVAILABLE' },
    });
    expect((await call('calendarCreate', [context, meeting])).t).toBe('result');

    core.unsubscribe();
    connect(() => ({
      calendar: fixed({
        id: 'local.calendar',
        kind: 'calendar',
        status: 'stopped',
      }),
    }));
    expect(await call('calendarCreate', [context, meeting])).toMatchObject({
      ok: false,
      error: { code: 'UNAVAILABLE' },
    });

    core.unsubscribe();
    connect(() => ({
      calendar: fixed({
        id: 'outlook.calendar',
        kind: 'calendar',
        status: 'denied',
        missingPermissions: ['Mail.Read'],
      }),
    }));
    const deniedError = failureOf(
      await call('calendarCreate', [context, meeting]),
    );
    expect(deniedError.code).toBe('PERMISSION_DENIED');
    expect(deniedError.details).toMatchObject({
      providerProblem: { reason: 'not-authorized', missing: ['Mail.Read'] },
    });

    core.unsubscribe();
    connect((p) => ({
      calendar: fixed({
        ...ready(p),
        providerVersion: PROVIDER_CONTRACT_VERSION + 1,
      }),
    }));
    expect(await call('calendarCreate', [context, meeting])).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
  });

  it('says the provider is missing rather than blaming the arguments', async () => {
    // 没安装时日历命令根本不该谈参数校验：用户没有机会把参数填对。
    const missing = failureOf(
      await call('calendarCreate', [context, { garbage: true }]),
    );
    expect(missing.code).toBe('UNAVAILABLE');
    expect(
      (missing.details as { providerProblem?: { reason?: string } })
        .providerProblem?.reason,
    ).toBe('not-installed');
  });

  it('validates input at the boundary once the provider is reachable', async () => {
    connect((p) => ({ calendar: fixed(ready(p)) }));
    expect(
      failureOf(
        await call('calendarCreate', [
          context,
          { ...meeting, endsAt: '2026-10-07T16:00:00' },
        ]),
      ).code,
    ).toBe('VALIDATION');
  });

  it('keeps domain data out of the conversation snapshot', async () => {
    connect((p) => ({ calendar: fixed(ready(p)) }));
    expect(await call('calendarCreate', [context, meeting])).toMatchObject({
      ok: true,
    });
    expect(providers.read().calendarEvents).toHaveLength(1);

    const snapshot = runtime.getSnapshot();
    expect(snapshot).not.toHaveProperty('notes');
    expect(snapshot).not.toHaveProperty('calendarEvents');
  });
});

/**
 * `details` 跨进程这一段（实机验收补上的）。
 *
 * 界面上「它现在是第 ? 版」那个问号就是这么来的：提供方把版本号放在 details 里，
 * 而本体在进程边界只带了 code 与 message。少这一段，冲突就只能说「被改过了」，
 * 用户没法决定是放弃自己那份还是再看一眼对方那份。
 */
describe('details 跨进程', () => {
  const failure = (details: unknown) =>
    parseClientMessage({
      t: 'capability.result',
      id: 'r1',
      ok: false,
      code: 'CONFLICT',
      message: '这条已被其他操作更新',
      details,
    });

  it('版本号原样带到本体', () => {
    expect(failure({ expectedVersion: 1, currentVersion: 3 })).toMatchObject({
      t: 'capability.result',
      ok: false,
      code: 'CONFLICT',
      details: { expectedVersion: 1, currentVersion: 3 },
    });
  });

  it('报错的一方写什么不是由它说了算：只放行扁平的基本类型', () => {
    // details 来自被调用的那一方，是不可信输入。带过去的结构化内容会让上游界面
    // 去显示它没准备过的东西，丢掉只是少一条附加信息。
    expect(failure({ currentVersion: 3, note: { a: 1 } })).toMatchObject({
      details: { currentVersion: 3 },
    });
    expect(failure({ list: [1, 2] })).toMatchObject({});
    expect(failure('nope')).toMatchObject({});
    expect(failure({})).toMatchObject({});
    expect(failure([{ currentVersion: 3 }])).toMatchObject({});
    // 数字要有限值：NaN 序列化过去会变成 null，对面只会拿到一个看不懂的东西。
    expect(failure({ currentVersion: Number.NaN })).toMatchObject({});
    expect(failure({ currentVersion: Number.POSITIVE_INFINITY })).toMatchObject(
      {},
    );
    // 键数有上限，别让人拿它当运货的地方。
    const wide = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`k${index}`, index]),
    );
    const kept = failure(wide);
    const keptDetails = kept && 'details' in kept ? (kept.details ?? {}) : {};
    expect(Object.keys(keptDetails).length).toBeLessThanOrEqual(8);
  });
});
