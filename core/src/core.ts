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
  resolveProvider,
} from '../../packages/contracts/src/index.ts';
import { WIRE_VERSION } from '../../packages/contracts/src/wire.ts';

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
 * 本体持有的领域端口（ADR-016）。slot 为 undefined 表示「没安装」，
 * 与「装了但没运行」是两种情况，由 resolveProvider 分开报错。
 */
export interface DomainPorts {
  calendar?: ProviderSlot<CalendarProvider>;
  notes?: ProviderSlot<NotesProvider>;
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
    { resolve: (value: unknown) => void; reject: (message: string) => void }
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
    calendarList: (...args) =>
      resolveProvider(domains.calendar, 'calendar').list(
        contextOf(args),
        parseCalendarList(args[1]),
      ),
    calendarCreate: (...args) =>
      resolveProvider(domains.calendar, 'calendar').create(
        contextOf(args),
        parseCalendarCreate(args[1]),
      ),
    calendarUpdate: (...args) =>
      resolveProvider(domains.calendar, 'calendar').update(
        contextOf(args),
        parseCalendarUpdate(args[1]),
      ),
    calendarDelete: (...args) =>
      resolveProvider(domains.calendar, 'calendar').remove(
        contextOf(args),
        parseCalendarDelete(args[1]),
      ),
    notesList: (...args) =>
      resolveProvider(domains.notes, 'notes').list(
        contextOf(args),
        parseNotesList(args[1]),
      ),
    notesCreate: (...args) =>
      resolveProvider(domains.notes, 'notes').create(
        contextOf(args),
        parseNotesCreate(args[1]),
      ),
    notesUpdate: (...args) =>
      resolveProvider(domains.notes, 'notes').update(
        contextOf(args),
        parseNotesUpdate(args[1]),
      ),
    notesDelete: (...args) =>
      resolveProvider(domains.notes, 'notes').remove(
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
    const found = [...sessions.values()].find(
      (session) => session.info.provider === target,
    );
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
          error: { code: 'INTERNAL', message },
        });
      },
    });
    found.connection.send({ t: 'invoke', id, capability, args });
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
    ok: boolean,
    payload: unknown,
  ) => {
    const waiting = session.waiting.get(id);
    if (!waiting) return;
    session.waiting.delete(id);
    if (ok) waiting.resolve(payload);
    else
      waiting.reject(
        typeof payload === 'string' ? payload : '目标客户端处理失败',
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
        handleCapabilityResult(
          session,
          message.id,
          message.ok,
          message.ok ? message.value : message.message,
        );
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
    installed: () => [...installed],
    markInstalled(provider: ProviderId) {
      installed.add(provider);
      pushRoster();
    },
    snapshot: () => ({ revision, snapshot: runtime.getSnapshot() }),
  };
}

export type Core = ReturnType<typeof createCore>;
