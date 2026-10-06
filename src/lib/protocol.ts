import type { ErrorCode, Snapshot } from '../../packages/contracts/src';

/**
 * Window protocol for the 0.1 prototype (docs/03). The main window keeps the
 * authoritative client alive; pet and bubble windows never own state, they send
 * commands and render whatever snapshot arrives last.
 */
export const HOST_COMMAND = 'one:command';
export const HOST_RESULT = 'one:result';
export const HOST_SNAPSHOT = 'one:snapshot';
export const HOST_HELLO = 'one:hello';
export const HOST_GOODBYE = 'one:goodbye';
export const HOST_BEFORE_QUIT = 'one:before-quit';
export const PET_MENU = 'one:pet-menu';

/** Only these names may cross the window boundary; the host drops anything else. */
export const COMMAND_NAMES = [
  'createConversation',
  'changeAgent',
  'sendMessage',
  'cancelRun',
  'calendarList',
  'calendarCreate',
  'calendarUpdate',
  'calendarDelete',
  'notesList',
  'notesCreate',
  'notesUpdate',
  'notesDelete',
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export interface CommandEnvelope {
  requestId: string;
  name: CommandName;
  args: unknown[];
}
export interface ResultEnvelope {
  requestId: string;
  ok: boolean;
  value?: unknown;
  error?: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}
export interface SnapshotEnvelope {
  revision: number;
  snapshot: Snapshot;
}

export const REQUEST_TIMEOUT_MS = 8000;
export const HELLO_RETRY_MS = 1200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function isCommandName(value: unknown): value is CommandName {
  return (
    typeof value === 'string' &&
    (COMMAND_NAMES as readonly string[]).includes(value)
  );
}

/** Untrusted input: malformed envelopes are dropped, never partially applied. */
export function parseCommandEnvelope(value: unknown): CommandEnvelope | null {
  if (!isRecord(value)) return null;
  const { requestId, name, args } = value;
  if (typeof requestId !== 'string' || !requestId) return null;
  if (!isCommandName(name)) return null;
  if (!Array.isArray(args)) return null;
  return { requestId, name, args };
}

export function parseResultEnvelope(value: unknown): ResultEnvelope | null {
  if (!isRecord(value)) return null;
  const { requestId, ok } = value;
  if (typeof requestId !== 'string' || !requestId) return null;
  if (typeof ok !== 'boolean') return null;
  if (ok) return { requestId, ok: true, value: value.value };
  const error = isRecord(value.error) ? value.error : null;
  if (
    !error ||
    typeof error.code !== 'string' ||
    typeof error.message !== 'string'
  )
    return null;
  return {
    requestId,
    ok: false,
    error: {
      code: error.code as ErrorCode,
      message: error.message,
      ...(isRecord(error.details)
        ? { details: error.details as Record<string, unknown> }
        : {}),
    },
  };
}

export function parseSnapshotEnvelope(value: unknown): SnapshotEnvelope | null {
  if (!isRecord(value)) return null;
  const { revision, snapshot } = value;
  if (typeof revision !== 'number' || !Number.isInteger(revision)) return null;
  if (!isRecord(snapshot)) return null;
  if (!Array.isArray(snapshot.conversations) || !Array.isArray(snapshot.runs))
    return null;
  // The proxy is a renderer, not a trusted host: check what it will actually read.
  return { revision, snapshot: snapshot as unknown as Snapshot };
}
