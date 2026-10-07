import {
  ClientError,
  portableDetails,
} from '../../packages/contracts/src/index.ts';
import type {
  AgentId,
  CalendarEvent,
  CalendarPage,
  CommandContext,
  ConversationRuntime,
  DeleteResult,
  Note,
  NotePage,
  ProposalResolution,
  Snapshot,
} from '../../packages/contracts/src/index.ts';
import type {
  ClientMessage,
  CoreMessage,
  ProviderId,
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
  role: string;
  provider: string;
  label: string;
  capabilities: string[];
  wireVersion: number;
  coreVersion: string | null;
  /**
   * 本体**起不来**的原因，壳的原话（ADR-021）。
   *
   * 它存在的理由很直接：「本体没接上」这句话对用户毫无用处 —— 他需要知道是
   * 漏打包、node 没装、还是产物坏在哪儿。这三件事该做的完全不同。
   * 本体接上之后是 null。
   */
  coreProblem: string | null;
}

export interface Roster {
  installed: ProviderId[];
  connected: RosterEntry[];
}

/** 界面在第一次收到本体状态之前看到的东西：一个空快照，不是假数据。 */
export const EMPTY_SNAPSHOT: Snapshot = {
  workspaces: [],
  conversations: [],
  events: [],
  runs: [],
  drafts: {},
  proposals: [],
};

/** 本体多久不回就算它没在。慢于这个数的调用会得到 TIMEOUT 而不是永久挂起。 */
export const CALL_TIMEOUT_MS = 8000;

