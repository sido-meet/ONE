export * from './errors.ts';
export * from './domain.ts';
export * from './localtime.ts';
export * from './provider.ts';
export * from './proposal.ts';
export * from './page.ts';
export * from './backup.ts';
export * from './wire.ts';

import type {
  Proposal,
  ProposalDomain,
  ProposalResolution,
} from './proposal.ts';

/** ONE-owned identities; external agent sessions are never conversation IDs. */
export type AgentId = 'chat' | 'claude-code' | 'mcode';
/**
 * `interrupted` 不是失败，是**没人接的手**（ADR-028）。
 *
 * 本体崩在回复生成到一半时，重启后这次 Run 既不能说 `running`（界面会永远转圈），
 * 也不能说 `completed`（那是谎称生成成功了）。用户没要求重跑，所以也不悄悄重跑 ——
 * 那会产生一条他没见过的回复。
 */
export type RunStatus =
  'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
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
  /**
   * 存储被**整体改写**之后重新读一遍（ADR-029 导入备份、ADR-028 彻底删除对话）。
   *
   * 不这么做的话，界面会继续显示一份库里已经不存在的东西，而用户以为没生效 ——
   * 「状态只有一份」这条规矩会在这时候破掉。
   */
  rebind(): void;
  dispose(): void;
}

/**
 * Agent 端口：**只回答「说什么」，不持有任何状态**（ADR-028）。
 *
 * 这是这轮最要紧的一条边界。对话、事件、Run、提议全归本体；Agent 拿到的是
 * 「这句话 + 上一条回复」，交回来的是「这段话 + 顺带起草的提议」。
 *
 * 没有这条边界时，「模拟回复」和「会话状态机」是同一个东西，于是换个真实模型
 * 就等于把会话历史一起换掉 —— 而对话是 ONE 自己的数据。
 *
 * `draft` 是可选的：交回来就落一条待确认的提议（ADR-022），不交就只是回一句话。
 */
export interface ReplyAgent {
  readonly id: AgentId;
  readonly name: string;
  reply(input: {
    text: string;
    /** 上一条 assistant 回复。笔记的「把刚才那段记下来」要靠它。 */
    lastReply: string | undefined;
  }): Promise<{
    content: string;
    draft?: { domain: ProposalDomain; draft: Proposal['draft'] };
  }>;
}

/**
 * 会话存储端口。**事件是唯一真相；对话、Run、提议都是投影**（ADR-028）。
 *
 * 「投影」不是修辞，它是有约束的：
 * - 运行时**只**追加事件，不另存一份 Run 或提议的权威状态 —— 两份真相必然漂移；
 * - `appendBatch` 分配的 `seq` **不重复也不跳号**，`(conversationId, seq)` 上有唯一
 *   约束；「重连快照无缺失无重复」的根据就在这条约束上；
 * - 一批事件**同事务**写入：一次 Run 的「开始」与「结束」要么都在，要么都不在。
 *
 * 两份实现（内存与 SQLite）跑**同一组契约测试** —— 换掉存储不等于换掉状态机。
 */
export interface ConversationStore {
  /** 开库时调用一次：把库里已有的状态读出来。 */
  open(): ConversationState;
  /**
   * 一批事件同事务写入，按数组顺序分配 `seq`。
   *
   * 要「开始」和「结束」成对时传两个 payload，不要分两次调用 —— 那两次之间崩了，
   * 库里就留下一条永远不结束的 Run。
   */
  appendBatch(
    conversationId: string,
    payloads: DurablePayloadInput[],
  ): DurableEvent[];
  createConversation(conversation: Conversation): void;
  /**
   * 改对话的 Agent，**与那条 `agent.changed` 事件同事务** —— 分开写就会出现「说换了但没换」。
   */
  setConversationAgent(
    conversationId: string,
    agentId: AgentId,
    payload: DurablePayloadInput,
  ): DurableEvent;
  /**
   * 整库改写。**只有导入备份会走它**，而且必须**一个事务**。
   *
   * 导入不是「追加」——一个半截的导入比不导入更糟：用户看着日历回来了，日程没了，
   * 而没有任何地方告诉他这件事。所以要么全换成包里的样子，要么一点都不动。
   */
  replaceAll(state: ConversationState): void;
  /**
   * 彻底删掉一段对话：**物理删除**它的事件与行，不留残迹。
   *
   * 契约写着「追加历史不意味着永久不能删除私人数据」，所以这里是真删。删掉的对话
   * 返回 `false`，让界面能说「找不到」而不是假装删过。
   */
  forgetConversation(conversationId: string): boolean;
  close(): void;
}

/** 存储里读出来的原始状态。运行时据此投影出 Snapshot 的其余部分。 */
export interface ConversationState {
  workspaces: Workspace[];
  conversations: Conversation[];
  events: DurableEvent[];
}

/** `appendBatch` 收得到的事件载荷（还不带 id/seq/时间戳，那些由存储分配）。 */
export type DurablePayloadInput =
  | { type: 'message.created'; message: Message }
  | { type: 'agent.changed'; agentId: AgentId }
  | { type: 'run.started'; run: Run }
  | { type: 'run.finished'; run: Run }
  | { type: 'proposal.created'; proposal: Proposal }
  | { type: 'proposal.settled'; resolution: ProposalResolution };

/** Agent 起草的东西，落成提议时用。 */
export interface ProposalDraft {
  domain: ProposalDomain;
  draft: Proposal['draft'];
}
