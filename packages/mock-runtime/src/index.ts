import { ClientError } from '../../contracts/src/index.ts';
import { createMemoryProviders } from './domain.ts';
import { parseSchedule } from './schedule.ts';
import { parseNote } from './note.ts';
import type { ScheduleAttempt } from './schedule.ts';
import type {
  AgentId,
  CalendarDraft,
  Conversation,
  ConversationRuntime,
  DurableEvent,
  Message,
  NoteDraft,
  Proposal,
  ProposalDomain,
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

/**
 * 一句话的结果有三种，不是一件事加一个「没有」。
 *
 * - `draft`：起草成功，落一条提议。
 * - `incomplete`：**看起来确实是在记录，只差一个信息**。这句话必须原样说给
 *   用户听 ——「记一下」后面忘了跟内容，用户补一句就成了，告诉他「没听出要记
 *   什么」只会让他重打一遍。
 * - `chitchat`：就是闲聊。不解释、不提示、不起草。用户问「今天天气不错」，
 *   回一句「没听出要记什么」听着像系统在挑刺。
 *
 * `incomplete` 这一支曾经不存在：两个解析器都精心写了「能直接说给用户听的一句
 * 话」，`draftOf` 却只返回成功与否，那句话被整个丢掉 —— 用户永远不知道自己差
 * 哪一句，只能一次次试。
 *
 * 顺序是**日程先、笔记后**。「明天下午三点安排面试」里没有「记一下」，反过来
 * 「记一下：明天三点面试」里也没有日期词，两者不会同时命中；真要撞上了，日程
 * 优先 —— 把一条说好的会议记成笔记，代价比反过来大。
 */
type DraftOutcome =
  | { kind: 'draft'; domain: ProposalDomain; draft: Proposal['draft'] }
  | { kind: 'incomplete'; hint: string }
  | { kind: 'chitchat' };

function draftOf(input: string, lastReply?: string): DraftOutcome {
  const schedule = parseSchedule(input, new Date());
  if (schedule.ok)
    return { kind: 'draft', domain: 'calendar', draft: schedule.draft };
  const note = parseNote(input, lastReply);
  if (note.ok) return { kind: 'draft', domain: 'notes', draft: note.draft };
  // 两个域都说「差一点」才给提示。日程优先，所以它的话也是先说的。
  if (schedule.near) return { kind: 'incomplete', hint: schedule.reason };
  if (note.near) return { kind: 'incomplete', hint: note.reason };
  return { kind: 'chitchat' };
}

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
  /** 每次 Run 起稿时的解析结果，跑完时用来落提议。只有起草成功才落。 */
  const attempts = new Map<
    string,
    { domain: ProposalDomain; draft: Proposal['draft'] }
  >();
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
    // 先记下回复出现**之前**的那条 assistant 内容：日记说的「刚才那段」指的是
    // 用户说话之前看到的那一句，不包括这一条正在结束的回复。
    const previousReply = lastAssistantReply(run.conversationId);
    const attempt = attempts.get(run.id);
    attempts.delete(run.id);
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
      if (status === 'completed' && attempt) {
        draftProposal(
          run.conversationId,
          message.id,
          attempt.domain,
          attempt.draft,
        );
      }
    }
    delete state.drafts[run.id];
    run.status = status;
    append(run.conversationId, { type: 'run.finished', run });
    notify();
  };

  /**
   * 落一条待确认的提议（ADR-022）。
   *
   * 草稿要活到用户点确认为止，所以它是**持久的**事件而不是回复流的一部分：
   * 关掉窗口再回来、换到主窗口看，它都还在原地。
   */
  const draftProposal = (
    conversationId: string,
    messageId: string,
    domain: ProposalDomain,
    draftValue: Proposal['draft'],
  ) => {
    const conversation = state.conversations.find(
      (item) => item.id === conversationId,
    );
    const base = {
      id: crypto.randomUUID(),
      status: 'pending' as const,
      messageId,
      workspaceId: conversation?.workspaceId ?? 'personal',
      sourceConversationId: conversationId,
      createdAt: new Date().toISOString(),
    };
    // 判别联合在这里合拢：domain 与 draft 在类型上是绑着的，
    // 拼错的话这一行就通不过，而不是等本体边界才发现。
    const proposal: Proposal =
      domain === 'calendar'
        ? { ...base, domain, draft: draftValue as CalendarDraft }
        : { ...base, domain, draft: draftValue as NoteDraft };
    state.proposals.push(proposal);
    append(conversationId, { type: 'proposal.created', proposal });
  };

  /** 上一条 assistant 回复的正文。笔记的「把刚才那段记下来」要靠它。 */
  const lastAssistantReply = (conversationId: string): string | undefined => {
    for (const event of [...state.events].reverse())
      if (
        event.type === 'message.created' &&
        event.conversationId === conversationId &&
        event.message.role === 'assistant'
      )
        return event.message.content;
    return undefined;
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
      const attempt = draftOf(input, lastAssistantReply(conversationId));
      if (attempt.kind === 'draft')
        attempts.set(run.id, { domain: attempt.domain, draft: attempt.draft });
      const name = agents.find((agent) => agent.id === run.agentId)?.name;
      const reply =
        attempt.kind === 'draft'
          ? `我按“${input}”起草了一条${attempt.domain === 'calendar' ? '日程' : '笔记'}，确认后才会写进去。`
          : // 差一句就说差哪一句，别拿模拟回复把话头岔开。
            attempt.kind === 'incomplete'
            ? attempt.hint
            : `这是 ${name} 的模拟回复。你说：“${input}”。\n\n这段历史保存在同一个 ONE 对话里。回复结束后，你可以切换 Agent 继续体验。真实 AI 将在后续阶段接入。`;
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
      attempts.clear();
      listeners.clear();
      disposed = true;
    },
  };
}
