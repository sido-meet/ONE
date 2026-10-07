import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockClient } from '../../packages/mock-runtime/src/index.ts';
import type { ConversationRuntime } from '../../packages/contracts/src/index.ts';
import type {
  ClientMessage,
  CoreMessage,
} from '../../packages/contracts/src/index.ts';
import { createCore } from './core.ts';
import type { Core } from './core.ts';
import { WIRE_VERSION } from '../../packages/contracts/src/wire.ts';
import { parseCoreMessage } from '../../packages/contracts/src/wire.ts';

/** 一个参与者的收发端，带上它收到的所有消息。 */
function fakeClient() {
  const received: CoreMessage[] = [];
  const sent: string[] = [];
  const connection = {
    send: (message: CoreMessage) => {
      received.push(message);
      sent.push(JSON.stringify(message));
    },
    close: () => {
      sent.push('CLOSED');
    },
  };
  return { connection, received, sent, raw: (index: number) => sent[index] };
}

/** role 是标签，provider 是寻址键；两者分开才认得出"谁提供"和"是什么"。 */
const hello = (
  provider: string,
  capabilities: string[] = [],
  role = provider,
): ClientMessage => ({
  t: 'hello',
  v: WIRE_VERSION,
  client: { role, provider, label: provider, capabilities },
});

const lastResult = (client: ReturnType<typeof fakeClient>) => {
  const messages = client.received.filter((item) => item.t === 'result');
  const last = messages.at(-1);
  if (!last || last.t !== 'result') throw new Error('no result');
  return last;
};

/** 成功回执里的值。失败时直接把错误喊出来 —— 断言 `.value` 时报这个更有用。 */
const resultValue = (client: ReturnType<typeof fakeClient>): unknown => {
  const last = lastResult(client);
  if (!last.ok) throw new Error(`本该成功却失败了：${last.error.message}`);
  return last.value;
};

let client: ConversationRuntime;
let core: Core;

beforeEach(() => {
  vi.useFakeTimers();
  client = createMockClient({ tickMs: 5 });
  core = createCore(client, { version: 'test', installed: ['pet'] });
});

afterEach(() => {
  core.unsubscribe();
  client.dispose();
  vi.useRealTimers();
});

