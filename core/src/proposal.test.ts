import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMemoryProviders,
  createMockClient,
} from '../../packages/mock-runtime/src/index.ts';
import type { MemoryProviders } from '../../packages/mock-runtime/src/index.ts';
import { createCore } from './core.ts';
import type { Core, DomainPorts } from './core.ts';
import { WIRE_VERSION } from '../../packages/contracts/src/wire.ts';
import type {
  ClientMessage,
  CoreMessage,
  Proposal,
} from '../../packages/contracts/src/index.ts';

/**
 * 提议确认这条路的行为（ADR-022），不是 `proposalResolve` 的复述。
 *
 * 每条用例都真的起一个本体、真的连上一个日历提供方，因此换掉传输层或换掉提供方
 * 实现之后这些断言依然成立。「重复确认只建一次」是这里唯一真正要守住的东西 ——
 * 用户点错了按钮不该多出一条日程。
 */

const hello = (provider: string): ClientMessage => ({
  t: 'hello',
  v: WIRE_VERSION,
  client: { role: provider, provider, label: provider, capabilities: [] },
});

let runtime: ReturnType<typeof createMockClient>;
let providers: MemoryProviders;
let core: Core;
let session: ReturnType<Core['connect']>;
let sent: CoreMessage[];
let seq = 0;

/** 真的日历与笔记提供方。它们各自有自己的幂等回执表，重复写入会被它们挡下。 */
const withProviders = (p: MemoryProviders): DomainPorts => ({
  calendar: () => ({
    id: 'local.calendar',
    kind: 'calendar',
    status: 'ready',
    provider: p.calendar,
  }),
  notes: () => ({
    id: 'local.notes',
    kind: 'notes',
    status: 'ready',
    provider: p.notes,
  }),
});

beforeEach(() => {
  vi.useFakeTimers();
  seq = 0;
  sent = [];
  runtime = createMockClient({ tickMs: 1 });
  providers = createMemoryProviders();
  core = createCore(runtime, {
    version: 'test',
    installed: ['pet'],
    domains: withProviders(providers),
  });
  session = core.connect(
    {
      send: (message: CoreMessage) => sent.push(message),
      close: () => undefined,
    },
    hello('pet'),
  );
  if (!session) throw new Error('握手失败');
});

/** 收窄一次：握手可能失败，失败就不该继续跑后面的用例。 */
const live = (): NonNullable<typeof session> => {
  if (!session) throw new Error('还没接上本体');
  return session;
};

/** 走真实的命令帧进去，真实地等回执 —— 参数校验也在这条路上。 */
async function call(cmd: string, args: unknown[]): Promise<unknown> {
  const id = `r${++seq}`;
  core.handleMessage(live(), { t: 'call', id, cmd, args } as never);
  await vi.advanceTimersByTimeAsync(1);
  const reply = sent.find(
    (item): item is Extract<CoreMessage, { t: 'result' }> =>
      item.t === 'result' && item.id === id,
  );
  if (!reply) throw new Error(`${cmd} 没有回执`);
  if (!reply.ok)
    throw Object.assign(new Error(reply.error.message), reply.error);
  return reply.value;
}

async function draft(text: string): Promise<Proposal | undefined> {
  await call('sendMessage', ['welcome', text]);
  await vi.advanceTimersByTimeAsync(5000);
  return runtime.getSnapshot().proposals.at(-1);
}

const events = () => providers.read().calendarEvents;

