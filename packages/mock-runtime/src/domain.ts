import { ClientError } from '../../contracts/src/index.ts';
import {
  assertValidRange,
  parseCalendarCreate,
  parseCalendarDelete,
  parseCalendarList,
  parseCalendarUpdate,
  parseNotesCreate,
  parseNotesDelete,
  parseNotesList,
  parseNotesUpdate,
  requestDigest,
} from '../../contracts/src/index.ts';
import type {
  CalendarEvent,
  CalendarPage,
  CommandContext,
  DeleteResult,
  Note,
  NotePage,
  NoteSummary,
} from '../../contracts/src/index.ts';

export interface AuditEntry {
  auditRef: string;
  entityType: DeleteResult['entityType'];
  id: string;
  workspaceId: string;
  deletedAt: string;
}

export interface DomainState {
  notes: Note[];
  calendarEvents: CalendarEvent[];
  audits: AuditEntry[];
}

export interface DomainHooks {
  notify(): void;
  assertOpen(): void;
}

export interface DomainCommands {
  calendarList(context: CommandContext, input: unknown): Promise<CalendarPage>;
  calendarCreate(
    context: CommandContext,
    input: unknown,
  ): Promise<CalendarEvent>;
  calendarUpdate(
    context: CommandContext,
    input: unknown,
  ): Promise<CalendarEvent>;
  calendarDelete(
    context: CommandContext,
    input: unknown,
  ): Promise<DeleteResult>;
  notesList(context: CommandContext, input: unknown): Promise<NotePage>;
  notesCreate(context: CommandContext, input: unknown): Promise<Note>;
  notesUpdate(context: CommandContext, input: unknown): Promise<Note>;
  notesDelete(context: CommandContext, input: unknown): Promise<DeleteResult>;
}

export function createDomainState(): DomainState {
  return { notes: [], calendarEvents: [], audits: [] };
}

/**
 * Prototype domain service. Calendar and Notes are mutable entities, not an
 * append-only stream: `version` guards concurrent edits and an idempotency
 * receipt makes a repeated confirmation harmless. Nothing here is persisted.
 */