/** 壳与本体之间的通道。Tauri 版走 Rust 桥，预览版在进程内跑一个真本体。 */
export interface CoreChannel {
  connection(): Promise<CoreConnection>;
  send(frame: ClientMessage): Promise<void>;
  onFrame(handler: (line: string) => void): () => void;
  onStatus(handler: (status: CoreConnection) => void): () => void;
  /**
   * 请壳重放本体最近几帧。只有只读窗口用得到 —— 一根管道只握手一次，后开的
   * 窗口靠这个才拿得到状态与名册（ADR-013：客户端是进程，窗口只是它的屏幕）。
   */
  replay?(): Promise<void>;
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
  /**
   * 最近一次收到的一帧状态带的是第几版。**没收到过就是 -1**，不是 0：
   * 摘要条要写「本体状态 #7」让用户知道这份数据出自哪一版，而 -1 意味着
   * 「还不知道」——把它写成 0 就会看起来像本体重启后从没推进过的第一版，
   * 两种情况该说的话不一样（ADR-013）。
   */
  revision(): number;
  /** 本体拒绝了这个客户端时给出的原因，例如协议版本不兼容。 */
  refusal(): string;
  /**
   * 现在拿不到状态的原因：被拒绝、帧送不出去、或者**本体压根没起来**。
   * 界面要把它说出来 —— 一句「没接上」对用户毫无用处（ADR-021）。
   */
  problem(): string;
  listClients(): Promise<Roster>;
  launch(provider: ProviderId): Promise<unknown>;
  callCapability(
    target: ProviderId,
    capability: string,
    args?: unknown,
  ): Promise<unknown>;
  /**
   * 按命令名直调一次白名单命令。只给插件页面桥用：页面报的是能力名，先在
   * page.ts 的表里换成命令名，再走这里 —— 命令名永远不是页面给的，而领域输入
   * 也就照旧在本体边界校验一次（ADR-016）。
   */
  callCommand(command: string, args: unknown[]): Promise<unknown>;
  /**
   * 确认或拒绝一条待写入的提议（ADR-022）。
   *
   * 界面给的只是**决定**，不是写入指令：本体才是唯一动手的人（ADR-016）。
   *
   * 重复确认不会重复创建，返回的 `applied: false` 就是给界面据实说明「已经建过
   * 了」的那一位 —— 不写成「又成功了一次」，也不报错把用户吓一跳。
   */
  resolveProposal(
    proposalId: string,
    decision: 'confirm' | 'reject',
    reason?: string,
  ): Promise<ProposalResolution>;
  /** 声明本客户端能被别人调用的能力。 */
  expose(capability: string, handler: (args: unknown) => unknown): void;
  dispose(): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export function createCoreClient(
  channel: CoreChannel,
  hello: ClientMessage,
  options: { handshake?: boolean } = {},
): CoreClient {
  // 一根管道只握手一次（ADR-013：客户端是进程，窗口只是它的屏幕）。只读窗口
  // 不握手，而是向壳要重放 —— 每个窗口都握一次手的话，本体只认第一次，
  // 后来的窗口既拿不到回执，也永远等不到下一次握手。
  const handshakes = options.handshake !== false;
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

  /**
   * 能力返回值可能是 Promise（多数要过壳的命令都是 async）。必须等它落地再回：
   * 直接发 Promise 会被 JSON.stringify 变成 `{}`，调用方于是拿到一个空对象，
   * 而能力其实成功了 —— 那种「成功但数据是假的」比失败更难查。
   * Promise 拒绝一律回 ok=false，不把失败说成成功。
   */
  const answer = (id: string, value: unknown) => {
    void Promise.resolve(value)
      .then((resolved) =>
        channel.send({ t: 'capability.result', id, ok: true, value: resolved }),
      )
      .catch((cause: unknown) => refuse(id, cause));
  };

  /** 码一起发：本体的域端口与提供方靠它分流，不发就一律当 INTERNAL。 */
  const refuse = (id: string, cause: unknown) => {
    // `details` 同理：冲突时「对方现在是第几版」在里面，丢了它界面只能显示「?」。
    const details = portableDetails(
      cause instanceof ClientError ? cause.details : undefined,
    );
    void channel
      .send({
        t: 'capability.result',
        id,
        ok: false,
        code: cause instanceof ClientError ? cause.code : 'INTERNAL',
        message: cause instanceof Error ? cause.message : '本客户端处理失败',
        ...(details ? { details } : {}),
      })
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
        roster = {
          installed: message.installed,
          connected: message.participants,
        };
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
        // 另一个参与者在调用本客户端。同一客户端进程的多个窗口共用一根管道，
        // 因此**每个窗口都会收到这一帧** —— 只有注册了该能力的那个窗口才回应。
        //
        // 没有 handler 时必须保持沉默：由这个窗口回「本客户端没有提供」会被
        // 本体当成回执（本体只认第一个），于是对话条窗口会抢在宠物主窗口前面
        // 把调用判死。能力是否存在是本体该回答的问题，它在转发前已经校验过
        // 目标有没有声明这个能力。
        const handler = capabilities.get(message.capability);
        if (!handler) return;
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
    if (!handshakes) {
      // 只读窗口不握手，但要像主窗口一样从"正在连接"走到"已连接"。
      state = 'ready';
      settle();
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
      if (!handshakes) {
        // 监听到位之后再要重放：先要的话，那几帧会落在没人听的窗口里。
        if (status.connected) state = 'ready';
        void channel
          .replay?.()
          .catch((cause: unknown) => markUnavailable(cause));
        settle();
        return;
      }
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
      /**
       * 界面**不能**自己解决提议：写入领域数据的一直是本体（ADR-016/022）。
       *
       * 这一条只是把用户的决定送过去 —— 本体决定要不要写、写没写。真正的入口是
       * `resolveProposal`，界面不该拿一个「处理结果」对象反过来当命令用。
       */
      settleProposal: (proposalId: string, resolution: ProposalResolution) =>
        call('proposalResolve', [
          resolution.status === 'created'
            ? { proposalId, decision: 'confirm' }
            : { proposalId, decision: 'reject', reason: resolution.reason },
        ]),
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
    revision: () => revision,
    refusal: () => refusal,
    // 顺序有讲究：本体**起不来**比「被拒绝」更根本 —— 被拒绝是本体在说话，
    // 起不来是压根没有本体。两者都发生时，起不来那条才是用户该动手解决的。
    problem: () => connection?.coreProblem || refusal || failure,
    listClients: () =>
      request<Roster>({ t: 'clients.list', id: crypto.randomUUID() }),
    launch: (provider: ProviderId) =>
      request<unknown>({
        t: 'clients.launch',
        id: crypto.randomUUID(),
        provider,
      }),
    callCapability: (target: ProviderId, capability: string, args?: unknown) =>
      request<unknown>({
        t: 'capability.call',
        id: crypto.randomUUID(),
        target,
        capability,
        args,
      }),
    callCommand: (command, args) => call(command, args),
    resolveProposal: (proposalId, decision, reason) =>
      call<ProposalResolution>('proposalResolve', [
        decision === 'confirm'
          ? { proposalId, decision }
          : { proposalId, decision, reason },
      ]),
    expose: (capability, handler) => {
      capabilities.set(capability, handler);
    },
    dispose,
  };
}