describe('提议确认（ADR-022）', () => {
  it('笔记提议写进笔记，绝不落进日历', async () => {
    const proposal = await draft('记一下：客户要求下周给报价');
    expect(proposal?.domain).toBe('notes');

    const answer = await call('proposalResolve', [
      { proposalId: proposal?.id, decision: 'confirm' },
    ]);
    expect(answer).toMatchObject({ status: 'created', applied: true });

    // 写成「一律走日历」的话，这里会多出一条标题为空的日程，而用户看到的是成功。
    expect(events()).toHaveLength(0);
    const notes = providers.read().notes;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      title: '客户要求下周给报价',
      sourceConversationId: 'welcome',
    });
  });

  it('「把刚才那段记下来」记的是上一条回复，不是这一条', async () => {
    await draft('今天先聊到这儿');
    const proposal = await draft('把刚才那段记下来');
    expect(proposal?.domain).toBe('notes');
    if (proposal?.domain !== 'notes') throw new Error('应当是笔记提议');
    // 说的是「刚才那段」：用户看到的上一条回复，不是刚跑完的确认回复。
    expect(proposal.draft.body).not.toContain('起草了一条笔记');
    expect(proposal.draft.body.length).toBeGreaterThan(0);
  });

  it('说得出日程时才起草一条待确认的提议', async () => {
    const proposal = await draft('明天下午三点安排面试');
    expect(proposal).toBeDefined();
    expect(proposal?.status).toBe('pending');
    expect(proposal?.domain).toBe('calendar');
    expect(proposal?.draft).toMatchObject({ title: '面试' });
    // 草稿挂在刚跑完的那条 assistant 消息下面。
    const reply = runtime
      .getSnapshot()
      .events.filter((item) => item.type === 'message.created')
      .at(-1);
    expect(
      reply && reply.type === 'message.created' && reply.message.role,
    ).toBe('assistant');
    expect(proposal?.messageId).toBeTruthy();
    expect(events()).toHaveLength(0);
  });

  it('认不出时间就什么都不做，不凭空造一条日程', async () => {
    expect(await draft('今天天气不错')).toBeUndefined();
    expect(await draft('明天下午三点')).toBeUndefined();
    expect(events()).toHaveLength(0);
  });

  it('被取消的回复不留下提议：用户按了停止，要的是停下来', async () => {
    await call('sendMessage', ['welcome', '明天下午三点安排面试']);
    await call('cancelRun', [runtime.getSnapshot().runs.at(-1)?.id ?? '']);
    expect(runtime.getSnapshot().proposals).toHaveLength(0);
  });

  it('拒绝之后数据一个字节都没变，理由留着给用户看', async () => {
    const proposal = await draft('明天下午三点安排面试');
    const answer = await call('proposalResolve', [
      { proposalId: proposal?.id, decision: 'reject', reason: '那天我在外地' },
    ]);
    expect(answer).toMatchObject({
      status: 'rejected',
      applied: true,
      reason: '那天我在外地',
    });
    expect(events()).toHaveLength(0);
    expect(runtime.getSnapshot().proposals.at(-1)?.rejected?.reason).toBe(
      '那天我在外地',
    );
  });

  it('拒绝必须写明原因，不能默默消失', async () => {
    const proposal = await draft('明天下午三点安排面试');
    await expect(
      call('proposalResolve', [
        { proposalId: proposal?.id, decision: 'reject' },
      ]),
    ).rejects.toThrow(/原因/);
    expect(runtime.getSnapshot().proposals.at(-1)?.status).toBe('pending');
  });

  it('不存在的提议报 NOT_FOUND，不凭空造一条', async () => {
    await expect(
      call('proposalResolve', [
        { proposalId: '根本没这条', decision: 'confirm' },
      ]),
    ).rejects.toThrow(/找不到/);
  });

  it('确认之后日程真的落库，来源对话也带上了', async () => {
    const proposal = await draft('明天下午三点安排面试');
    const answer = await call('proposalResolve', [
      { proposalId: proposal?.id, decision: 'confirm' },
    ]);
    expect(answer).toMatchObject({ status: 'created', applied: true });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      title: '面试',
      sourceConversationId: 'welcome',
      // 工作区取自提议自己，不是客户端上报的值。
      workspaceId: proposal?.workspaceId,
    });
  });

  it('重复确认只建一次，第二次如实说没有再写', async () => {
    const proposal = await draft('明天下午三点安排面试');
    const first = await call('proposalResolve', [
      { proposalId: proposal?.id, decision: 'confirm' },
    ]);
    const second = await call('proposalResolve', [
      { proposalId: proposal?.id, decision: 'confirm' },
    ]);
    expect(first).toMatchObject({ applied: true, status: 'created' });
    // 第二次不能又报一次成功 —— 用户要看见「已经建过了」。
    expect(second).toMatchObject({ applied: false, status: 'created' });
    expect(second && (second as { entityId?: string }).entityId).toBe(
      first && (first as { entityId?: string }).entityId,
    );
    expect(events()).toHaveLength(1);
  });

  it('拒绝之后再点确认不会偷偷复活这条提议', async () => {
    const proposal = await draft('明天下午三点安排面试');
    await call('proposalResolve', [
      { proposalId: proposal?.id, decision: 'reject', reason: '改主意了' },
    ]);
    const again = await call('proposalResolve', [
      { proposalId: proposal?.id, decision: 'confirm' },
    ]);
    expect(again).toMatchObject({ applied: false, status: 'rejected' });
    expect(events()).toHaveLength(0);
  });

  it('提供方没接上时，确認报的是四类不可用之一，不是「确认成功」', async () => {
    const proposal = await draft('明天下午三点安排面试');
    const bare = createCore(runtime, { version: 'test', installed: ['pet'] });
    const bareSent: CoreMessage[] = [];
    const bareSession = bare.connect(
      { send: (m: CoreMessage) => bareSent.push(m), close: () => undefined },
      hello('pet'),
    );
    if (!bareSession) throw new Error('握手失败');
    bare.handleMessage(bareSession, {
      t: 'call',
      id: 'x1',
      cmd: 'proposalResolve',
      args: [{ proposalId: proposal?.id, decision: 'confirm' }],
    } as never);
    await vi.advanceTimersByTimeAsync(1);
    const reply = bareSent.find(
      (item): item is Extract<CoreMessage, { t: 'result' }> =>
        item.t === 'result' && item.id === 'x1',
    );
    expect(reply?.ok).toBe(false);
    if (reply?.ok === false) {
      expect(reply.error.code).toBe('UNAVAILABLE');
      expect(reply.error.message).toMatch(/日历源/);
    }
    // 没接上就是没接上：提议还挂着，用户等提供方起来之后还能再点。
    expect(runtime.getSnapshot().proposals.at(-1)?.status).toBe('pending');
  });
});