describe('ONE core', () => {
  it('answers a handshake, then pushes state and roster', () => {
    const pet = fakeClient();
    core.connect(pet.connection, hello('pet', ['pet.state']));
    expect(pet.received[0]).toMatchObject({ t: 'welcome', v: WIRE_VERSION });
    expect(pet.received[1]).toMatchObject({ t: 'state' });
    const roster = pet.received[2];
    expect(roster?.t === 'roster' && roster.installed).toEqual(['pet']);
    expect(roster?.t === 'roster' && roster.participants[0]?.provider).toBe(
      'pet',
    );
  });

  it('refuses a first frame that is not hello, and a wrong version', () => {
    const early = fakeClient();
    core.connect(early.connection, { t: 'ping' });
    expect(early.received[0]).toMatchObject({ t: 'rejected' });
    expect(early.sent).toContain('CLOSED');

    const stale = fakeClient();
    const future = hello('pet') as Extract<ClientMessage, { t: 'hello' }>;
    core.connect(stale.connection, { ...future, v: WIRE_VERSION + 1 });
    expect(stale.received[0]).toMatchObject({ t: 'rejected' });
    expect(stale.sent).toContain('CLOSED');
  });

  it('runs whitelisted commands on the single authoritative client', async () => {
    const cli = fakeClient();
    const session = core.connect(cli.connection, hello('cli'));
    if (!session) throw new Error('handshake failed');
    core.handleMessage(session, {
      t: 'call',
      id: 'r1',
      cmd: 'sendMessage',
      args: ['welcome', '来自命令行'],
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(lastResult(cli).ok).toBe(true);
    expect(client.getSnapshot().runs).toHaveLength(1);

    core.handleMessage(session, {
      t: 'call',
      id: 'r2',
      cmd: 'dropDatabase',
      args: [],
    });
    await Promise.resolve();
    expect(lastResult(cli)).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
  });

  it('keeps one writing Run per conversation across clients', async () => {
    const pet = fakeClient();
    const desktop = fakeClient();
    const petSession = core.connect(pet.connection, hello('pet'));
    const desktopSession = core.connect(desktop.connection, hello('desktop'));
    if (!petSession || !desktopSession) throw new Error('handshake failed');
    core.handleMessage(petSession, {
      t: 'call',
      id: 'p1',
      cmd: 'sendMessage',
      args: ['welcome', '来自宠物'],
    });
    await vi.advanceTimersByTimeAsync(10);
    core.handleMessage(desktopSession, {
      t: 'call',
      id: 'd1',
      cmd: 'sendMessage',
      args: ['welcome', '来自桌面'],
    });
    await Promise.resolve();
    expect(lastResult(desktop)).toMatchObject({
      ok: false,
      error: { code: 'BUSY' },
    });
    // 桌面端看到的是同一份历史，而不是另一份内存副本。
    const seen = desktop.received.filter((item) => item.t === 'state').at(-1);
    expect(seen?.t === 'state' && seen.snapshot.runs.length).toBe(1);
  });

  it('lets one client call another capability and relays the answer back', async () => {
    const pet = fakeClient();
    const desktop = fakeClient();
    const petSession = core.connect(
      pet.connection,
      hello('pet', ['pet.state']),
    );
    const desktopSession = core.connect(desktop.connection, hello('desktop'));
    if (!petSession || !desktopSession) throw new Error('handshake failed');

    core.handleMessage(desktopSession, {
      t: 'capability.call',
      id: 'c1',
      target: 'pet',
      capability: 'pet.state',
    });
    const request = pet.received.at(-1);
    expect(request).toMatchObject({ t: 'invoke', capability: 'pet.state' });

    if (request?.t !== 'invoke') throw new Error('no invoke');
    core.handleMessage(petSession, {
      t: 'capability.result',
      id: request.id,
      ok: true,
      value: { mood: 'idle' },
    });
    expect(lastResult(desktop)).toMatchObject({
      ok: true,
      value: { mood: 'idle' },
    });
  });

  it('对方报错时把 details 一起带到 —— 少了它就问不出「现在是第几版」', async () => {
    // 实机验收抓到的：横幅上写的是「第 ? 版」。提供方明明报了 currentVersion，
    // 是本体在进程边界把它扔了，于是界面只能说「被改过了」却给不出版本。
    const pet = fakeClient();
    const desktop = fakeClient();
    const petSession = core.connect(
      pet.connection,
      hello('pet', ['pet.state']),
    );
    const desktopSession = core.connect(desktop.connection, hello('desktop'));
    if (!petSession || !desktopSession) throw new Error('handshake failed');

    core.handleMessage(desktopSession, {
      t: 'capability.call',
      id: 'c2',
      target: 'pet',
      capability: 'pet.state',
    });
    const request = pet.received.at(-1);
    if (request?.t !== 'invoke') throw new Error('no invoke');
    core.handleMessage(petSession, {
      t: 'capability.result',
      id: request.id,
      ok: false,
      code: 'CONFLICT',
      message: '这条已被其他操作更新',
      details: { expectedVersion: 1, currentVersion: 3 },
    });

    const answer = lastResult(desktop);
    expect(answer).toMatchObject({
      ok: false,
      error: {
        code: 'CONFLICT',
        details: { expectedVersion: 1, currentVersion: 3 },
      },
    });
    // 走线上帧再走一遍：解析不认识这个字段的话，到页面手上又会没了。
    const raw = desktop.sent.at(-1) ?? '';
    const wire = parseCoreMessage(JSON.parse(raw));
    expect(wire).toMatchObject({
      ok: false,
      error: { details: { currentVersion: 3 } },
    });
  });

  it('reports the right failure for a missing client or capability', async () => {
    const desktop = fakeClient();
    const session = core.connect(desktop.connection, hello('desktop'));
    if (!session) throw new Error('handshake failed');

    core.handleMessage(session, {
      t: 'capability.call',
      id: 'm1',
      target: 'pet',
      capability: 'pet.state',
    });
    expect(lastResult(desktop)).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });

    const pet = fakeClient();
    core.connect(pet.connection, hello('pet', ['pet.state']));
    core.handleMessage(session, {
      t: 'capability.call',
      id: 'm2',
      target: 'pet',
      capability: 'pet.quit',
    });
    expect(lastResult(desktop)).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  });

  it('fails a pending call when the target client disconnects', () => {
    const pet = fakeClient();
    const desktop = fakeClient();
    const petSession = core.connect(
      pet.connection,
      hello('pet', ['pet.state']),
    );
    const desktopSession = core.connect(desktop.connection, hello('desktop'));
    if (!petSession || !desktopSession) throw new Error('handshake failed');

    core.handleMessage(desktopSession, {
      t: 'capability.call',
      id: 'x1',
      target: 'pet',
      capability: 'pet.state',
    });
    core.disconnect(petSession.info.id);
    expect(lastResult(desktop)).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL' },
    });
    expect(core.roster().map((item) => item.provider)).toEqual(['desktop']);
  });

  it('only launches clients that are actually installed', async () => {
    const cli = fakeClient();
    const session = core.connect(cli.connection, hello('cli'));
    if (!session) throw new Error('handshake failed');
    const launch = vi.fn();

    core.handleMessage(session, {
      t: 'clients.launch',
      id: 'l1',
      provider: 'desktop',
    });
    await Promise.resolve();
    expect(lastResult(cli)).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });

    core.markInstalled('desktop');
    const coreWithLauncher = createCore(client, {
      version: 'test',
      installed: ['pet', 'desktop'],
      launchClient: launch,
    });
    const fresh = fakeClient();
    const freshSession = coreWithLauncher.connect(
      fresh.connection,
      hello('cli'),
    );
    if (!freshSession) throw new Error('handshake failed');
    coreWithLauncher.handleMessage(freshSession, {
      t: 'clients.launch',
      id: 'l2',
      provider: 'desktop',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(launch).toHaveBeenCalledWith('desktop');
    coreWithLauncher.unsubscribe();
  });

  it('treats connecting as not equal to being installed', () => {
    const cli = fakeClient();
    core.connect(cli.connection, hello('cli'));
    expect(core.installed()).toEqual(['pet']);
  });

  /**
   * `null` 是管道里「没有值」的写法。
   *
   * `JSON.stringify([undefined])` 得到的是 `"[null]"`。以前 `createConversation`
   * 把这个 `null` 原样递给运行时，而运行时的默认参数 `title = '新的对话'` 只对
   * `undefined` 生效 —— `null.trim()` 抛异常。实测后果：桌面端「开始新对话」
   * 一点就是「ONE 内部出了点问题」，对话压根没建出来。
   */
  it('不传标题时也能建对话（null 是管道里的「没传值」）', async () => {
    const cli = fakeClient();
    const session = core.connect(cli.connection, hello('cli'));
    if (!session) throw new Error('握手失败');
    core.handleMessage(session, {
      t: 'call',
      id: 'c1',
      cmd: 'createConversation',
      // 走一遍真实的 JSON 往返，而不是直接调函数 —— 那个 bug 正是在这里。
      args: JSON.parse(JSON.stringify([undefined])),
    } as never);
    await Promise.resolve();
    await Promise.resolve();
    const reply = lastResult(cli);
    expect(reply.ok).toBe(true);
    expect(resultValue(cli)).toMatchObject({ title: '新的对话' });
    expect(core.installed()).toEqual(['pet']);
  });

  it('空标题与空白标题都按默认名算，不建出一条空白对话', async () => {
    for (const [id, title] of [
      ['c2', ''],
      ['c3', '   '],
    ] as const) {
      const cli = fakeClient();
      const session = core.connect(cli.connection, hello('cli'));
      if (!session) throw new Error('握手失败');
      core.handleMessage(session, {
        t: 'call',
        id,
        cmd: 'createConversation',
        args: [title],
      } as never);
      await Promise.resolve();
      await Promise.resolve();
      expect(resultValue(cli)).toMatchObject({ title: '新的对话' });
    }
  });
});
