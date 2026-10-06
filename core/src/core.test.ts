import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockClient } from '../../packages/mock-runtime/src/index.ts';
import type { OneClient } from '../../packages/contracts/src/index.ts';
import type {
  ClientMessage,
  CoreMessage,
} from '../../packages/contracts/src/index.ts';
import { createCore } from './core.ts';
import type { Core } from './core.ts';
import { WIRE_VERSION } from '../../packages/contracts/src/wire.ts';

/** 一个客户端的收发端，带上它收到的所有消息。 */
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

const hello = (
  kind: 'pet' | 'desktop' | 'cli',
  capabilities: string[] = [],
): ClientMessage => ({
  t: 'hello',
  v: WIRE_VERSION,
  client: { kind, label: kind, capabilities },
});

const lastResult = (client: ReturnType<typeof fakeClient>) => {
  const messages = client.received.filter((item) => item.t === 'result');
  const last = messages.at(-1);
  if (!last || last.t !== 'result') throw new Error('no result');
  return last;
};

let client: OneClient;
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
    expect(roster?.t === 'roster' && roster.clients[0]?.kind).toBe('pet');
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
    expect(core.roster().map((item) => item.kind)).toEqual(['desktop']);
  });

  it('only launches clients that are actually installed', async () => {
    const cli = fakeClient();
    const session = core.connect(cli.connection, hello('cli'));
    if (!session) throw new Error('handshake failed');
    const launch = vi.fn();

    core.handleMessage(session, {
      t: 'clients.launch',
      id: 'l1',
      kind: 'desktop',
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
      kind: 'desktop',
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
});
