import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockClient } from './index';
import type { OneClient } from '../../contracts/src';

let client: OneClient;
afterEach(() => {
  client?.dispose();
  vi.useRealTimers();
});
describe('ONE conversation boundary', () => {
  it('keeps history and ordered durable events when switching agents', async () => {
    vi.useFakeTimers();
    client = createMockClient();
    await client.sendMessage('welcome', '你好');
    vi.runAllTimers();
    await client.changeAgent('welcome', 'claude-code');
    const state = client.getSnapshot();
    expect(state.conversations[0]?.id).toBe('welcome');
    expect(
      state.events.filter((event) => event.type === 'message.created'),
    ).toHaveLength(2);
    expect(state.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(
      state.events.find((event) => event.type === 'run.started'),
    ).toMatchObject({ run: { status: 'running', agentId: 'chat' } });
  });
  it('rejects overlapping sends and switches; cancellation has exactly one terminal event', async () => {
    vi.useFakeTimers();
    client = createMockClient();
    const run = await client.sendMessage('welcome', '测试取消');
    await expect(client.sendMessage('welcome', '重复')).rejects.toMatchObject({
      code: 'BUSY',
    });
    await expect(client.changeAgent('welcome', 'mcode')).rejects.toMatchObject({
      code: 'BUSY',
    });
    vi.advanceTimersByTime(100);
    await client.cancelRun(run.id);
    await client.cancelRun(run.id);
    const before = client.getSnapshot();
    vi.runAllTimers();
    expect(client.getSnapshot()).toEqual(before);
    expect(before.runs[0]?.status).toBe('cancelled');
    expect(
      before.events.filter((event) => event.type === 'run.finished'),
    ).toHaveLength(1);
    expect(before.drafts).toEqual({});
  });
  it('isolates conversations and protects state from callers', async () => {
    vi.useFakeTimers();
    client = createMockClient();
    const other = await client.createConversation('独立对话');
    await client.sendMessage(other.id, '第二个对话');
    vi.runAllTimers();
    const snapshot = client.getSnapshot();
    snapshot.events.length = 0;
    expect(client.getSnapshot().events).toHaveLength(4);
    expect(
      client
        .getSnapshot()
        .events.every((event) => event.conversationId === other.id),
    ).toBe(true);
  });
  it('validates input and notifies only active subscribers', async () => {
    client = createMockClient();
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    await expect(client.sendMessage('welcome', '  ')).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(client.changeAgent('missing', 'chat')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await client.createConversation();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    await client.createConversation();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
