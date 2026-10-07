import { ClientError } from '../../packages/contracts/src/index.ts';
import type {
  AgentId,
  CalendarProvider,
  ClientMessage,
  CommandContext,
  ConversationRuntime,
  CoreMessage,
  NotesProvider,
  ParticipantInfo,
  ProviderId,
  ProviderSlot,
  ProposalResolution,
  RosterEntry,
} from '../../packages/contracts/src/index.ts';
import {
  parseCalendarCreate,
  parseCalendarDelete,
  parseCalendarList,
  parseCalendarUpdate,
  parseNotesCreate,
  parseNotesDelete,
  parseNotesList,
  parseNotesUpdate,
  parseProposalResolve,
  proposalIdempotencyKey,
  resolveProvider,
  settledResolution,
} from '../../packages/contracts/src/index.ts';
import { WIRE_VERSION } from '../../packages/contracts/src/wire.ts';
import { PAGE_READ_CAPABILITY } from '../../packages/contracts/src/page.ts';

/**
 * ONE 本体的会话中枢（ADR-013）。
 *
 * 它持有唯一的会话运行时、执行白名单命令、广播带 revision 的快照，并充当
 * 客户端之间的调用中介：谁申报了什么能力，谁就能通过这里调用谁。传输层
 * （命名管道）不在这层，因此没有 socket 也能测试。
 */
export interface Connection {
  send(message: CoreMessage): void;
  close(): void;
}

/**
 * 本体持有的领域端口（ADR-016）。
 *
 * 是**函数**而不是值：提供方是运行时连上来的进程，在线状态随时会变。把 slot
 * 冻在启动那一刻的话，提供方连上之后仍会被报成「没运行」。每次命令现读一次，
 * 拿到的就是当下的实情。
 *
 * 返回 undefined 表示「没安装」，与「装了没运行」是两种情况，由 resolveProvider
 * 分开报错。
 */
export interface DomainPorts {
  calendar?: () => ProviderSlot<CalendarProvider> | undefined;
  notes?: () => ProviderSlot<NotesProvider> | undefined;
}

export interface CoreOptions {
  version: string;
  /** 已安装的参与者寻址键；默认只装宠物。 */
  installed?: ProviderId[];
  /** 参与者之间互调的等待上限。 */
  capabilityTimeoutMs?: number;
  /** 由宿主注入的启动器；core 不认识任何具体可执行文件。 */
  launchClient?: (provider: ProviderId) => Promise<void> | void;
  /** 领域能力提供方；未给的种类一律按「没安装」处理。 */
  domains?: DomainPorts;
}

interface Session {
  info: ParticipantInfo;
  connection: Connection;
  connectedAt: string;
  waiting: Map<
    string,
    // 拒绝时带的是 ClientError 而不是字符串：码要一路送到界面，否则"没这个文件"
    // 与"里面坏了"在用户那里长得一模一样（ADR-016）。
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >;
}

const CAPABILITY_TIMEOUT_MS = 5000;

