/**
 * Domain error codes. PERMISSION_DENIED and RATE_LIMITED stay out until a real
 * adapter can raise them; the rest are reachable from the 0.1 prototype,
 * including the cross-window protocol (UNAVAILABLE / TIMEOUT / INTERNAL).
 */
export type ErrorCode =
  | 'NOT_FOUND'
  | 'BUSY'
  | 'VALIDATION'
  | 'DISPOSED'
  | 'CONFLICT'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'INTERNAL';

export class ClientError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    /** Machine-readable context for the UI, e.g. both versions on a conflict. */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ClientError';
  }
}
