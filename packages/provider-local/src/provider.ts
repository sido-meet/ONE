import { ClientError } from '../../contracts/src/index.ts';
import {
  assertValidRange,
  parseCalendarCreate,
  parseCalendarDelete,
  parseCalendarList,
  parseCalendarUpdate,
  parseNotesCreate,
  parseNotesDelete,
  parseNotesGet,
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
import { createJsonStore } from './store.ts';

interface AuditEntry {
  auditRef: string;
  entityType: DeleteResult['entityType'];
  id: string;
  workspaceId: string;
  deletedAt: string;
}

/**
 * 本地文件提供方（ADR-016 的第一个真实实现）。
 *
 * 它是**本体之外的独立进程**，只做两件事：把自己的数据存在自己的目录里，
 * 以及按本体转过来的请求读写这些数据。它没有会话、没有权限裁决、没有密钥 ——
 * 那些一律留在本体与可信主机侧（ADR-016 第 1、5 点）。
 *
 * 注意这里**又**调了一遍 parseXxx：本体已经在边界校验过一次。之所以重复，
 * 是因为提供方是不共享本体类型系统的另一个进程，帧上的东西对它就是 unknown。
 * 重复校验不是疏忽，是信任边界：本体校验是为了护住本体，提供方校验是为了
 * 护住自己的文件。
 */

export interface LocalData {
  notes: Note[];
  calendarEvents: CalendarEvent[];
  audits: AuditEntry[];
  /** 幂等回执也要落盘：否则本体重启后重复确认会建出第二条日程。 */
  receipts: Record<string, { digest: string; result: unknown }>;
}

const EMPTY: LocalData = {
  notes: [],
  calendarEvents: [],
  audits: [],
  receipts: {},
};

export interface LocalProvider {
  kind: 'calendar' | 'notes';
  list(context: CommandContext, input: unknown): Promise<unknown>;
  /** 只有笔记有。日历的列表返回的就是完整实体，不需要再取一次。 */
  get?(context: CommandContext, input: unknown): Promise<unknown>;
  create(context: CommandContext, input: unknown): Promise<unknown>;
  update(context: CommandContext, input: unknown): Promise<unknown>;
  remove(context: CommandContext, input: unknown): Promise<unknown>;
}

export function createLocalProvider(
  file: string,
  kind: 'calendar' | 'notes',
): LocalProvider {
  const store = createJsonStore<LocalData>(file, EMPTY);
  // 进程内留一份，写入时才落盘：一次创建只写一次文件。
  let data = store.read();

  const persist = () => store.write(data);

  const replay = <T>(
    workspaceId: string,
    idempotencyKey: string,
    digest: string,
  ): T | undefined => {
    const receipt = data.receipts[`${workspaceId}:${idempotencyKey}`];
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
    data.receipts[`${workspaceId}:${idempotencyKey}`] = {
      digest,
      result: structuredClone(result),
    };
  };

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

  const inWorkspace = <T extends { workspaceId: string }>(
    items: T[],
    context: CommandContext,
  ) => items.filter((item) => item.workspaceId === context.workspaceId);

  if (kind === 'calendar') {
    const find = (context: CommandContext, id: string) => {
      const found = data.calendarEvents.find(
        (item) => item.id === id && item.workspaceId === context.workspaceId,
      );
      if (!found) throw new ClientError('NOT_FOUND', '找不到这个日程');
      return found;
    };
    return {
      kind,
      async list(context, input) {
        const parsed = parseCalendarList(input);
        const start = Date.parse(parsed.rangeStart);
        const end = Date.parse(parsed.rangeEnd);
        const items = inWorkspace(data.calendarEvents, context)
          .filter(
            (item) =>
              Date.parse(item.startsAt) < end &&
              Date.parse(item.endsAt) > start,
          )
          .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
          .map((item) => structuredClone(item));
        return paginate(
          items,
          parsed.cursor,
          parsed.limit,
        ) satisfies CalendarPage;
      },
      async create(context, input) {
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
          ...(parsed.sourceConversationId
            ? { sourceConversationId: parsed.sourceConversationId }
            : {}),
        };
        data.calendarEvents.push(event);
        remember(context.workspaceId, parsed.idempotencyKey, digest, event);
        persist();
        return structuredClone(event);
      },
      async update(context, input) {
        const parsed = parseCalendarUpdate(input);
        const digest = requestDigest(parsed);
        const replayed = replay<CalendarEvent>(
          context.workspaceId,
          parsed.idempotencyKey,
          digest,
        );
        if (replayed) return replayed;
        const current = find(context, parsed.id);
        guardVersion(current, parsed.expectedVersion, '日程');
        assertValidRange(
          parsed.patch.startsAt ?? current.startsAt,
          parsed.patch.endsAt ?? current.endsAt,
        );
        Object.assign(current, parsed.patch);
        current.version += 1;
        remember(context.workspaceId, parsed.idempotencyKey, digest, current);
        persist();
        return structuredClone(current);
      },
      async remove(context, input) {
        const parsed = parseCalendarDelete(input);
        const digest = requestDigest(parsed);
        const replayed = replay<DeleteResult>(
          context.workspaceId,
          parsed.idempotencyKey,
          digest,
        );
        if (replayed) return replayed;
        const current = find(context, parsed.id);
        guardVersion(current, parsed.expectedVersion, '日程');
        data.calendarEvents.splice(data.calendarEvents.indexOf(current), 1);
        const deletedAt = new Date().toISOString();
        const auditRef = crypto.randomUUID();
        data.audits.push({
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
        persist();
        return structuredClone(result);
      },
    };
  }

  const findNote = (context: CommandContext, id: string) => {
    const found = data.notes.find(
      (item) => item.id === id && item.workspaceId === context.workspaceId,
    );
    if (!found) throw new ClientError('NOT_FOUND', '找不到这条笔记');
    return found;
  };

  return {
    kind,
    /**
     * 取全文。编辑之前必须先读 —— 列表只给摘要，正文不在里面。
     * 读操作不写盘，因此没有幂等回执可言。
     */
    async get(context, input) {
      const parsed = parseNotesGet(input);
      return structuredClone(findNote(context, parsed.id));
    },
    async list(context, input) {
      const parsed = parseNotesList(input);
      const keyword = parsed.query?.toLowerCase();
      const summaries: NoteSummary[] = inWorkspace(data.notes, context)
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
      return paginate(
        summaries,
        parsed.cursor,
        parsed.limit,
      ) satisfies NotePage;
    },
    async create(context, input) {
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
        ...(parsed.sourceConversationId
          ? { sourceConversationId: parsed.sourceConversationId }
          : {}),
      };
      data.notes.push(note);
      remember(context.workspaceId, parsed.idempotencyKey, digest, note);
      persist();
      return structuredClone(note);
    },
    async update(context, input) {
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
      persist();
      return structuredClone(current);
    },
    async remove(context, input) {
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
      data.notes.splice(data.notes.indexOf(current), 1);
      const deletedAt = new Date().toISOString();
      const auditRef = crypto.randomUUID();
      data.audits.push({
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
      persist();
      return structuredClone(result);
    },
  };
}
