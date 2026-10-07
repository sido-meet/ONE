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

/** 真的日历提供方。它有自己的幂等回执表，重复写入会被它挡下。 */
const withCalendar = (p: MemoryProviders): DomainPorts => ({
  calendar: () => ({
    id: 'local.calendar',
    kind: 'calendar',
    status: 'ready',
    provider: p.calendar,
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
    domains: withCalendar(providers),
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
