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

/**
 * `details` 里的东西要跨进程送到上游，但它是**报错的一方自己写的**，不能照单全收。
 *
 * 这里只放行扁平的基本类型，键数与长度都有上限，其余一律丢掉：丢掉只是少一条
 * 附加信息，而带过去一个自己长出来的东西，是让对方的界面去显示它没准备过的内容。
 */
export function portableDetails(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).slice(0, 8)) {
    const item = (value as Record<string, unknown>)[key];
    if (typeof item === 'number' && Number.isFinite(item))
      out[key.slice(0, 32)] = item;
    else if (typeof item === 'boolean') out[key.slice(0, 32)] = item;
    else if (typeof item === 'string')
      out[key.slice(0, 32)] = item.slice(0, 200);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
