import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockClient } from '../../packages/mock-runtime/src';
import { createHostClient } from './host';
import { createProxyClient } from './proxy-client';
import { createMemoryTransportPair } from './transport';
import { HOST_COMMAND, HOST_RESULT, HOST_SNAPSHOT } from './protocol';
import type { HostClient } from './host';
import type { ProxyClient } from './proxy-client';

let host: HostClient | undefined;
let proxy: ProxyClient | undefined;

afterEach(() => {
  proxy?.dispose();
  host?.dispose();
  vi.useRealTimers();
});

/** One authoritative client with one proxy window, wired over an in-memory bus. */
function pair() {
  const transport = createMemoryTransportPair();
  host = createHostClient(createMockClient({ tickMs: 5 }), transport.host);
  proxy = createProxyClient(transport.window);
  return {
    transport,
    authority: host,
    client: host.client,
    remote: proxy.client,
  };
}

describe('cross-window authority', () => {
  it('gives the proxy window a snapshot without a second mock client', async () => {
    const { client, remote } = pair();
    expect(client.getSnapshot().conversations).toHaveLength(1);
    // The window starts empty and fills from the host's first broadcast.
    expect(remote.getSnapshot().conversations).toHaveLength(1);
    expect(remote.getSnapshot().conversations[0]?.id).toBe('welcome');
  });

  it('runs one conversation across both windows with the same id and Run', async () => {
    vi.useFakeTimers();
    const { client, remote } = pair();
    const run = await remote.sendMessage('welcome', '从宠物窗口发出');
    const seenByHost = client.getSnapshot();
    expect(seenByHost.conversations[0]?.id).toBe('welcome');
    expect(seenByHost.runs.map((item) => item.id)).toEqual([run.id]);
    const message = seenByHost.events.find(
      (event) => event.type === 'message.created',
    );
    expect(message).toMatchObject({ message: { content: '从宠物窗口发出' } });
    vi.runAllTimers();
    // The host window keeps the finished history; the proxy agrees.
    const hostEvents = client.getSnapshot().events;
    const proxyEvents = remote.getSnapshot().events;
    expect(proxyEvents.map((event) => event.id)).toEqual(
      hostEvents.map((event) => event.id),
    );
    expect(remote.getSnapshot().runs[0]?.status).toBe('completed');
  });

  it('keeps a single writing Run per conversation across windows', async () => {
    vi.useFakeTimers();
    const { remote } = pair();
    await remote.sendMessage('welcome', '第一条');
    await expect(
      remote.sendMessage('welcome', '重复发送'),
    ).rejects.toMatchObject({ code: 'BUSY' });
    vi.runAllTimers();
  });

  it('carries domain errors back with their code and details', async () => {
    const { remote } = pair();
    const context = {
      requestId: 'r1',
      workspaceId: 'personal',
      source: 'ui' as const,
    };
    const note = await remote.notesCreate(context, {
      title: '冲突用例',
      body: '',
      idempotencyKey: 'k1',
    });
    await expect(
      remote.notesUpdate(context, {
        id: note.id,
        expectedVersion: 1,
        patch: { body: 'x' },
        idempotencyKey: 'k2',
      }),
    ).resolves.toMatchObject({ version: 2 });
    await expect(
      remote.notesUpdate(context, {
        id: note.id,
        expectedVersion: 1,
        patch: { body: 'y' },
        idempotencyKey: 'k3',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { currentVersion: 2 },
    });
  });

  it('drops stale snapshots and malformed envelopes', async () => {
    const { client, transport, remote } = pair();
    const fresh = client.getSnapshot();
    transport.host.send(HOST_SNAPSHOT, {
      revision: 9,
      snapshot: { ...fresh, conversations: [] },
    });
    expect(remote.getSnapshot().conversations).toHaveLength(0);
    // An older revision must not overwrite what the window already shows.
    transport.host.send(HOST_SNAPSHOT, {
      revision: 8,
      snapshot: { ...fresh, conversations: fresh.conversations },
    });
    expect(remote.getSnapshot().conversations).toHaveLength(0);
    transport.host.send(HOST_SNAPSHOT, { revision: 'ten' });
    transport.host.send(HOST_SNAPSHOT, null);
    expect(remote.getSnapshot().conversations).toHaveLength(0);
  });

  it('ignores commands that are not on the whitelist', async () => {
    const { client, transport } = pair();
    const replies = vi.fn();
    transport.window.listen(HOST_RESULT, replies);
    transport.window.send(HOST_COMMAND, {
      requestId: 'r9',
      name: 'disposeEverything',
      args: [],
    });
    transport.window.send(HOST_COMMAND, {
      requestId: 'r10',
      name: 'sendMessage',
      args: 'not-an-array',
    });
    await Promise.resolve();
    expect(replies).not.toHaveBeenCalled();
    // The authoritative client is untouched.
    expect(client.getSnapshot().conversations).toHaveLength(1);
    expect(client.getSnapshot().runs).toHaveLength(0);
  });

  it('reports the host as unavailable once requests stop being answered', async () => {
    vi.useFakeTimers();
    const { authority, remote } = pair();
    const window = proxy!;
    authority.dispose();
    expect(window.state()).toBe('ready');
    const pending = remote.sendMessage('welcome', '无人应答');
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(9000);
    await assertion;
    expect(window.state()).toBe('unavailable');
  });
});
