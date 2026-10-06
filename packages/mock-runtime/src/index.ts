import { ClientError } from '../../contracts/src/index.ts';
import { createMemoryProviders } from './domain.ts';
import type {
  AgentId,
  Conversation,
  ConversationRuntime,
  DurableEvent,
  Message,
  Run,
  Snapshot,
} from '../../contracts/src/index.ts';

export { createMemoryProviders } from './domain.ts';
export type { MemoryProviders } from './domain.ts';

export const agents: { id: AgentId; name: string }[] = [
  { id: 'chat', name: 'Chat Agent' },
  { id: 'claude-code', name: 'Claude Code' },
  { id: 'mcode', name: 'MCode' },
];
type EventInput =
  | { type: 'message.created'; message: Message }
  | { type: 'agent.changed'; agentId: AgentId }
  | { type: 'run.started'; run: Run }
  | { type: 'run.finished'; run: Run };

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
  };
  const listeners = new Set<() => void>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();
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
    if (draft)
      append(run.conversationId, {
        type: 'message.created',
        message: {
          id: crypto.randomUUID(),
          role: 'assistant',
          agentId: run.agentId,
          content: draft,
        },
      });
    delete state.drafts[run.id];
    run.status = status;
    append(run.conversationId, { type: 'run.finished', run });
    notify();
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
      const name = agents.find((agent) => agent.id === run.agentId)?.name;
      const reply = `这是 ${name} 的模拟回复。你说：“${input}”。\n\n这段历史保存在同一个 ONE 对话里。回复结束后，你可以切换 Agent 继续体验。真实 AI、日历写入和笔记保存将在后续阶段接入。`;
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
    dispose() {
      timers.forEach(clearInterval);
      timers.clear();
      listeners.clear();
      disposed = true;
    },
  };
}
