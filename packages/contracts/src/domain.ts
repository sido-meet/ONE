import { ClientError } from './errors.ts';

/** Calendar and Notes domain contracts (docs/04). */

export interface Note {
  id: string;
  workspaceId: string;
  title: string;
  body: string;
  version: number;
  sourceConversationId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEvent {
  id: string;
  workspaceId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  version: number;
  sourceConversationId?: string;
}

/** Commands are marked at the trusted boundary; client-reported rights are ignored. */
export type CommandSource = 'ui' | 'agent';
export interface CommandContext {
  requestId: string;
  workspaceId: string;
  source: CommandSource;
  runId?: string;
}

export interface CalendarCreateInput {
  title: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  sourceConversationId?: string;
  idempotencyKey: string;
}

export interface CalendarUpdateInput {
  id: string;
  expectedVersion: number;
  patch: {
    title?: string;
    startsAt?: string;
    endsAt?: string;
    timeZone?: string;
  };
  idempotencyKey: string;
}

export interface CalendarDeleteInput {
  id: string;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface CalendarListInput {
  rangeStart: string;
  rangeEnd: string;
  timeZone: string;
  cursor?: string;
  limit?: number;
}

export interface NotesCreateInput {
  title: string;
  body: string;
  sourceConversationId?: string;
  idempotencyKey: string;
}

export interface NotesUpdateInput {
  id: string;
  expectedVersion: number;
  patch: { title?: string; body?: string };
  idempotencyKey: string;
}

export interface NotesDeleteInput {
  id: string;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface NotesListInput {
  query?: string;
  cursor?: string;
  limit?: number;
}

/** Notes list returns summaries only; bodies load through notesGet in later rounds. */
export interface NoteSummary {
  id: string;
  title: string;
  version: number;
  sourceConversationId?: string;
  updatedAt: string;
}
export interface NotePage {
  items: NoteSummary[];
  nextCursor?: string;
}
export interface CalendarPage {
  items: CalendarEvent[];
  nextCursor?: string;
}
export interface DeleteResult {
  entityType: 'note' | 'calendarEvent';
  id: string;
  auditRef: string;
  deletedAt: string;
}

/** Parsed list input always carries a limit, so callers never re-default it. */
export type NormalizedCalendarListInput = CalendarListInput & { limit: number };
export type NormalizedNotesListInput = NotesListInput & { limit: number };

const LIMITS = {
  title: 200,
  body: 20000,
  idempotencyKey: 128,
  id: 128,
  cursor: 64,
  limitMax: 100,
  limitDefault: 20,
} as const;

/** Instant with an explicit offset; a bare local time would hide the user's zone. */
const RFC3339_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function fail(message: string, details?: Record<string, unknown>): never {
  throw new ClientError('VALIDATION', message, details);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(`${name} 必须是一个对象`);
  return value as Record<string, unknown>;
}

/** Unknown keys are rejected so a typo cannot be silently ignored at the boundary. */
function shape(
  value: unknown,
  name: string,
  allowed: readonly string[],
): Record<string, unknown> {
  const input = object(value, name);
  for (const key of Object.keys(input))
    if (!allowed.includes(key)) fail(`${name} 不支持的字段：${key}`);
  return input;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') fail(`${name} 必须是文本`);
  const trimmed = value.trim();
  if (!trimmed) fail(`${name} 不能为空`);
  if (trimmed.length > max) fail(`${name} 最多 ${max} 个字符`);
  return trimmed;
}

function longText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') fail(`${name} 必须是文本`);
  if (value.length > max) fail(`${name} 最多 ${max} 个字符`);
  return value;
}

function optionalRef(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return text(value, name, LIMITS.id);
}

function instant(value: unknown, name: string): string {
  const raw = text(value, name, 64);
  if (!RFC3339_OFFSET.test(raw) || !Number.isFinite(Date.parse(raw)))
    fail(
      `${name} 需要带时区偏移的 RFC3339 时间，例如 2026-10-07T15:00:00+08:00`,
    );
  return raw;
}

function timeZone(value: unknown): string {
  const raw = text(value, '时区', 64);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
  } catch {
    return fail('时区必须是有效的 IANA 名称，例如 Asia/Shanghai');
  }
  return raw;
}

function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    fail('expectedVersion 必须是正整数');
  return value;
}

function idempotencyKey(value: unknown): string {
  return text(value, '幂等键', LIMITS.idempotencyKey);
}

function paging(input: Record<string, unknown>): {
  cursor?: string;
  limit: number;
} {
  const limit = input.limit === undefined ? LIMITS.limitDefault : input.limit;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > LIMITS.limitMax
  )
    fail(`limit 必须是 1–${LIMITS.limitMax} 的整数`);
  if (input.cursor !== undefined) {
    const cursor = text(input.cursor, '游标', LIMITS.cursor);
    if (!/^\d+$/.test(cursor)) fail('游标格式不正确');
    return { cursor, limit };
  }
  return { limit };
}

/** Exported so the same range rule applies to updates and to IPC input alike. */
export function assertValidRange(startsAt: string, endsAt: string): void {
  if (Date.parse(endsAt) <= Date.parse(startsAt))
    fail('结束时间必须晚于开始时间');
}

