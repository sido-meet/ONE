/**
 * Domain error codes. Real adapters still need PERMISSION_DENIED, UNAVAILABLE,
 * TIMEOUT and RATE_LIMITED (docs/04); 0.1 only models what the mock can hit.
 */
export type ErrorCode =
  'NOT_FOUND' | 'BUSY' | 'VALIDATION' | 'DISPOSED' | 'CONFLICT';

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
