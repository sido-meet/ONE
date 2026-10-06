import { ClientError } from '../../packages/contracts/src';
import type {
  AgentId,
  CommandContext,
  OneClient,
} from '../../packages/contracts/src';
import {
  HOST_COMMAND,
  HOST_HELLO,
  HOST_RESULT,
  HOST_SNAPSHOT,
  parseCommandEnvelope,
} from './protocol';
import type { CommandEnvelope, CommandName } from './protocol';
import type { Transport } from './transport';

/**
 * The authoritative side: it owns the single client instance, answers commands
 * from other windows and broadcasts a revision-stamped snapshot on every change.
 * This is the 0.1 stand-in for the Runtime sidecar described in docs/03.
 */
export interface HostClient {
  client: OneClient;
  dispose(): void;
}

export function createHostClient(
  inner: OneClient,
  transport: Transport,
): HostClient {
  let revision = 0;
  const listeners = new Set<() => void>();

  /** Whitelisted dispatch: the name comes from the protocol, never from a cast. */
  const methods: Record<CommandName, (...args: unknown[]) => Promise<unknown>> =
    {
      createConversation: (...args) =>
        inner.createConversation(args[0] as string | undefined),
      changeAgent: (...args) =>
        inner.changeAgent(args[0] as string, args[1] as AgentId),
      sendMessage: (...args) =>
        inner.sendMessage(args[0] as string, args[1] as string),
      cancelRun: (...args) => inner.cancelRun(args[0] as string),
      calendarList: (...args) =>
        inner.calendarList(args[0] as CommandContext, args[1]),
      calendarCreate: (...args) =>
        inner.calendarCreate(args[0] as CommandContext, args[1]),
      calendarUpdate: (...args) =>
        inner.calendarUpdate(args[0] as CommandContext, args[1]),
      calendarDelete: (...args) =>
        inner.calendarDelete(args[0] as CommandContext, args[1]),
      notesList: (...args) =>
        inner.notesList(args[0] as CommandContext, args[1]),
      notesCreate: (...args) =>
        inner.notesCreate(args[0] as CommandContext, args[1]),
      notesUpdate: (...args) =>
        inner.notesUpdate(args[0] as CommandContext, args[1]),
      notesDelete: (...args) =>
        inner.notesDelete(args[0] as CommandContext, args[1]),
    };

  const broadcast = () => {
    revision += 1;
    transport.send(HOST_SNAPSHOT, {
      revision,
      snapshot: inner.getSnapshot(),
    });
  };

  const reply = (envelope: CommandEnvelope, result: unknown) =>
    transport.send(HOST_RESULT, {
      requestId: envelope.requestId,
      ok: true,
      value: result,
    });

  const reject = (envelope: CommandEnvelope, cause: unknown) => {
    const failure =
      cause instanceof ClientError
        ? cause
        : new ClientError('INTERNAL', '命令执行失败，请重试');
    transport.send(HOST_RESULT, {
      requestId: envelope.requestId,
      ok: false,
      error: {
        code: failure.code,
        message: failure.message,
        ...(failure.details ? { details: failure.details } : {}),
      },
    });
  };

  const run = async (envelope: CommandEnvelope) => {
    try {
      reply(envelope, await methods[envelope.name](...envelope.args));
    } catch (cause) {
      reject(envelope, cause);
    }
  };

  const stopCommand = transport.listen(HOST_COMMAND, (payload) => {
    const envelope = parseCommandEnvelope(payload);
    if (!envelope) return;
    void run(envelope);
  });
  const stopHello = transport.listen(HOST_HELLO, () => broadcast());
  const stopInner = inner.subscribe(() => {
    listeners.forEach((listener) => listener());
    broadcast();
  });

  const dispose = () => {
    stopCommand();
    stopHello();
    stopInner();
    listeners.clear();
    inner.dispose();
  };

  return {
    client: {
      getSnapshot: () => inner.getSnapshot(),
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      createConversation: (title) => inner.createConversation(title),
      changeAgent: (conversationId, agentId) =>
        inner.changeAgent(conversationId, agentId),
      sendMessage: (conversationId, text) =>
        inner.sendMessage(conversationId, text),
      cancelRun: (runId) => inner.cancelRun(runId),
      calendarList: (context, input) => inner.calendarList(context, input),
      calendarCreate: (context, input) => inner.calendarCreate(context, input),
      calendarUpdate: (context, input) => inner.calendarUpdate(context, input),
      calendarDelete: (context, input) => inner.calendarDelete(context, input),
      notesList: (context, input) => inner.notesList(context, input),
      notesCreate: (context, input) => inner.notesCreate(context, input),
      notesUpdate: (context, input) => inner.notesUpdate(context, input),
      notesDelete: (context, input) => inner.notesDelete(context, input),
      dispose,
    },
    dispose,
  };
}