/**
 * 读回来说过的话。
 *
 * 存在的理由很具体：宠物窗口被别的置顶程序盖住时，那个无边框置顶窗口往往还拿不到
 * 键盘焦点，「ONE 到底回了什么」界面上就看不到。没有这条命令，无头验收只能去猜
 * 界面上那句是不是新的。
 */
describe('命令行读对话（无头验收用）', () => {
  it('读得到用户的话与 ONE 的回话，按顺序', async () => {
    await draft('记一下：客户要求下周给报价');
    const history = (await call('conversationHistory', ['welcome'])) as {
      conversation: { id: string };
      messages: { role: string; content: string }[];
    };
    expect(history.conversation.id).toBe('welcome');
    expect(history.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history.messages[0]?.content).toBe('记一下：客户要求下周给报价');
    expect(history.messages[1]?.content).toContain('起草了一条笔记');
  });

  it('「差一句」的话真的会出现在回话里，而不是被通用回复盖掉', async () => {
    await draft('记一下');
    const history = (await call('conversationHistory', ['welcome'])) as {
      messages: { role: string; content: string }[];
    };
    const last = history.messages.at(-1)?.content ?? '';
    expect(last).toContain('没说要记什么');
    expect(last).not.toContain('模拟回复');
  });

  it('读别的对话就是读不到，不返回一份空的历史', async () => {
    const id = 'x1';
    core.handleMessage(live(), {
      t: 'call',
      id,
      cmd: 'conversationHistory',
      args: ['没有这个对话'],
    } as never);
    await vi.advanceTimersByTimeAsync(1);
    const reply = sent.find(
      (item): item is Extract<CoreMessage, { t: 'result' }> =>
        item.t === 'result' && item.id === id,
    );
    expect(reply?.ok).toBe(false);
    if (reply?.ok === false) expect(reply.error.code).toBe('NOT_FOUND');
  });
});
