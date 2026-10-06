import { ClientError } from '../../packages/contracts/src/index.ts';
import type {
  AgentId,
  CalendarEvent,
  CalendarPage,
  CommandContext,
  ConversationRuntime,
  DeleteResult,
  Note,
  NotePage,
  Snapshot,
} from '../../packages/contracts/src/index.ts';
import type {
  ClientKind,
  ClientMessage,
  CoreMessage,
  RosterEntry,
} from '../../packages/contracts/src/wire.ts';

/**
 * 一个 ONE 客户端与本体之间的全部往来（ADR-013）。
 *
 * 这一层只做协议：把 ConversationRuntime 的方法变成白名单命令帧，把本体推来的状态、
 * 回执与"别的客户端想调用你"的请求分派掉。它不持有任何对话状态——状态只有
 * 本体有，本地只留最近一次快照供渲染，并如实标记"还没拿到"。
 */

/** 本体在管道另一端是否可用。`rejected` 表示协议不兼容，不是暂时故障。 */
export type CoreLinkState = 'connecting' | 'ready' | 'unavailable' | 'rejected';

export interface CoreConnection {
  connected: boolean;
  kind: string;
  label: string;
  capabilities: string[];
  wireVersion: number;
  coreVersion: string | null;
}

export interface Roster {
  installed: ClientKind[];
  connected: RosterEntry[];
}

/** 界面在第一次收到本体状态之前看到的东西：一个空快照，不是假数据。 */
export const EMPTY_SNAPSHOT: Snapshot = {
  workspaces: [],
  conversations: [],
  events: [],
  runs: [],
  drafts: {},
};

/** 本体多久不回就算它没在。慢于这个数的调用会得到 TIMEOUT 而不是永久挂起。 */
export const CALL_TIMEOUT_MS = 8000;

/** 壳与本体之间的通道。Tauri 版走 Rust 桥，预览版在进程内跑一个真本体。 */
export interface CoreChannel {
  connection(): Promise<CoreConnection>;
  send(frame: ClientMessage): Promise<void>;
  onFrame(handler: (line: string) => void): () => void;
  onStatus(handler: (status: CoreConnection) => void): () => void;
}

/** 每个请求帧都自带 id，本体靠它把回执送回来；hello 和 ping 不算请求。 */
type RequestFrame = Extract<ClientMessage, { id: string }>;

export interface CoreClient {
  client: ConversationRuntime;
  /** 领域能力经本体调用提供方；与会话运行时平级，不是它的方法。 */
  domains: {
    calendar: {
      list(context: CommandContext, input: unknown): Promise<CalendarPage>;
      create(context: CommandContext, input: unknown): Promise<CalendarEvent>;
      update(context: CommandContext, input: unknown): Promise<CalendarEvent>;
      remove(context: CommandContext, input: unknown): Promise<DeleteResult>;
    };
    notes: {
      list(context: CommandContext, input: unknown): Promise<NotePage>;
      create(context: CommandContext, input: unknown): Promise<Note>;
      update(context: CommandContext, input: unknown): Promise<Note>;
      remove(context: CommandContext, input: unknown): Promise<DeleteResult>;
    };
  };
  state(): CoreLinkState;
  connection(): CoreConnection | null;
  /** 本体每次状态变化或连接变化都通知一次，界面据此重画。 */
  subscribe(listener: () => void): () => void;
  roster(): Roster;
  snapshot(): Snapshot;
  /** 本体拒绝了这个客户端时给出的原因，例如协议版本不兼容。 */
  refusal(): string;
  /** 现在拿不到状态的原因：被拒绝，或者帧送不出去。界面要把它说出来。 */
  problem(): string;
  listClients(): Promise<Roster>;
  launch(kind: ClientKind): Promise<unknown>;
  callCapability(
    target: ClientKind,
    capability: string,
    args?: unknown,
  ): Promise<unknown>;
  /** 声明本客户端能被别人调用的能力。 */
  expose(capability: string, handler: (args: unknown) => unknown): void;
  dispose(): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export function createCoreClient(
  channel: CoreChannel,
  hello: ClientMessage,
): CoreClient {
  let state: CoreLinkState = 'connecting';
  let refusal = '';
  /** 帧发不出去时的原因：壳说连上了但握手送不到，是两种不同的故障。 */
  let failure = '';
  let connection: CoreConnection | null = null;
  let snapshot: Snapshot = EMPTY_SNAPSHOT;
  let revision = -1;
  let roster: Roster = { installed: [], connected: [] };
  const listeners = new Set<() => void>();
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (cause: unknown) => void }
  >();
  const capabilities = new Map<string, (args: unknown) => unknown>();
  let handshaking = false;

