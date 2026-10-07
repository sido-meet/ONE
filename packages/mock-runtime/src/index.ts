import { ClientError } from '../../contracts/src/index.ts';
import { createMemoryProviders } from './domain.ts';
import { parseSchedule } from './schedule.ts';
import type { ScheduleAttempt } from './schedule.ts';
import type {
  AgentId,
  CalendarDraft,
  Conversation,
  ConversationRuntime,
  DurableEvent,
  Message,
  Proposal,
  ProposalResolution,
  Run,
  Snapshot,
} from '../../contracts/src/index.ts';

export { createMemoryProviders } from './domain.ts';
export type { MemoryProviders } from './domain.ts';
export { parseSchedule, DEFAULT_DURATION_MINUTES } from './schedule.ts';
export type { ScheduleAttempt } from './schedule.ts';

export const agents: { id: AgentId; name: string }[] = [
  { id: 'chat', name: 'Chat Agent' },
  { id: 'claude-code', name: 'Claude Code' },
  { id: 'mcode', name: 'MCode' },
];
type EventInput =
  | { type: 'message.created'; message: Message }
  | { type: 'agent.changed'; agentId: AgentId }
  | { type: 'run.started'; run: Run }
  | { type: 'run.finished'; run: Run }
  | { type: 'proposal.created'; proposal: Proposal }
  | { type: 'proposal.settled'; resolution: ProposalResolution };

