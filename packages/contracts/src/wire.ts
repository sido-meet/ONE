import type { ErrorCode, Snapshot } from './index.ts';

/**
 * Wire protocol between ONE core and any client (docs/03, ADR-013).
 *
 * ONE 本体是唯一的状态与能力来源；客户端只是呈现形式，可以是宠物、桌面端
 * 或命令行。core 同时充当客户端之间的调用中介：每个客户端在 hello 里申报
 * 自己的能力，任何客户端都能通过 core 调用另一个客户端的能力。
 *
 * 传输是有长度边界的逐行 JSON（Windows 命名管道），协议版本不兼容即拒绝。
 */
export const WIRE_VERSION = 1;

/** 客户端种类只是标签，core 不为它们写任何特判。 */
export type ClientKind = 'pet' | 'desktop' | 'cli';

export interface ClientInfo {
  id: string;
  kind: ClientKind;
  label: string;
  /** 形如 `pet.bubble.open`，调用方按字符串寻址。 */
  capabilities: string[];
}

export interface RosterEntry extends ClientInfo {
  connectedAt: string;
}

/** 客户端 → core */
export type ClientMessage =
  | {
      t: 'hello';
      v: number;
      client: { kind: ClientKind; label: string; capabilities: string[] };
    }
  | { t: 'call'; id: string; cmd: string; args: unknown[] }
  | { t: 'clients.list'; id: string }
  | { t: 'clients.launch'; id: string; kind: ClientKind }
  | {
      t: 'capability.call';
      id: string;
      target: ClientKind;
      capability: string;
      args?: unknown;
    }
  | { t: 'capability.result'; id: string; ok: true; value?: unknown }
  | { t: 'capability.result'; id: string; ok: false; message: string }
  | { t: 'ping' };

/** core → 客户端 */
export type CoreMessage =
  | {
      t: 'welcome';
      v: number;
      clientId: string;
      coreVersion: string;
    }
  | { t: 'state'; revision: number; snapshot: Snapshot }
  | { t: 'result'; id: string; ok: true; value?: unknown }
  | {
      t: 'result';
      id: string;
      ok: false;
      error: {
        code: ErrorCode;
        message: string;
        details?: Record<string, unknown>;
      };
    }
  | { t: 'roster'; clients: RosterEntry[]; installed: ClientKind[] }
  | { t: 'invoke'; id: string; capability: string; args?: unknown }
  | { t: 'rejected'; message: string }
  | { t: 'pong' };

const CLIENT_KINDS: ClientKind[] = ['pet', 'desktop', 'cli'];

export function isClientKind(value: unknown): value is ClientKind {
  return (
    typeof value === 'string' && (CLIENT_KINDS as string[]).includes(value)
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Untrusted input from a socket: anything unrecognised is rejected, not guessed. */
export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isRecord(value) || typeof value.t !== 'string') return null;
  switch (value.t) {
    case 'hello': {
      if (typeof value.v !== 'number') return null;
      const client = isRecord(value.client) ? value.client : null;
      if (!client || !isClientKind(client.kind)) return null;
      if (typeof client.label !== 'string') return null;
      const capabilities = Array.isArray(client.capabilities)
        ? client.capabilities.filter(
            (item): item is string => typeof item === 'string',
          )
        : [];
      return {
        t: 'hello',
        v: value.v,
        client: {
          kind: client.kind,
          label: client.label.slice(0, 64),
          capabilities: capabilities.slice(0, 32),
        },
      };
    }
    case 'call':
      if (typeof value.id !== 'string' || !value.id) return null;
      if (typeof value.cmd !== 'string') return null;
      if (!Array.isArray(value.args)) return null;
      return { t: 'call', id: value.id, cmd: value.cmd, args: value.args };
    case 'clients.list':
      if (typeof value.id !== 'string' || !value.id) return null;
      return { t: 'clients.list', id: value.id };
    case 'clients.launch':
      if (typeof value.id !== 'string' || !value.id) return null;
      if (!isClientKind(value.kind)) return null;
      return { t: 'clients.launch', id: value.id, kind: value.kind };
    case 'capability.call':
      if (typeof value.id !== 'string' || !value.id) return null;
      if (!isClientKind(value.target)) return null;
      if (typeof value.capability !== 'string' || !value.capability)
        return null;
      return {
        t: 'capability.call',
        id: value.id,
        target: value.target,
        capability: value.capability.slice(0, 64),
        args: value.args,
      };
    case 'capability.result':
      if (typeof value.id !== 'string' || !value.id) return null;
      if (typeof value.ok !== 'boolean') return null;
      if (value.ok)
        return {
          t: 'capability.result',
          id: value.id,
          ok: true,
          value: value.value,
        };
      if (typeof value.message !== 'string') return null;
      return {
        t: 'capability.result',
        id: value.id,
        ok: false,
        message: value.message.slice(0, 200),
      };
    case 'ping':
      return { t: 'ping' };
    default:
      return null;
  }
}

/** Upper bound on one frame so a broken client cannot exhaust memory. */
export const MAX_FRAME_BYTES = 1024 * 1024;

const isRosterEntry = (value: unknown): value is RosterEntry => {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    isClientKind(value.kind) &&
    typeof value.label === 'string' &&
    typeof value.connectedAt === 'string' &&
    Array.isArray(value.capabilities)
  );
};

/**
 * The mirror of `parseClientMessage`, for the other direction. A renderer that
 * receives a raw line from the shell must run it through here before acting:
 * `CoreMessage` describes what the core may send, not what actually arrived.
 */
export function parseCoreMessage(value: unknown): CoreMessage | null {
  if (!isRecord(value) || typeof value.t !== 'string') return null;
  switch (value.t) {
    case 'welcome':
      if (typeof value.v !== 'number') return null;
      if (typeof value.clientId !== 'string' || !value.clientId) return null;
      if (typeof value.coreVersion !== 'string') return null;
      return {
        t: 'welcome',
        v: value.v,
        clientId: value.clientId,
        coreVersion: value.coreVersion,
      };
    case 'state':
      if (typeof value.revision !== 'number') return null;
      if (!isRecord(value.snapshot)) return null;
      return {
        t: 'state',
        revision: value.revision,
        snapshot: value.snapshot as unknown as Snapshot,
      };
    case 'result': {
      if (typeof value.id !== 'string' || !value.id) return null;
      if (typeof value.ok !== 'boolean') return null;
      if (value.ok) {
        return { t: 'result', id: value.id, ok: true, value: value.value };
      }
      const error = isRecord(value.error) ? value.error : null;
      if (
        !error ||
        typeof error.code !== 'string' ||
        typeof error.message !== 'string'
      )
        return null;
      return {
        t: 'result',
        id: value.id,
        ok: false,
        error: {
          code: error.code as ErrorCode,
          message: error.message,
          ...(isRecord(error.details) ? { details: error.details } : {}),
        },
      };
    }
    case 'roster':
      if (!Array.isArray(value.clients) || !Array.isArray(value.installed))
        return null;
      return {
        t: 'roster',
        clients: value.clients.filter(isRosterEntry),
        installed: value.installed.filter(isClientKind),
      };
    case 'invoke':
      if (typeof value.id !== 'string' || !value.id) return null;
      if (typeof value.capability !== 'string' || !value.capability)
        return null;
      return {
        t: 'invoke',
        id: value.id,
        capability: value.capability,
        args: value.args,
      };
    case 'rejected':
      if (typeof value.message !== 'string') return null;
      return { t: 'rejected', message: value.message };
    case 'pong':
      return { t: 'pong' };
    default:
      return null;
  }
}
