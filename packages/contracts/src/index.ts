import type {
  CalendarEvent,
  CalendarPage,
  CommandContext,
  DeleteResult,
  Note,
  NotePage,
} from './domain.ts';

export * from './errors.ts';
export * from './domain.ts';
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
export interface Snapshot {
  workspaces: Workspace[];
  conversations: Conversation[];
  events: DurableEvent[];
  runs: Run[];
  drafts: Record<string, string>;
  notes: Note[];
  calendarEvents: CalendarEvent[];
}

/**
 * The first vertical slice plus the Calendar/Notes domain commands. Command input
 * stays `unknown` on purpose: TypeScript cannot guard an IPC or MCP boundary, so
 * every implementation validates before touching state.
 */
export interface OneClient {
  getSnapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
  createConversation(title?: string): Promise<Conversation>;
  changeAgent(conversationId: string, agentId: AgentId): Promise<void>;
  sendMessage(conversationId: string, text: string): Promise<Run>;
  cancelRun(runId: string): Promise<void>;
  calendarList(context: CommandContext, input: unknown): Promise<CalendarPage>;
  calendarCreate(
    context: CommandContext,
    input: unknown,
  ): Promise<CalendarEvent>;
  calendarUpdate(
    context: CommandContext,
    input: unknown,
  ): Promise<CalendarEvent>;
  calendarDelete(
    context: CommandContext,
    input: unknown,
  ): Promise<DeleteResult>;
  notesList(context: CommandContext, input: unknown): Promise<NotePage>;
  notesCreate(context: CommandContext, input: unknown): Promise<Note>;
  notesUpdate(context: CommandContext, input: unknown): Promise<Note>;
  notesDelete(context: CommandContext, input: unknown): Promise<DeleteResult>;
  dispose(): void;
}
