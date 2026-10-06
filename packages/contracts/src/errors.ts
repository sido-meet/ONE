/**
 * Domain error codes. RATE_LIMITED stays out until a real adapter can raise it;
 * the rest are reachable, including the cross-window protocol
 * (UNAVAILABLE / TIMEOUT / INTERNAL).
 *
 * PERMISSION_DENIED arrived with the provider ports (ADR-016): an installed
 * provider that the user has not authorized must not collapse into the same
 * message as "no calendar source is set up".
 */
export type ErrorCode =
  | 'NOT_FOUND'
  | 'BUSY'
  | 'VALIDATION'
  | 'DISPOSED'
  | 'CONFLICT'
  | 'UNAVAILABLE'
  | 'PERMISSION_DENIED'
  | 'TIMEOUT'
  | 'INTERNAL';

const ERROR_CODES: ErrorCode[] = [
  'NOT_FOUND',
  'BUSY',
  'VALIDATION',
  'DISPOSED',
  'CONFLICT',
  'UNAVAILABLE',
  'PERMISSION_DENIED',
  'TIMEOUT',
  'INTERNAL',
];

/** Untrusted input: a code that is not one of ours is no code at all. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODES.includes(value as ErrorCode);
}

export class ClientError extends Error {
  readonly code: ErrorCode;
  /** Machine-readable context for the UI, e.g. both versions on a conflict. */
  readonly details?: Record<string, unknown>;

  // Plain fields instead of constructor parameter properties: the core process
  // runs on Node's strip-only TypeScript support, which rejects that syntax.
  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ClientError';
    this.code = code;
    this.details = details;
  }
}
