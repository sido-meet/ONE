export * from './errors.ts';
export * from './domain.ts';
export * from './localtime.ts';
export * from './provider.ts';
export * from './proposal.ts';
export * from './page.ts';
export * from './wire.ts';

import type { Proposal, ProposalResolution } from './proposal.ts';

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
  | { type: 'run.finished'; run: Run }
  | { type: 'proposal.created'; proposal: Proposal }
  | { type: 'proposal.settled'; resolution: ProposalResolution };
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
 *
 * `proposals` 也不违反这条：**提议还不是领域数据**，它是一句「打算写什么」。
 * 落库之后本体就把它解决掉（`proposal.settled`），实体仍然只在提供方那里。
 */
export interface Snapshot {
  workspaces: Workspace[];
  conversations: Conversation[];
  events: DurableEvent[];
  runs: Run[];
  drafts: Record<string, string>;
  /** 按创建顺序的待确认与已解决提议，界面据此把卡片挂回对应消息下面。 */
  proposals: Proposal[];
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
  /**
   * 记录一条提议的处理结果（ADR-022）。
   *
   * **写入领域数据的是本体，不是这里** —— ADR-016 说本体是领域能力唯一调用方。
   * 这一层只回答「这条提议现在什么状态」，因此它不需要认识日历或笔记。
   */
  settleProposal(
    proposalId: string,
    resolution: ProposalResolution,
  ): Promise<Proposal>;
  dispose(): void;
}
