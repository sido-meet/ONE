import { ClientError } from '../../packages/contracts/src';
import type {
  AgentId,
  CommandContext,
  OneClient,
  Snapshot,
} from '../../packages/contracts/src';
import {
  HOST_HELLO,
  HOST_RESULT,
  HOST_SNAPSHOT,
  parseResultEnvelope,
  parseSnapshotEnvelope,
  REQUEST_TIMEOUT_MS,
} from './protocol';
import type { CommandName } from './protocol';
import type { Transport } from './transport';

export type ServiceState = 'connecting' | 'ready' | 'unavailable';

/** Empty until the host answers; the UI shows a loading state, never fake data. */
const EMPTY_SNAPSHOT: Snapshot = {
  workspaces: [],
  conversations: [],
  events: [],
  runs: [],
  drafts: {},
  notes: [],
  calendarEvents: [],
};

/**
 * Pet and bubble windows hold no state of their own. Every call becomes a
 * request to the authoritative host, and the last accepted snapshot is the
 * only thing they render. Stale revisions are dropped.
 */
export interface ProxyClient {
  client: OneClient;
  state(): ServiceState;
  dispose(): void;
}

export function createProxyClient(transport: Transport): ProxyClient {
  let revision = -1;
  let snapshot: Snapshot = EMPTY_SNAPSHOT;
  let state: ServiceState = 'connecting';
  const listeners = new Set<() => void>();
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (cause: unknown) => void }
  >();

  const settle = () => {
    listeners.forEach((listener) => listener());
  };
  const markUnavailable = () => {
    if (state !== 'unavailable') {
      state = 'unavailable';
      settle();
    }
  };

  const stopSnapshot = transport.listen(HOST_SNAPSHOT, (payload) => {
    const envelope = parseSnapshotEnvelope(payload);
    if (!envelope || envelope.revision <= revision) return;
    revision = envelope.revision;
    snapshot = envelope.snapshot;
    state = 'ready';
    settle();
  });

  const stopResult = transport.listen(HOST_RESULT, (payload) => {
    const envelope = parseResultEnvelope(payload);
    if (!envelope) return;
    const entry = pending.get(envelope.requestId);
    if (!entry) return;
    pending.delete(envelope.requestId);
    if (envelope.ok && envelope.error === undefined)
      entry.resolve(envelope.value);
    else if (envelope.error)
      entry.reject(
        new ClientError(
          envelope.error.code,
          envelope.error.message,
          envelope.error.details,
        ),
      );
    else markUnavailable();
  });

  const request = <T>(name: CommandName, args: unknown[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        markUnavailable();
        reject(
          new ClientError('TIMEOUT', '原型服务没有响应，请重新打开主窗口'),
        );
      }, REQUEST_TIMEOUT_MS);
      pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (cause) => {
          clearTimeout(timer);
          reject(cause);
        },
      });
      transport.send('one:command', { requestId, name, args });
    });

  // Ask for the current snapshot immediately; the host answers with a broadcast.
  transport.send(HOST_HELLO, {});

  const dispose = () => {
    stopSnapshot();
    stopResult();
    pending.forEach((entry) =>
      entry.reject(new ClientError('DISPOSED', '窗口已关闭')),
    );
    pending.clear();
    listeners.clear();
  };

  return {
    client: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      createConversation: (title) => request('createConversation', [title]),
      changeAgent: (conversationId: string, agentId: AgentId) =>
        request('changeAgent', [conversationId, agentId]),
      sendMessage: (conversationId: string, text: string) =>
        request('sendMessage', [conversationId, text]),
      cancelRun: (runId: string) => request('cancelRun', [runId]),
      calendarList: (context: CommandContext, input: unknown) =>
        request('calendarList', [context, input]),
      calendarCreate: (context: CommandContext, input: unknown) =>
        request('calendarCreate', [context, input]),
      calendarUpdate: (context: CommandContext, input: unknown) =>
        request('calendarUpdate', [context, input]),
      calendarDelete: (context: CommandContext, input: unknown) =>
        request('calendarDelete', [context, input]),
      notesList: (context: CommandContext, input: unknown) =>
        request('notesList', [context, input]),
      notesCreate: (context: CommandContext, input: unknown) =>
        request('notesCreate', [context, input]),
      notesUpdate: (context: CommandContext, input: unknown) =>
        request('notesUpdate', [context, input]),
      notesDelete: (context: CommandContext, input: unknown) =>
        request('notesDelete', [context, input]),
      dispose,
    },
    state: () => state,
    dispose,
  };
}