export function createDomainCommands(
  state: DomainState,
  hooks: DomainHooks,
): DomainCommands {
  const receipts = new Map<string, { digest: string; result: unknown }>();

  const replay = <T>(
    workspaceId: string,
    idempotencyKey: string,
    digest: string,
  ): T | undefined => {
    const receipt = receipts.get(`${workspaceId}:${idempotencyKey}`);
    if (!receipt) return undefined;
    if (receipt.digest !== digest)
      throw new ClientError('CONFLICT', '这个幂等键已经用于另一个请求', {
        idempotencyKey,
      });
    return structuredClone(receipt.result) as T;
  };

  const remember = (
    workspaceId: string,
    idempotencyKey: string,
    digest: string,
    result: unknown,
  ) => {
    receipts.set(`${workspaceId}:${idempotencyKey}`, {
      digest,
      result: structuredClone(result),
    });
  };

  const findEvent = (context: CommandContext, id: string) => {
    const found = state.calendarEvents.find(
      (item) => item.id === id && item.workspaceId === context.workspaceId,
    );
    if (!found) throw new ClientError('NOT_FOUND', '找不到这个日程');
    return found;
  };

  const findNote = (context: CommandContext, id: string) => {
    const found = state.notes.find(
      (item) => item.id === id && item.workspaceId === context.workspaceId,
    );
    if (!found) throw new ClientError('NOT_FOUND', '找不到这条笔记');
    return found;
  };

  /** A stale writer keeps its own draft; it must not overwrite the newer version. */
  const guardVersion = (
    current: { version: number },
    expectedVersion: number,
    label: string,
  ) => {
    if (current.version !== expectedVersion)
      throw new ClientError('CONFLICT', `${label}已被其他操作更新`, {
        expectedVersion,
        currentVersion: current.version,
      });
  };

  const paginate = <T>(
    items: T[],
    cursor: string | undefined,
    limit: number,
  ): { items: T[]; nextCursor?: string } => {
    const start = cursor ? Number(cursor) : 0;
    const slice = items.slice(start, start + limit);
    const next = start + slice.length;
    return next < items.length
      ? { items: slice, nextCursor: String(next) }
      : { items: slice };
  };

  return {
    async calendarList(context, input) {
      hooks.assertOpen();
      const parsed = parseCalendarList(input);
      const start = Date.parse(parsed.rangeStart);
      const end = Date.parse(parsed.rangeEnd);
      const items = state.calendarEvents
        .filter((item) => item.workspaceId === context.workspaceId)
        .filter(
          (item) =>
            Date.parse(item.startsAt) < end && Date.parse(item.endsAt) > start,
        )
        .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
        .map((item) => structuredClone(item));
      return paginate(items, parsed.cursor, parsed.limit);
    },

    async calendarCreate(context, input) {
      hooks.assertOpen();
      const parsed = parseCalendarCreate(input);
      const digest = requestDigest(parsed);
      const replayed = replay<CalendarEvent>(
        context.workspaceId,
        parsed.idempotencyKey,
        digest,
      );
      if (replayed) return replayed;
      const event: CalendarEvent = {
        id: crypto.randomUUID(),
        workspaceId: context.workspaceId,
        title: parsed.title,
        startsAt: parsed.startsAt,
        endsAt: parsed.endsAt,
        timeZone: parsed.timeZone,
        version: 1,
      };
      if (parsed.sourceConversationId)
        event.sourceConversationId = parsed.sourceConversationId;
      state.calendarEvents.push(event);
      remember(context.workspaceId, parsed.idempotencyKey, digest, event);
      hooks.notify();
      return structuredClone(event);
    },

    async calendarUpdate(context, input) {
      hooks.assertOpen();
      const parsed = parseCalendarUpdate(input);
      const digest = requestDigest(parsed);
      const replayed = replay<CalendarEvent>(
        context.workspaceId,
        parsed.idempotencyKey,
        digest,
      );
      if (replayed) return replayed;
      const current = findEvent(context, parsed.id);
      guardVersion(current, parsed.expectedVersion, '日程');
      assertValidRange(
        parsed.patch.startsAt ?? current.startsAt,
        parsed.patch.endsAt ?? current.endsAt,
      );
      Object.assign(current, parsed.patch);
      current.version += 1;
      remember(context.workspaceId, parsed.idempotencyKey, digest, current);
      hooks.notify();
      return structuredClone(current);
    },

    async calendarDelete(context, input) {
      hooks.assertOpen();
      const parsed = parseCalendarDelete(input);
      const digest = requestDigest(parsed);
      const replayed = replay<DeleteResult>(
        context.workspaceId,
        parsed.idempotencyKey,
        digest,
      );
      if (replayed) return replayed;
      const current = findEvent(context, parsed.id);
      guardVersion(current, parsed.expectedVersion, '日程');
      const index = state.calendarEvents.indexOf(current);
      state.calendarEvents.splice(index, 1);
      const deletedAt = new Date().toISOString();
      const auditRef = crypto.randomUUID();
      state.audits.push({
        auditRef,
        entityType: 'calendarEvent',
        id: parsed.id,
        workspaceId: context.workspaceId,
        deletedAt,
      });
      const result: DeleteResult = {
        entityType: 'calendarEvent',
        id: parsed.id,
        auditRef,
        deletedAt,
      };
      remember(context.workspaceId, parsed.idempotencyKey, digest, result);
      hooks.notify();
      return structuredClone(result);
    },

    async notesList(context, input) {
      hooks.assertOpen();
      const parsed = parseNotesList(input);
      const keyword = parsed.query?.toLowerCase();
      const summaries: NoteSummary[] = state.notes
        .filter((note) => note.workspaceId === context.workspaceId)
        .filter(
          (note) =>
            !keyword ||
            note.title.toLowerCase().includes(keyword) ||
            note.body.toLowerCase().includes(keyword),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((note) => ({
          id: note.id,
          title: note.title,
          version: note.version,
          updatedAt: note.updatedAt,
          ...(note.sourceConversationId
            ? { sourceConversationId: note.sourceConversationId }
            : {}),
        }));
      return paginate(summaries, parsed.cursor, parsed.limit);
    },

    async notesCreate(context, input) {
      hooks.assertOpen();
      const parsed = parseNotesCreate(input);
      const digest = requestDigest(parsed);
      const replayed = replay<Note>(
        context.workspaceId,
        parsed.idempotencyKey,
        digest,
      );
      if (replayed) return replayed;
      const now = new Date().toISOString();
      const note: Note = {
        id: crypto.randomUUID(),
        workspaceId: context.workspaceId,
        title: parsed.title,
        body: parsed.body,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      if (parsed.sourceConversationId)
        note.sourceConversationId = parsed.sourceConversationId;
      state.notes.push(note);
      remember(context.workspaceId, parsed.idempotencyKey, digest, note);
      hooks.notify();
      return structuredClone(note);
    },

    async notesUpdate(context, input) {
      hooks.assertOpen();
      const parsed = parseNotesUpdate(input);
      const digest = requestDigest(parsed);
      const replayed = replay<Note>(
        context.workspaceId,
        parsed.idempotencyKey,
        digest,
      );
      if (replayed) return replayed;
      const current = findNote(context, parsed.id);
      guardVersion(current, parsed.expectedVersion, '笔记');
      Object.assign(current, parsed.patch);
      current.version += 1;
      current.updatedAt = new Date().toISOString();
      remember(context.workspaceId, parsed.idempotencyKey, digest, current);
      hooks.notify();
      return structuredClone(current);
    },

    async notesDelete(context, input) {
      hooks.assertOpen();
      const parsed = parseNotesDelete(input);
      const digest = requestDigest(parsed);
      const replayed = replay<DeleteResult>(
        context.workspaceId,
        parsed.idempotencyKey,
        digest,
      );
      if (replayed) return replayed;
      const current = findNote(context, parsed.id);
      guardVersion(current, parsed.expectedVersion, '笔记');
      state.notes.splice(state.notes.indexOf(current), 1);
      const deletedAt = new Date().toISOString();
      const auditRef = crypto.randomUUID();
      state.audits.push({
        auditRef,
        entityType: 'note',
        id: parsed.id,
        workspaceId: context.workspaceId,
        deletedAt,
      });
      const result: DeleteResult = {
        entityType: 'note',
        id: parsed.id,
        auditRef,
        deletedAt,
      };
      remember(context.workspaceId, parsed.idempotencyKey, digest, result);
      hooks.notify();
      return structuredClone(result);
    },
  };
}
