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
export interface Snapshot {
  workspaces: Workspace[];
  conversations: Conversation[];
  events: DurableEvent[];
  runs: Run[];
  drafts: Record<string, string>;
}
/** The first vertical slice. Calendar/Notes contracts are planned in docs/04. */
export interface OneClient {
  getSnapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
  createConversation(title?: string): Promise<Conversation>;
  changeAgent(conversationId: string, agentId: AgentId): Promise<void>;
  sendMessage(conversationId: string, text: string): Promise<Run>;
  cancelRun(runId: string): Promise<void>;
  dispose(): void;
}
export type ErrorCode = 'NOT_FOUND' | 'BUSY' | 'VALIDATION' | 'DISPOSED';
export class ClientError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ClientError';
  }
}