export function createCore(runtime: ConversationRuntime, options: CoreOptions) {
  const sessions = new Map<string, Session>();
  const installed = new Set<ProviderId>(options.installed ?? ['pet']);
  const domains = options.domains ?? {};
  let revision = 0;

  /**
   * 名册是「参与者」而不是「客户端」：呈现形式与领域提供方都能查得到。
   * 但界面不要把提供方画成宠物 —— 两者的图标与可用操作不同（ADR-017）。
   */
  const roster = (): RosterEntry[] =>
    [...sessions.values()].map((session) => ({
      ...session.info,
      connectedAt: session.connectedAt,
    }));

  const broadcast = (message: CoreMessage) => {
    sessions.forEach((session) => session.connection.send(message));
  };

  /**
   * 寻址键全局唯一，因此一个键至多一个会话。名册、名册校验与页面请求都靠它，
   * 不各写一份查找逻辑 —— 几份查找迟早会在边界情况上分叉。
   */
  const sessionsByProvider = (provider: ProviderId): Session | undefined =>
    [...sessions.values()].find(
      (session) => session.info.provider === provider,
    );

  const pushState = () => {
    revision += 1;
    broadcast({ t: 'state', revision, snapshot: runtime.getSnapshot() });
  };

  const pushRoster = () => {
    broadcast({
      t: 'roster',
      participants: roster(),
      installed: [...installed],
    });
  };

  const contextOf = (args: unknown[]) => args[0] as CommandContext;

  /**
   * 确认一条待写入的提议：本体是唯一动手的人（ADR-016/022）。
   *
   * 四件事按顺序发生，顺序本身就是行为：
   *
   * 1. 先看这条提议**在不在** —— 不在就是 NOT_FOUND，不能凭空造一条。
   * 2. 已经解决过的**直接回既有结果**，不再写第二次。这是「重复确认不重复创建」
   *    的定义；返回 `applied: false` 让界面能说清「已经建过了」，而不是假装
   *    又干了一遍。两次确认并发到达时由提供方的幂等键兜底（键由提议 id 派生），
   *    因此这里不需要锁 —— 拦住重复的是数据，不是时序。
   * 3. 拒绝**不碰提供方**：数据一个字节都不变，界面照实说「没写进去」。
   * 4. 确认才写。工作区取自**提议自己**而不是客户端上报的值：客户端只是
   *    一块屏幕，它没有资格决定写进谁的空间。
   */
  const resolveProposal = async (args: unknown[]) => {
    const input = parseProposalResolve(args[0]);
    const proposal = runtime
      .getSnapshot()
      .proposals.find((item) => item.id === input.proposalId);
    if (!proposal)
      throw new ClientError('NOT_FOUND', '找不到这条提议', {
        proposalId: input.proposalId,
      });
    if (proposal.status !== 'pending') return settledResolution(proposal);

    const at = new Date().toISOString();
    if (input.decision === 'reject') {
      const resolution: ProposalResolution = {
        proposalId: input.proposalId,
        applied: true,
        status: 'rejected',
        reason: input.reason,
        at,
      };
      await runtime.settleProposal(input.proposalId, resolution);
      return resolution;
    }

    // 可用性先于输入校验，与其他领域命令同一顺序（见 resolveProvider）。
    const provider = resolveProvider(domains.calendar?.(), 'calendar');
    const context: CommandContext = {
      requestId: `proposal-${input.proposalId}`,
      workspaceId: proposal.workspaceId,
      source: 'ui',
    };
    const event = await provider.create(
      context,
      parseCalendarCreate({
        ...proposal.draft,
        sourceConversationId: proposal.sourceConversationId,
        idempotencyKey: proposalIdempotencyKey(proposal.id),
      }),
    );
    const resolution: ProposalResolution = {
      proposalId: input.proposalId,
      applied: true,
      status: 'created',
      entityId: event.id,
      at,
    };
    await runtime.settleProposal(input.proposalId, resolution);
    return resolution;
  };

  /**
   * Whitelisted dispatch: the name arrives over the wire and is never trusted.
   *
   * 领域命令的顺序是「先解析提供方，再校验输入」：提供方不可用时校验参数没有
   * 意义，用户根本没机会把参数填对，报 VALIDATION 反而误导。可用性、授权与
   * 版本由 resolveProvider 统一翻译成本体裁决过的四种语义（ADR-016）。
   */
  const commands: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    createConversation: (...args) =>
      runtime.createConversation(args[0] as string | undefined),
    changeAgent: (...args) =>
      runtime.changeAgent(args[0] as string, args[1] as AgentId),
    sendMessage: (...args) =>
      runtime.sendMessage(args[0] as string, args[1] as string),
    cancelRun: (...args) => runtime.cancelRun(args[0] as string),
    proposalResolve: (...args) => resolveProposal(args),
    /**
     * 列出提议。界面靠快照里的 `proposals` 就够了，这条是给命令行与排障用的 ——
     * 它读的是**同一份**状态，不是另一处拷贝。
     */
    listProposals: async () =>
      runtime.getSnapshot().proposals.map((item) => ({
        id: item.id,
        domain: item.domain,
        status: item.status,
        title: item.domain === 'calendar' ? item.draft.title : '',
        startsAt: item.domain === 'calendar' ? item.draft.startsAt : undefined,
      })),
    calendarList: (...args) =>
      resolveProvider(domains.calendar?.(), 'calendar').list(
        contextOf(args),
        parseCalendarList(args[1]),
      ),
    calendarCreate: (...args) =>
      resolveProvider(domains.calendar?.(), 'calendar').create(
        contextOf(args),
        parseCalendarCreate(args[1]),
      ),
    calendarUpdate: (...args) =>
      resolveProvider(domains.calendar?.(), 'calendar').update(
        contextOf(args),
        parseCalendarUpdate(args[1]),
      ),
    calendarDelete: (...args) =>
      resolveProvider(domains.calendar?.(), 'calendar').remove(
        contextOf(args),
        parseCalendarDelete(args[1]),
      ),
    notesList: (...args) =>
      resolveProvider(domains.notes?.(), 'notes').list(
        contextOf(args),
        parseNotesList(args[1]),
      ),
    notesCreate: (...args) =>
      resolveProvider(domains.notes?.(), 'notes').create(
        contextOf(args),
        parseNotesCreate(args[1]),
      ),
    notesUpdate: (...args) =>
      resolveProvider(domains.notes?.(), 'notes').update(
        contextOf(args),
        parseNotesUpdate(args[1]),
      ),
    notesDelete: (...args) =>
      resolveProvider(domains.notes?.(), 'notes').remove(
        contextOf(args),
        parseNotesDelete(args[1]),
      ),
  };

  const describe = (error: unknown) =>
    error instanceof ClientError
      ? {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        }
      : { code: 'INTERNAL' as const, message: '核心执行该命令时出错' };

  const handleCall = async (
    session: Session,
    id: string,
    cmd: string,
    args: unknown[],
  ) => {
    const method = commands[cmd];
    if (!method) {
      session.connection.send({
        t: 'result',
        id,
        ok: false,
        error: { code: 'VALIDATION', message: `核心未提供命令 ${cmd}` },
      });
      return;
    }
    try {
      session.connection.send({
        t: 'result',
        id,
        ok: true,
        value: await method(...args),
      });
    } catch (error) {
      session.connection.send({
        t: 'result',
        id,
        ok: false,
        error: describe(error),
      });
    }
  };

  /** 参与者之间的调用：core 只转发，结果由被调用方自己给出。 */
  const handleCapabilityCall = (
    requester: Session,
    id: string,
    target: ProviderId,
    capability: string,
    args: unknown,
  ) => {
    const respond = (message: CoreMessage) =>
      requester.connection.send(message);
    const found = sessionsByProvider(target);
    if (!found) {
      respond({
        t: 'result',
        id,
        ok: false,
        error: { code: 'NOT_FOUND', message: `${target} 没有在运行` },
      });
      return;
    }
    if (!found.info.capabilities.includes(capability)) {
      respond({
        t: 'result',
        id,
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: `${target} 没有提供 ${capability}`,
        },
      });
      return;
    }
    const timer = setTimeout(() => {
      found.waiting.delete(id);
      respond({
        t: 'result',
        id,
        ok: false,
        error: { code: 'TIMEOUT', message: `${target} 没有回应 ${capability}` },
      });
    }, options.capabilityTimeoutMs ?? CAPABILITY_TIMEOUT_MS);
    found.waiting.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        respond({ t: 'result', id, ok: true, value });
      },
      reject: (message) => {
        clearTimeout(timer);
        respond({
          t: 'result',
          id,
          ok: false,
          error: describe(message),
        });
      },
    });
    found.connection.send({ t: 'invoke', id, capability, args });
  };

  /**
   * 本体自己发起的能力调用（ADR-016）。领域端口的远端实现靠它把请求转给管道
   * 另一端的提供方 —— 本体仍然是唯一调用方，只不过这次它代表自己说话，
   * 而不是替某个客户端转发。寻址、能力检查与超时都与 handleCapabilityCall
   * 同一套，免得两条路给出不同的失败语义。
   */
  const invoke = (
    target: ProviderId,
    capability: string,
    args?: unknown,
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const found = sessionsByProvider(target);
      if (!found) {
        reject(new ClientError('UNAVAILABLE', `${target} 没有在运行`));
        return;
      }
      if (!found.info.capabilities.includes(capability)) {
        reject(
          new ClientError('NOT_FOUND', `${target} 没有提供 ${capability}`),
        );
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        found.waiting.delete(id);
        reject(new ClientError('TIMEOUT', `${target} 没有回应 ${capability}`));
      }, options.capabilityTimeoutMs ?? CAPABILITY_TIMEOUT_MS);
      found.waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (message) => {
          clearTimeout(timer);
          // 目标报的码原样带走：界面上"日历源没授权"与"日历源崩了"必须分开。
          reject(
            message instanceof ClientError
              ? message
              : new ClientError(
                  'INTERNAL',
                  message instanceof Error
                    ? message.message
                    : '目标客户端处理失败',
                ),
          );
        },
      });
      found.connection.send({ t: 'invoke', id, capability, args });
    });

  /**
   * 取插件页面的一段资源（ADR-018）。
   *
   * 宿主不给插件页面发请求，只来这里要：要来的路径仍然按提供方申报的入口与
   * `page.read` 能力核对过才转发。三道闸门缺一不可 ——
   *
   * - 目标必须在场：没运行就报「没有在运行」，不是「没这个文件」；
   * - 目标必须**自己申报过页面**：没申报的参与者即使会答 `page.read` 也不放行，
   *   否则任何客户端都能借它当文件服务器；
   * - 目标必须提供 `page.read`：它没这个能力的话这次调用必然失败，不如本体先说。
   *
   * 本体自己不改写内容，只是转交 —— 页面长什么样归插件（ADR-018 已接受的代价）。
   */
  const handlePageRead = async (
    session: Session,
    id: string,
    provider: ProviderId,
    path: string,
  ) => {
    const respond = (message: CoreMessage) => session.connection.send(message);
    const found = sessionsByProvider(provider);
    if (!found) {
      respond({
        t: 'result',
        id,
        ok: false,
        error: { code: 'UNAVAILABLE', message: `${provider} 没有在运行` },
      });
      return;
    }
    if (!found.info.view) {
      respond({
        t: 'result',
        id,
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: `${provider} 没有自带页面`,
        },
      });
      return;
    }
    if (!found.info.capabilities.includes(PAGE_READ_CAPABILITY)) {
      respond({
        t: 'result',
        id,
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: `${provider} 没有提供 ${PAGE_READ_CAPABILITY}`,
        },
      });
      return;
    }
    try {
      respond({
        t: 'result',
        id,
        ok: true,
        value: await invoke(provider, PAGE_READ_CAPABILITY, { path }),
      });
    } catch (error) {
      respond({
        t: 'result',
        id,
        ok: false,
        error: describe(error),
      });
    }
  };

  const handleLaunch = async (id: string, provider: ProviderId) => {
    const running = [...sessions.values()].some(
      (session) => session.info.provider === provider,
    );
    const respond = (message: CoreMessage) => broadcast(message);
    if (running) {
      respond({ t: 'result', id, ok: true, value: { alreadyRunning: true } });
      return;
    }
    if (!installed.has(provider)) {
      respond({
        t: 'result',
        id,
        ok: false,
        error: { code: 'NOT_FOUND', message: `${provider} 还没有安装` },
      });
      return;
    }
    if (!options.launchClient) {
      respond({
        t: 'result',
        id,
        ok: false,
        error: { code: 'UNAVAILABLE', message: '当前核心没有配置启动器' },
      });
      return;
    }
    try {
      await options.launchClient(provider);
      respond({ t: 'result', id, ok: true, value: { launched: provider } });
    } catch (error) {
      respond({ t: 'result', id, ok: false, error: describe(error) });
    }
  };

  /** 被调用的参与者回执，转交给最初发起调用的人。 */
  const handleCapabilityResult = (
    session: Session,
    id: string,
    message: Extract<ClientMessage, { t: 'capability.result' }>,
  ) => {
    const waiting = session.waiting.get(id);
    if (!waiting) return;
    session.waiting.delete(id);
    if (message.ok) {
      waiting.resolve(message.value);
      return;
    }
    // 对方报了码就照传。丢掉码的话，提供方的「没这个文件」到壳那里会变成
    // 「内部错误」，界面上就只能给一句没法排查的话（ADR-016）。
    waiting.reject(
      new ClientError(
        message.code ?? 'INTERNAL',
        message.message || '目标客户端处理失败',
      ),
    );
  };

  const handleMessage = (session: Session, message: ClientMessage) => {
    switch (message.t) {
      case 'ping':
        session.connection.send({ t: 'pong' });
        return;
      case 'call':
        void handleCall(session, message.id, message.cmd, message.args);
        return;
      case 'capability.call':
        handleCapabilityCall(
          session,
          message.id,
          message.target,
          message.capability,
          message.args,
        );
        return;
      case 'capability.result':
        handleCapabilityResult(session, message.id, message);
        return;
      case 'clients.list':
        session.connection.send({
          t: 'result',
          id: message.id,
          ok: true,
          value: { installed: [...installed], connected: roster() },
        });
        return;
      case 'clients.launch':
        void handleLaunch(message.id, message.provider);
        return;
      case 'page.read':
        void handlePageRead(
          session,
          message.id,
          message.provider,
          message.path,
        );
        return;
      default:
        return;
    }
  };

  /**
   * Every frame passes the parser before it gets here, so a malformed or
   * version-mismatched client is refused outright instead of half-handled.
   */
  const connect = (connection: Connection, hello: ClientMessage) => {
    if (hello.t !== 'hello') {
      connection.send({ t: 'rejected', message: '第一帧必须是 hello' });
      connection.close();
      return null;
    }
    if (hello.v !== WIRE_VERSION) {
      connection.send({
        t: 'rejected',
        message: `协议版本不兼容：客户端 ${hello.v}，核心 ${WIRE_VERSION}`,
      });
      connection.close();
      return null;
    }
    const session: Session = {
      info: {
        id: crypto.randomUUID(),
        role: hello.client.role,
        provider: hello.client.provider,
        label: hello.client.label,
        capabilities: hello.client.capabilities,
        ...(hello.client.view ? { view: hello.client.view } : {}),
      },
      connection,
      connectedAt: new Date().toISOString(),
      waiting: new Map(),
    };
    sessions.set(session.info.id, session);
    // 连上来不等于"已安装"：安装清单只由宿主和 markInstalled 决定。
    connection.send({
      t: 'welcome',
      v: WIRE_VERSION,
      clientId: session.info.id,
      coreVersion: options.version,
    });
    pushState();
    pushRoster();
    return session;
  };

  /** A departing participant must not leave others waiting on its answers. */
  const disconnect = (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    session.waiting.forEach((entry) =>
      entry.reject(`${session.info.provider} 已断开`),
    );
    sessions.delete(id);
    pushRoster();
  };

  const unsubscribe = runtime.subscribe(() => pushState());

  return {
    connect,
    disconnect,
    handleMessage,
    unsubscribe,
    roster,
    invoke,
    installed: () => [...installed],
    markInstalled(provider: ProviderId) {
      installed.add(provider);
      pushRoster();
    },
    snapshot: () => ({ revision, snapshot: runtime.getSnapshot() }),
  };
}

export type Core = ReturnType<typeof createCore>;