export function createMockClient(
  options: { tickMs?: number } = {},
): ConversationRuntime {
  const state: Snapshot = {
    workspaces: [{ id: 'personal', name: '个人空间' }],
    conversations: [
      {
        id: 'welcome',
        workspaceId: 'personal',
        title: '从这里开始 ONE',
        agentId: 'chat',
        createdAt: new Date().toISOString(),
      },
    ],
    events: [],
    runs: [],
    drafts: {},
    proposals: [],
  };
  const listeners = new Set<() => void>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  /** 每次 Run 的日程起草结果，跑完时用来落提议。认不出来就不落。 */
  const schedules = new Map<string, ScheduleAttempt>();
  let disposed = false;
  const assertOpen = () => {
    if (disposed) throw new ClientError('DISPOSED', '会话服务已关闭');
  };
  const notify = () => listeners.forEach((listener) => listener());
  const findConversation = (id: string) => {
    assertOpen();
    const conversation = state.conversations.find((item) => item.id === id);
    if (!conversation) throw new ClientError('NOT_FOUND', '找不到这个对话');
    return conversation;
  };
  const append = (conversationId: string, payload: EventInput) => {
    const seq =
      state.events.filter((event) => event.conversationId === conversationId)
        .length + 1;
    state.events.push({
      ...structuredClone(payload),
      id: crypto.randomUUID(),
      conversationId,
      seq,
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    } as DurableEvent);
  };
  const finish = (run: Run, status: 'completed' | 'cancelled') => {
    clearInterval(timers.get(run.id));
    timers.delete(run.id);
    const draft = state.drafts[run.id];
    const schedule = schedules.get(run.id);
    schedules.delete(run.id);
    if (draft) {
      const message: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        agentId: run.agentId,
        content: draft,
      };
      append(run.conversationId, { type: 'message.created', message });
      // 提议挂在**跑完**的那条回复下面。被取消的回复不提议：用户按了停止，
      // 他要的是停下来，而不是一份他没看完就替他起草好的日程。
      if (status === 'completed' && schedule?.ok)
        draftProposal(run.conversationId, message.id, schedule.draft);
    }
    delete state.drafts[run.id];
    run.status = status;
    append(run.conversationId, { type: 'run.finished', run });
    notify();
  };

  /**
   * 落一条待确认的日程提议（ADR-022）。
   *
   * 草稿要活到用户点确认为止，所以它是**持久的**事件而不是回复流的一部分：
   * 关掉窗口再回来、换到主窗口看，它都还在原地。
   */
  const draftProposal = (
    conversationId: string,
    messageId: string,
    draftValue: Proposal['draft'] & object,
  ) => {
    const conversation = state.conversations.find(
      (item) => item.id === conversationId,
    );
    const proposal: Proposal = {
      id: crypto.randomUUID(),
      domain: 'calendar',
      status: 'pending',
      messageId,
      workspaceId: conversation?.workspaceId ?? 'personal',
      sourceConversationId: conversationId,
      createdAt: new Date().toISOString(),
      draft: draftValue as CalendarDraft,
    };
    state.proposals.push(proposal);
    append(conversationId, { type: 'proposal.created', proposal });
  };
  return {
    getSnapshot: () => structuredClone(state),
    subscribe(listener) {
      assertOpen();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async createConversation(title = '新的对话') {
      assertOpen();
      const conversation: Conversation = {
        id: crypto.randomUUID(),
        workspaceId: 'personal',
        title: title.trim() || '新的对话',
        agentId: 'chat',
        createdAt: new Date().toISOString(),
      };
      state.conversations.push(conversation);
      notify();
      return structuredClone(conversation);
    },
    async changeAgent(conversationId, agentId) {
      const conversation = findConversation(conversationId);
      if (!agents.some((agent) => agent.id === agentId))
        throw new ClientError('VALIDATION', '未知 Agent');
      if (
        state.runs.some(
          (run) =>
            run.conversationId === conversationId && run.status === 'running',
        )
      )
        throw new ClientError('BUSY', '请先停止当前回复，再切换 Agent');
      if (conversation.agentId === agentId) return;
      conversation.agentId = agentId;
      append(conversationId, { type: 'agent.changed', agentId });
      notify();
    },
    async sendMessage(conversationId, text) {
      const conversation = findConversation(conversationId);
      const input = text.trim();
      if (!input || input.length > 8000)
        throw new ClientError('VALIDATION', '请输入 1–8000 字的消息');
      if (
        state.runs.some(
          (run) =>
            run.conversationId === conversationId && run.status === 'running',
        )
      )
        throw new ClientError('BUSY', '当前对话正在回复');
      const run: Run = {
        id: crypto.randomUUID(),
        conversationId,
        agentId: conversation.agentId,
        status: 'running',
      };
      append(conversationId, {
        type: 'message.created',
        message: { id: crypto.randomUUID(), role: 'user', content: input },
      });
      state.runs.push(run);
      append(conversationId, { type: 'run.started', run });
      state.drafts[run.id] = '';
      // 解析**用户的输入**，不是自己刚编出来的回复。回复里会复述原话（「你说：
      // 明天下午三点…」），拿去解析会抽出一份标题是半句客套话的日程草稿。
      const schedule = parseSchedule(input, new Date());
      schedules.set(run.id, schedule);
      const name = agents.find((agent) => agent.id === run.agentId)?.name;
      const reply = schedule.ok
        ? `我按“${input}”起草了一条日程，确认后才会写进日历。`
        : `这是 ${name} 的模拟回复。你说：“${input}”。\n\n这段历史保存在同一个 ONE 对话里。回复结束后，你可以切换 Agent 继续体验。真实 AI 与笔记保存将在后续阶段接入。`;
      const chars = Array.from(reply);
      let position = 0;
      timers.set(
        run.id,
        setInterval(() => {
          state.drafts[run.id] += chars.slice(position, position + 3).join('');
          position += 3;
          if (position >= chars.length) finish(run, 'completed');
          else notify();
        }, options.tickMs ?? 28),
      );
      notify();
      return structuredClone(run);
    },
    async cancelRun(runId) {
      assertOpen();
      const run = state.runs.find((item) => item.id === runId);
      if (!run) throw new ClientError('NOT_FOUND', '找不到这次运行');
      if (run.status === 'running') finish(run, 'cancelled');
    },
    /**
     * 本体把处理结果写回会话。运行时**自己不碰领域能力** —— 真正写进日历的
     * 永远是本体（ADR-016/022）；这一层只负责「这条提议现在什么状态」。
     *
     * 幂等归本体管：它先看状态再决定要不要写。这里是最后一道闸，防止有第二个
     * 写者绕过那道判断。
     */
    async settleProposal(proposalId, resolution) {
      assertOpen();
      const proposal = state.proposals.find((item) => item.id === proposalId);
      if (!proposal)
        throw new ClientError('NOT_FOUND', '找不到这条提议', { proposalId });
      if (proposal.status !== 'pending')
        throw new ClientError('CONFLICT', '这条提议已经处理过了', {
          proposalId,
          status: proposal.status,
        });
      const at = resolution.at || new Date().toISOString();
      const settled: Proposal =
        resolution.status === 'created'
          ? {
              ...proposal,
              status: 'created',
              created: { entityId: resolution.entityId ?? '', at },
            }
          : {
              ...proposal,
              status: 'rejected',
              // 拒绝理由必须留着。用户问「为什么它没进去」时要答得上来。
              rejected: { reason: resolution.reason ?? '', at },
            };
      state.proposals[state.proposals.indexOf(proposal)] = settled;
      append(settled.sourceConversationId, {
        type: 'proposal.settled',
        resolution: { ...resolution, at },
      });
      notify();
      return structuredClone(settled);
    },
    dispose() {
      timers.forEach(clearInterval);
      timers.clear();
      schedules.clear();
      listeners.clear();
      disposed = true;
    },
  };
}
