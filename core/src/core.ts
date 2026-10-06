import { ClientError } from '../../packages/contracts/src/index.ts';
import type {
  AgentId,
  ClientInfo,
  ClientKind,
  ClientMessage,
  CommandContext,
  CoreMessage,
  OneClient,
  RosterEntry,
} from '../../packages/contracts/src/index.ts';
import { WIRE_VERSION } from '../../packages/contracts/src/wire.ts';

/**
 * ONE 本体的会话中枢（ADR-013）。
 *
 * 它持有唯一的 OneClient、执行白名单命令、广播带 revision 的快照，并充当
 * 客户端之间的调用中介：谁申报了什么能力，谁就能通过这里调用谁。传输层
 * （命名管道）不在这层，因此没有 socket 也能测试。
 */
export interface Connection {
  send(message: CoreMessage): void;
  close(): void;
}

export interface CoreOptions {
  version: string;
  /** 已安装的客户端种类；默认只装宠物。 */
  installed?: ClientKind[];
  /** 客户端之间互调的等待上限。 */
  capabilityTimeoutMs?: number;
  /** 由宿主注入的启动器；core 不认识任何具体可执行文件。 */
  launchClient?: (kind: ClientKind) => Promise<void> | void;
}

interface Session {
  info: ClientInfo;
  connection: Connection;
  connectedAt: string;
  waiting: Map<
    string,
    { resolve: (value: unknown) => void; reject: (message: string) => void }
  >;
}

const CAPABILITY_TIMEOUT_MS = 5000;

export function createCore(client: OneClient, options: CoreOptions) {
  const sessions = new Map<string, Session>();
  const installed = new Set<ClientKind>(options.installed ?? ['pet']);
  let revision = 0;

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
    broadcast({ t: 'state', revision, snapshot: client.getSnapshot() });
  };

  const pushRoster = () => {
    broadcast({ t: 'roster', clients: roster(), installed: [...installed] });
  };

  /** Whitelisted dispatch: the name arrives over the wire and is never trusted. */
  const commands: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    createConversation: (...args) =>
      client.createConversation(args[0] as string | undefined),
    changeAgent: (...args) =>
      client.changeAgent(args[0] as string, args[1] as AgentId),
    sendMessage: (...args) =>
      client.sendMessage(args[0] as string, args[1] as string),
    cancelRun: (...args) => client.cancelRun(args[0] as string),
    calendarList: (...args) =>
      client.calendarList(args[0] as CommandContext, args[1]),
    calendarCreate: (...args) =>
      client.calendarCreate(args[0] as CommandContext, args[1]),
    calendarUpdate: (...args) =>
      client.calendarUpdate(args[0] as CommandContext, args[1]),
    calendarDelete: (...args) =>
      client.calendarDelete(args[0] as CommandContext, args[1]),
    notesList: (...args) =>
      client.notesList(args[0] as CommandContext, args[1]),
    notesCreate: (...args) =>
      client.notesCreate(args[0] as CommandContext, args[1]),
    notesUpdate: (...args) =>
      client.notesUpdate(args[0] as CommandContext, args[1]),
    notesDelete: (...args) =>
      client.notesDelete(args[0] as CommandContext, args[1]),
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

  /** 客户端之间的调用：core 只转发，结果由被调用的客户端自己给出。 */
  const handleCapabilityCall = (
    requester: Session,
    id: string,
    target: ClientKind,
    capability: string,
    args: unknown,
  ) => {
    const respond = (message: CoreMessage) =>
      requester.connection.send(message);
    const found = [...sessions.values()].find(
      (session) => session.info.kind === target,
    );
    if (!found) {
      respond({
        t: 'result',
        id,
        ok: false,
        error: { code: 'NOT_FOUND', message: `${target} 客户端没有在运行` },
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

  const handleLaunch = async (id: string, kind: ClientKind) => {
    const running = [...sessions.values()].some(
      (session) => session.info.kind === kind,
    );
    const respond = (message: CoreMessage) => broadcast(message);
    if (running) {
      respond({ t: 'result', id, ok: true, value: { alreadyRunning: true } });
      return;
    }
    if (!installed.has(kind)) {
      respond({
        t: 'result',
        id,
        ok: false,
        error: { code: 'NOT_FOUND', message: `${kind} 还没有安装` },
      });
      return;
    }
    if (!options.launchClient) {
      respond({
        t: 'result',
        id,
        ok: false,
        error: { code: 'UNAVAILABLE', message: '当前核心没有配置客户端启动器' },
      });
      return;
    }
    try {
      await options.launchClient(kind);
      respond({ t: 'result', id, ok: true, value: { launched: kind } });
    } catch (error) {
      respond({ t: 'result', id, ok: false, error: describe(error) });
    }
  };

  /** 被调用的客户端回执，转交给最初发起调用的人。 */
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
        void handleLaunch(message.id, message.kind);
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
        kind: hello.client.kind,
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

  /** A departing client must not leave other clients waiting on its answers. */
  const disconnect = (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    session.waiting.forEach((entry) =>
      entry.reject(`${session.info.kind} 客户端已断开`),
    );
    sessions.delete(id);
    pushRoster();
  };

  const unsubscribe = client.subscribe(() => pushState());

  return {
    connect,
    disconnect,
    handleMessage,
    unsubscribe,
    roster,
    installed: () => [...installed],
    markInstalled(kind: ClientKind) {
      installed.add(kind);
      pushRoster();
    },
    snapshot: () => ({ revision, snapshot: client.getSnapshot() }),
  };
}

export type Core = ReturnType<typeof createCore>;
