import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRuntime } from './index.ts';
import type { ConversationRuntime } from '../../contracts/src/index.ts';

let client: ConversationRuntime;
afterEach(() => {
  client?.dispose();
  vi.useRealTimers();
});
describe('ONE conversation boundary', () => {
  it('keeps history and ordered durable events when switching agents', async () => {
    vi.useFakeTimers();
    client = createMemoryRuntime();
    await client.sendMessage('welcome', '你好');
    await vi.runAllTimersAsync();
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
    client = createMemoryRuntime();
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
    await vi.runAllTimersAsync();
    expect(client.getSnapshot()).toEqual(before);
    expect(before.runs[0]?.status).toBe('cancelled');
    expect(
      before.events.filter((event) => event.type === 'run.finished'),
    ).toHaveLength(1);
    expect(before.drafts).toEqual({});
  });
  it('isolates conversations and protects state from callers', async () => {
    vi.useFakeTimers();
    client = createMemoryRuntime();
    const other = await client.createConversation('独立对话');
    await client.sendMessage(other.id, '第二个对话');
    await vi.runAllTimersAsync();
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
    client = createMemoryRuntime();
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

/**
 * 一句话的**三种**结果，三种都必须说得清楚（`draftOf` 的返回形状）。
 *
 * 这一组是补的：解析器早就写好了「没听出要记什么。试试…」这种话，`draftOf`
 * 却只把它扔掉、回一句通用模拟回复，用户永远不知道自己差哪一句 —— 于是只能
 * 一遍遍换说法试。
 */
describe('一句话的三种结果', () => {
  const say = async (text: string) => {
    vi.useFakeTimers();
    client = createMemoryRuntime();
    await client.sendMessage('welcome', text);
    await vi.runAllTimersAsync();
    const snapshot = client.getSnapshot();
    const replies = snapshot.events
      .filter((event) => event.type === 'message.created')
      .map(
        (event) =>
          (event as { message: { role: string; content: string } }).message,
      )
      .filter((message) => message.role === 'assistant');
    return {
      reply: replies[replies.length - 1]?.content ?? '',
      proposals: snapshot.proposals,
    };
  };

  it('认得出就起草，回复里说清要确认后才写进去', async () => {
    const { reply, proposals } = await say('记一下：客户要求下周给报价');
    expect(reply).toContain('起草了一条笔记');
    expect(reply).toContain('确认后才会写进去');
    expect(proposals).toHaveLength(1);
  });

  it('差一句就把差在哪一句说出来，而不是岔开话头', async () => {
    const bare = await say('记一下');
    expect(bare.reply).toContain('没说要记什么');
    expect(bare.proposals).toHaveLength(0);

    const anaphoric = await say('把刚才那段记下来');
    expect(anaphoric.reply).toContain('上面还没有');
    expect(anaphoric.proposals).toHaveLength(0);

    // 说了「安排」却没说哪天几点 —— 这句最该讲，用户补个时间就成了。
    const clock = await say('下午三点安排面试');
    expect(clock.reply).toContain('没听出是哪一天');
    expect(clock.proposals).toHaveLength(0);
  });

  it('闲聊不解释、不提示、不起草', async () => {
    // 回一句「没听出要记什么」听着像系统在挑刺：用户压根没打算记东西。
    for (const text of ['今天天气不错', '你记得今天开会吗', '这条不用记了']) {
      const { reply, proposals } = await say(text);
      expect(reply).toContain('模拟回复');
      expect(reply).not.toContain('没听出');
      expect(reply).not.toContain('没说要记什么');
      expect(proposals).toHaveLength(0);
    }
  });

  /**
   * 故障注入（0.1 验收脚本那条「注入模拟超时/断线」）。
   *
   * 钉的是**一次性**：不一次性的话，后面每一次发送都失败，界面上那个「重试」
   * 按钮就永远成功不了 —— 而那正是要验的东西。
   */
  it('注入的故障只作用一次，之后恢复正常', async () => {
    vi.useFakeTimers();
    client = createMemoryRuntime({ tickMs: 1 });
    process.env['ONE_FAULT'] = 'timeout';
    await expect(
      client.sendMessage('welcome', '这句话会失败'),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    // 不产生用户消息：消息提交发生在故障之后，失败的那次不该留下痕迹。
    expect(
      client.getSnapshot().events.filter((e) => e.type === 'message.created'),
    ).toHaveLength(0);

    await client.sendMessage('welcome', '这句应该成功');
    await vi.advanceTimersByTimeAsync(2000);
    expect(
      client.getSnapshot().events.filter((e) => e.type === 'message.created'),
    ).toHaveLength(2);
  });

  it('认不出的故障名当没写，不猜', async () => {
    vi.useFakeTimers();
    client = createMemoryRuntime({ tickMs: 1 });
    process.env['ONE_FAULT'] = '宇宙射线';
    await expect(
      client.sendMessage('welcome', '照常发送'),
    ).resolves.toBeTruthy();
    await vi.advanceTimersByTimeAsync(2000);
  });
});