export function parseCalendarCreate(input: unknown): CalendarCreateInput {
  const raw = shape(input, '日程', [
    'title',
    'startsAt',
    'endsAt',
    'timeZone',
    'sourceConversationId',
    'idempotencyKey',
  ]);
  const parsed = {
    title: text(raw.title, '标题', LIMITS.title),
    startsAt: instant(raw.startsAt, '开始时间'),
    endsAt: instant(raw.endsAt, '结束时间'),
    timeZone: timeZone(raw.timeZone),
    idempotencyKey: idempotencyKey(raw.idempotencyKey),
  };
  assertValidRange(parsed.startsAt, parsed.endsAt);
  const sourceConversationId = optionalRef(
    raw.sourceConversationId,
    '来源对话',
  );
  return sourceConversationId ? { ...parsed, sourceConversationId } : parsed;
}

export function parseCalendarUpdate(input: unknown): CalendarUpdateInput {
  const raw = shape(input, '日程修改', [
    'id',
    'expectedVersion',
    'patch',
    'idempotencyKey',
  ]);
  const patch = shape(raw.patch, '日程修改内容', [
    'title',
    'startsAt',
    'endsAt',
    'timeZone',
  ]);
  const fields: CalendarUpdateInput['patch'] = {};
  if (patch.title !== undefined)
    fields.title = text(patch.title, '标题', LIMITS.title);
  if (patch.startsAt !== undefined)
    fields.startsAt = instant(patch.startsAt, '开始时间');
  if (patch.endsAt !== undefined)
    fields.endsAt = instant(patch.endsAt, '结束时间');
  if (patch.timeZone !== undefined) fields.timeZone = timeZone(patch.timeZone);
  if (!Object.keys(fields).length) fail('至少要修改一个字段');
  return {
    id: text(raw.id, '日程 ID', LIMITS.id),
    expectedVersion: version(raw.expectedVersion),
    patch: fields,
    idempotencyKey: idempotencyKey(raw.idempotencyKey),
  };
}

export function parseCalendarDelete(input: unknown): CalendarDeleteInput {
  const raw = shape(input, '日程删除', [
    'id',
    'expectedVersion',
    'idempotencyKey',
  ]);
  return {
    id: text(raw.id, '日程 ID', LIMITS.id),
    expectedVersion: version(raw.expectedVersion),
    idempotencyKey: idempotencyKey(raw.idempotencyKey),
  };
}

export function parseCalendarList(input: unknown): NormalizedCalendarListInput {
  const raw = shape(input, '日程查询', [
    'rangeStart',
    'rangeEnd',
    'timeZone',
    'cursor',
    'limit',
  ]);
  const rangeStart = instant(raw.rangeStart, '范围开始');
  const rangeEnd = instant(raw.rangeEnd, '范围结束');
  assertValidRange(rangeStart, rangeEnd);
  return {
    rangeStart,
    rangeEnd,
    timeZone: timeZone(raw.timeZone),
    ...paging(raw),
  };
}

export function parseNotesCreate(input: unknown): NotesCreateInput {
  const raw = shape(input, '笔记', [
    'title',
    'body',
    'sourceConversationId',
    'idempotencyKey',
  ]);
  const parsed = {
    title: text(raw.title, '标题', LIMITS.title),
    body: longText(raw.body ?? '', '正文', LIMITS.body),
    idempotencyKey: idempotencyKey(raw.idempotencyKey),
  };
  const sourceConversationId = optionalRef(
    raw.sourceConversationId,
    '来源对话',
  );
  return sourceConversationId ? { ...parsed, sourceConversationId } : parsed;
}

export function parseNotesUpdate(input: unknown): NotesUpdateInput {
  const raw = shape(input, '笔记修改', [
    'id',
    'expectedVersion',
    'patch',
    'idempotencyKey',
  ]);
  const patch = shape(raw.patch, '笔记修改内容', ['title', 'body']);
  const fields: NotesUpdateInput['patch'] = {};
  if (patch.title !== undefined)
    fields.title = text(patch.title, '标题', LIMITS.title);
  if (patch.body !== undefined)
    fields.body = longText(patch.body, '正文', LIMITS.body);
  if (!Object.keys(fields).length) fail('至少要修改一个字段');
  return {
    id: text(raw.id, '笔记 ID', LIMITS.id),
    expectedVersion: version(raw.expectedVersion),
    patch: fields,
    idempotencyKey: idempotencyKey(raw.idempotencyKey),
  };
}

export function parseNotesDelete(input: unknown): NotesDeleteInput {
  const raw = shape(input, '笔记删除', [
    'id',
    'expectedVersion',
    'idempotencyKey',
  ]);
  return {
    id: text(raw.id, '笔记 ID', LIMITS.id),
    expectedVersion: version(raw.expectedVersion),
    idempotencyKey: idempotencyKey(raw.idempotencyKey),
  };
}

export function parseNotesList(input: unknown): NormalizedNotesListInput {
  const raw = shape(input, '笔记查询', ['query', 'cursor', 'limit']);
  const query =
    raw.query === undefined ? undefined : text(raw.query, '关键词', 200);
  return query === undefined ? paging(raw) : { query, ...paging(raw) };
}

/**
 * Stable fingerprint of a parsed command. Reusing a key with a different input is
 * a caller bug, not a retry, so the store rejects it instead of overwriting.
 */
export function requestDigest(input: unknown): string {
  return JSON.stringify(input);
}