  const settle = () => listeners.forEach((listener) => listener());

  /** 一个都没等到就失败，绝不把空结果当成成功交回去。 */
  const rejectAll = (cause: unknown) => {
    const entries = [...pending.values()];
    pending.clear();
    entries.forEach((entry) => entry.reject(cause));
  };

  const request = <T>(message: RequestFrame): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (state === 'rejected') {
        reject(
          new ClientError('UNAVAILABLE', refusal || '本体拒绝了这个客户端'),
        );
        return;
      }
      if (state === 'unavailable') {
        reject(new ClientError('UNAVAILABLE', 'ONE 本体没有连接'));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(message.id);
        reject(
          new ClientError('TIMEOUT', 'ONE 本体没有回应，请确认它还在运行'),
        );
      }, CALL_TIMEOUT_MS);
      pending.set(message.id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (cause) => {
          clearTimeout(timer);
          reject(cause);
        },
      });
      channel.send(message).catch((cause: unknown) => {
        pending.delete(message.id);
        clearTimeout(timer);
        reject(
          cause instanceof ClientError
            ? cause
            : new ClientError('UNAVAILABLE', 'ONE 本体没有连接'),
        );
      });
    });

  const call = <T>(cmd: string, args: unknown[]): Promise<T> =>
    request<T>({ t: 'call', id: crypto.randomUUID(), cmd, args });

  const answer = (id: string, value: unknown) => {
    void channel
      .send({ t: 'capability.result', id, ok: true, value })
      .catch(() => undefined);
  };

  const refuse = (id: string, message: string) => {
    void channel
      .send({ t: 'capability.result', id, ok: false, message })
      .catch(() => undefined);
  };

  const handle = (message: CoreMessage) => {
    switch (message.t) {
      case 'welcome':
        state = 'ready';
        settle();
        return;
      case 'state':
        if (message.revision <= revision) return;
        revision = message.revision;
        snapshot = message.snapshot;
        state = 'ready';
        settle();
        return;
      case 'roster':
        roster = { installed: message.installed, connected: message.clients };
        settle();
        return;
      case 'result': {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.ok) entry.resolve(message.value);
        else
          entry.reject(
            new ClientError(
              message.error.code,
              message.error.message,
              message.error.details,
            ),
          );
        return;
      }
      case 'invoke': {
        // 另一个客户端在调用本客户端：只回应自己声明过的能力。
        const handler = capabilities.get(message.capability);
        if (!handler) {
          refuse(message.id, `本客户端没有提供 ${message.capability}`);
          return;
        }
        try {
          answer(message.id, handler(message.args));
        } catch (cause) {
          refuse(
            message.id,
            cause instanceof Error ? cause.message : '本客户端处理失败',
          );
        }
        return;
      }
      case 'rejected':
        state = 'rejected';
        refusal = message.message;
        rejectAll(new ClientError('UNAVAILABLE', message.message));
        settle();
        return;
      case 'pong':
        return;
      default:
        return;
    }
  };

  const stopFrame = channel.onFrame((line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // 坏帧直接丢：本体自己也会断开不该出现的客户端。
      return;
    }
    if (!isRecord(parsed) || typeof parsed.t !== 'string') return;
    handle(parsed as unknown as CoreMessage);
  });

  const stopStatus = channel.onStatus((status) => {
    const wasConnected = connection?.connected === true;
    connection = status;
    if (!status.connected) {
      markUnavailable(new ClientError('UNAVAILABLE', 'ONE 本体没有连接'));
      return;
    }
    // 同一根连接上会收到重复的通知（挂载时查一次状态，壳连上时再报一次）。
    // 只有真正换了连接才重新握手，否则会把刚接好的状态又推回 connecting。
    if (wasConnected && handshaking) {
      settle();
      return;
    }
    // 每次重连都要重新握手：本体不认上一条连接上的自己。
    handshake();
  });

  const dispose = () => {
    stopFrame();
    stopStatus();
    rejectAll(new ClientError('DISPOSED', '客户端已关闭'));
    listeners.clear();
    capabilities.clear();
    pending.clear();
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  // 补上先于监听注册就建立的连接：状态事件可能早于界面挂载。
  void channel
    .connection()
    .then((status) => {
      connection = status;
      if (status.connected && !handshaking) handshake();
    })
    .catch((cause: unknown) => {
      markUnavailable(cause);
    });

  function markUnavailable(cause: unknown) {
    handshaking = false;
    if (state !== 'rejected') {
      state = 'unavailable';
      failure = cause instanceof Error ? cause.message : 'ONE 本体没有连接';
    }
    rejectAll(new ClientError('UNAVAILABLE', failure || 'ONE 本体没有连接'));
    settle();
  }

  function handshake() {
    if (state === 'rejected') return;
    state = 'connecting';
    handshaking = true;
    // 握手发不出去必须说清楚：否则界面会一直停在"正在连接"。
    channel.send(hello).catch((cause: unknown) => {
      markUnavailable(cause);
    });
    settle();
  }

  return {
    client: {
      getSnapshot: () => snapshot,
      subscribe,
      createConversation: (title?: string) =>
        call('createConversation', [title]),
      changeAgent: (conversationId: string, agentId: AgentId) =>
        call('changeAgent', [conversationId, agentId]),
      sendMessage: (conversationId: string, text: string) =>
        call('sendMessage', [conversationId, text]),
      cancelRun: (runId: string) => call('cancelRun', [runId]),
      dispose,
    },
    /**
     * 领域能力与 `client` 并列而非其中之一（ADR-016）：本体是唯一调用方，
     * 这里只负责把请求送过去。没安装、没运行、没授权、版本冲突这四种情况
     * 由本体裁决后抛回，前端据 `details.providerProblem.reason` 分流。
     */
    domains: {
      calendar: {
        list: (context: CommandContext, input: unknown) =>
          call('calendarList', [context, input]) as Promise<CalendarPage>,
        create: (context: CommandContext, input: unknown) =>
          call('calendarCreate', [context, input]) as Promise<CalendarEvent>,
        update: (context: CommandContext, input: unknown) =>
          call('calendarUpdate', [context, input]) as Promise<CalendarEvent>,
        remove: (context: CommandContext, input: unknown) =>
          call('calendarDelete', [context, input]) as Promise<DeleteResult>,
      },
      notes: {
        list: (context: CommandContext, input: unknown) =>
          call('notesList', [context, input]) as Promise<NotePage>,
        create: (context: CommandContext, input: unknown) =>
          call('notesCreate', [context, input]) as Promise<Note>,
        update: (context: CommandContext, input: unknown) =>
          call('notesUpdate', [context, input]) as Promise<Note>,
        remove: (context: CommandContext, input: unknown) =>
          call('notesDelete', [context, input]) as Promise<DeleteResult>,
      },
    },
    state: () => state,
    connection: () => connection,
    subscribe,
    roster: () => roster,
    snapshot: () => snapshot,
    refusal: () => refusal,
    problem: () => refusal || failure,
    listClients: () =>
      request<Roster>({ t: 'clients.list', id: crypto.randomUUID() }),
    launch: (kind: ClientKind) =>
      request<unknown>({ t: 'clients.launch', id: crypto.randomUUID(), kind }),
    callCapability: (target: ClientKind, capability: string, args?: unknown) =>
      request<unknown>({
        t: 'capability.call',
        id: crypto.randomUUID(),
        target,
        capability,
        args,
      }),
    expose: (capability, handler) => {
      capabilities.set(capability, handler);
    },
    dispose,
  };
}
