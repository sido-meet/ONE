export * from './errors.ts';
export * from './domain.ts';
export * from './provider.ts';
export * from './wire.ts';

/** ONE-owned identities; external agent sessions are never conversation IDs. */
export type AgentId = 'chat' | 'claude-code' | 'mcode';
export type RunStatus = 'running' | 'completed' | 'cancelled' | 'failed';
export interface Workspace {
  id: string;
  name: string;
  rootUri?: string;
}
export interface Conversation {
  id: string;
  workspaceId: string;
  title: string;
  agentId: AgentId;
  createdAt: string;
}
export interface Run {
  id: string;
  conversationId: string;
  agentId: AgentId;
  status: RunStatus;
}
export interface AgentBinding {
  id: string;
  conversationId: string;
  agentId: AgentId;
  externalSessionId?: string;
  lastProjectedSeq: number;
}
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  agentId?: AgentId;
}
type DurablePayload =
  | { type: 'message.created'; message: Message }
  | { type: 'agent.changed'; agentId: AgentId }
  | { type: 'run.started'; run: Run }
  | { type: 'run.finished'; run: Run };
export type DurableEvent = DurablePayload & {
  id: string;
  schemaVersion: 1;
  conversationId: string;
  seq: number;
  createdAt: string;
};
export interface EphemeralEvent {
  type: 'message.delta';
  conversationId: string;
  runId: string;
  delta: string;
}
/**
 * 会话状态机权威状态。刻意不含 notes / calendarEvents：领域数据归提供方，
 * 挂在会话快照里就意味着每次广播都捎带一次全量日历（ADR-016）。
 */
export interface Snapshot {
  workspaces: Workspace[];
  conversations: Conversation[];
  events: DurableEvent[];
  runs: Run[];
  drafts: Record<string, string>;
}

/**
 * 会话运行时。会话、Agent、Run 全在这里，与领域能力无关 —— 后者走
 * CalendarProvider / NotesProvider 端口（provider.ts）。两者曾是同一个
 * OneClient，于是换一个日历实现就等于把会话状态机一起换掉。
 *
 * 命令输入不再收 `unknown`：调用边界不是这一层，本体已在解析后调进来。
 */
export interface ConversationRuntime {
  getSnapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
  createConversation(title?: string): Promise<Conversation>;
  changeAgent(conversationId: string, agentId: AgentId): Promise<void>;
  sendMessage(conversationId: string, text: string): Promise<Run>;
  cancelRun(runId: string): Promise<void>;
  dispose(): void;
}
