import type { DatabaseSync } from 'node:sqlite';
import { ClientError } from '../../contracts/src/index.ts';
import type {
  CalendarEvent,
  CalendarPage,
  CommandContext,
  DeleteResult,
  Note,
  NotePage,
  NoteSummary,
} from '../../contracts/src/index.ts';
import { transaction } from './db.ts';

/**
 * 日历与笔记的 SQL 仓储（R01）。
 *
 * 与 0.1 的最大差别不在「存哪儿」，在**两条以前靠应用层自觉的规则，现在由数据库保证**：
 *
 * 1. **版本守卫是一条语句，不是一次比较。** `UPDATE … WHERE version = ?` 改不动就是
 *    零行 —— 哪怕两个人在同一毫秒读到同一个版本号，第二个人的 `WHERE` 也一定落空。
 *    以前是「读出来比一比」，那一步和应用下一步之间有缝，缝里就是覆盖。
 *
 * 2. **幂等回执的主键就是那把键。** 同键不同内容不再靠「先查后写」，第二次插入
 *    直接撞唯一约束。查还是留着（要给出可读的冲突话术），约束是最后一道闸。
 *
 * 回执与实体写在**同一个事务**里：只写了一半的话，要么两边都在，要么两边都不在。
 */

interface Row {
  [column: string]: string | number | null;
}

const text = (row: Row, column: string): string => String(row[column]);
const optional = (row: Row, column: string): string | undefined => {
  const value = row[column];
  return value === null || value === undefined ? undefined : String(value);
};

const noteOf = (row: Row): Note => ({
  id: text(row, 'id'),
  workspaceId: text(row, 'workspace_id'),
  title: text(row, 'title'),
  body: text(row, 'body'),
  version: Number(row['version']),
  ...(optional(row, 'source_conversation_id')
    ? { sourceConversationId: optional(row, 'source_conversation_id')! }
    : {}),
  createdAt: text(row, 'created_at'),
  updatedAt: text(row, 'updated_at'),
});

const summaryOf = (row: Row): NoteSummary => ({
  id: text(row, 'id'),
  title: text(row, 'title'),
  version: Number(row['version']),
  ...(optional(row, 'source_conversation_id')
    ? { sourceConversationId: optional(row, 'source_conversation_id')! }
    : {}),
  updatedAt: text(row, 'updated_at'),
});

const eventOf = (row: Row): CalendarEvent => ({
  id: text(row, 'id'),
  workspaceId: text(row, 'workspace_id'),
  title: text(row, 'title'),
  startsAt: text(row, 'starts_at'),
  endsAt: text(row, 'ends_at'),
  timeZone: text(row, 'time_zone'),
  version: Number(row['version']),
  ...(optional(row, 'source_conversation_id')
    ? { sourceConversationId: optional(row, 'source_conversation_id')! }
    : {}),
});

export interface Repository {
  listEvents(
    context: CommandContext,
    range: { start: string; end: string },
    page: { cursor?: string; limit: number },
  ): CalendarPage;
  createEvent(
    context: CommandContext,
    input: {
      title: string;
      startsAt: string;
      endsAt: string;
      timeZone: string;
      sourceConversationId?: string;
    },
    idempotency: { key: string; digest: string },
  ): CalendarEvent;
  updateEvent(
    context: CommandContext,
    input: { id: string; expectedVersion: number },
    patch: Partial<
      Pick<CalendarEvent, 'title' | 'startsAt' | 'endsAt' | 'timeZone'>
    >,
    /**
     * 写之前看一眼合并后的样子，抛得出异常就整笔回滚。
     *
     * 它必须是回调而不是「调用方自己先读一遍再判」：读和写在同一个事务里才是原子的，
     * 分成两步就是把那道缝又留回去了 —— 这正是 R01 要消掉的东西。
     */
    validate: (merged: CalendarEvent) => void,
    idempotency: { key: string; digest: string },
  ): CalendarEvent;
  removeEvent(
    context: CommandContext,
    input: { id: string; expectedVersion: number },
    idempotency: { key: string; digest: string },
  ): DeleteResult;

  getNote(context: CommandContext, id: string): Note;
  listNotes(
    context: CommandContext,
    filter: { query?: string },
    page: { cursor?: string; limit: number },
  ): NotePage;
  createNote(
    context: CommandContext,
    input: { title: string; body: string; sourceConversationId?: string },
    idempotency: { key: string; digest: string },
  ): Note;
  updateNote(
    context: CommandContext,
    input: { id: string; expectedVersion: number },
    patch: Partial<Pick<Note, 'title' | 'body'>>,
    idempotency: { key: string; digest: string },
  ): Note;
  removeNote(
    context: CommandContext,
    input: { id: string; expectedVersion: number },
    idempotency: { key: string; digest: string },
  ): DeleteResult;
}

/** 游标是契约校验过的纯数字串（`/^\d+$/`），这里只把它翻成 OFFSET。 */
const offsetOf = (cursor: string | undefined): number =>
  cursor === undefined ? 0 : Number.parseInt(cursor, 10);

export function createRepository(db: DatabaseSync): Repository {
  const selectEventById = db.prepare(
    'SELECT * FROM calendar_events WHERE id = ? AND workspace_id = ?',
  );
  const selectNoteById = db.prepare(
    'SELECT * FROM notes WHERE id = ? AND workspace_id = ?',
  );
  const selectReceipt = db.prepare(
    'SELECT digest, result FROM command_receipts WHERE workspace_id = ? AND idempotency_key = ?',
  );
  const insertReceipt = db.prepare(
    `INSERT INTO command_receipts (workspace_id, idempotency_key, digest, result, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertAudit = db.prepare(
    `INSERT INTO audit_entries (audit_ref, entity_type, id, workspace_id, deleted_at)
     VALUES (?, ?, ?, ?, ?)`,
  );

  /**
   * 取回一次已经做过的同键请求。同键不同内容 → CONFLICT，这句话要让用户看懂
   * 「不是重试就能过」，所以给的是幂等键本身。
   */
  const replay = <T>(
    workspaceId: string,
    key: string,
    digest: string,
  ): T | undefined => {
    const row = selectReceipt.get(workspaceId, key) as
      { digest: string; result: string } | undefined;
    if (!row) return undefined;
    if (row.digest !== digest)
      throw new ClientError('CONFLICT', '这个幂等键已经用于另一个请求', {
        idempotencyKey: key,
      });
    return JSON.parse(row.result) as T;
  };

  const remember = (
    workspaceId: string,
    key: string,
    digest: string,
    result: unknown,
  ) => {
    try {
      insertReceipt.run(
        workspaceId,
        key,
        digest,
        JSON.stringify(result),
        new Date().toISOString(),
      );
    } catch (cause) {
      // 理论上查过就撞不到。真撞上了（例如将来开了第二个写进程），那是**并发**，
      // 不是「同一个键用了两次」—— 两句话不能混。
      if (!/UNIQUE/i.test((cause as Error).message)) throw cause;
      throw new ClientError(
        'CONFLICT',
        '这个请求正在被另一个写入处理，请稍后再试',
        {
          idempotencyKey: key,
        },
      );
    }
  };

  /**
   * 版本守卫。返回当前这一行，不存在就 NOT_FOUND，版本对不上就 CONFLICT。
   * 两句话必须分开说：「找不到」和「被改过了」要给用户完全不同的下一步。
   */
  const guard = (
    row: Row | undefined,
    expectedVersion: number,
    label: string,
  ) => {
    if (!row) throw new ClientError('NOT_FOUND', `找不到这个${label}`);
    const current = Number(row['version']);
    if (current !== expectedVersion)
      throw new ClientError('CONFLICT', `${label}已被其他操作更新`, {
        expectedVersion,
        currentVersion: current,
      });
    return row;
  };

  return {
    listEvents(context, range, page) {
      // 多取一条来判断还有没有下一页：少取一条就得再数一次总数。
      const rows = db
        .prepare(
          `SELECT * FROM calendar_events
           WHERE workspace_id = ? AND starts_at < ? AND ends_at > ?
           ORDER BY starts_at ASC, id ASC
           LIMIT ? OFFSET ?`,
        )
        .all(
          context.workspaceId,
          range.end,
          range.start,
          page.limit + 1,
          offsetOf(page.cursor),
        ) as Row[];
      const more = rows.length > page.limit;
      const items = rows.slice(0, page.limit).map(eventOf);
      const nextCursor = more
        ? String(offsetOf(page.cursor) + page.limit)
        : undefined;
      return {
        items,
        ...(nextCursor ? { nextCursor } : {}),
      } satisfies CalendarPage;
    },

    createEvent(context, input, idempotency) {
      return transaction(db, () => {
        const replayed = replay<CalendarEvent>(
          context.workspaceId,
          idempotency.key,
          idempotency.digest,
        );
        if (replayed) return replayed;
        const event: CalendarEvent = {
          id: crypto.randomUUID(),
          workspaceId: context.workspaceId,
          title: input.title,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          timeZone: input.timeZone,
          version: 1,
          ...(input.sourceConversationId
            ? { sourceConversationId: input.sourceConversationId }
            : {}),
        };
        db.prepare(
          `INSERT INTO calendar_events
             (id, workspace_id, title, starts_at, ends_at, time_zone, version, source_conversation_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          event.id,
          event.workspaceId,
          event.title,
          event.startsAt,
          event.endsAt,
          event.timeZone,
          event.version,
          event.sourceConversationId ?? null,
        );
        remember(
          context.workspaceId,
          idempotency.key,
          idempotency.digest,
          event,
        );
        return event;
      });
    },

    updateEvent(context, input, patch, validate, idempotency) {
      return transaction(db, () => {
        const replayed = replay<CalendarEvent>(
          context.workspaceId,
          idempotency.key,
          idempotency.digest,
        );
        if (replayed) return replayed;
        const current = guard(
          selectEventById.get(input.id, context.workspaceId) as Row | undefined,
          input.expectedVersion,
          '日程',
        );
        const merged = { ...eventOf(current), ...patch };
        validate(merged);
        // 守卫写进语句本身：读出来比一比的那道缝，在这里被 WHERE 堵住了。
        const changed = db
          .prepare(
            `UPDATE calendar_events
             SET title = ?, starts_at = ?, ends_at = ?, time_zone = ?, version = version + 1
             WHERE id = ? AND workspace_id = ? AND version = ?`,
          )
          .run(
            merged.title,
            merged.startsAt,
            merged.endsAt,
            merged.timeZone,
            input.id,
            context.workspaceId,
            input.expectedVersion,
          ).changes;
        if (changed !== 1)
          // 走到这里说明有人在这两条语句之间改了它。与其再查一次报个可能过期的版本号，
          // 不如让它落到重试上：用户重新点一次保存会带上他刚看到的版本。
          throw new ClientError('CONFLICT', '日程刚刚被别人改了，请重试', {
            idempotencyKey: idempotency.key,
          });
        const saved = eventOf(
          selectEventById.get(input.id, context.workspaceId) as Row,
        );
        remember(
          context.workspaceId,
          idempotency.key,
          idempotency.digest,
          saved,
        );
        return saved;
      });
    },

    removeEvent(context, input, idempotency) {
      return transaction(db, () => {
        const replayed = replay<DeleteResult>(
          context.workspaceId,
          idempotency.key,
          idempotency.digest,
        );
        if (replayed) return replayed;
        guard(
          selectEventById.get(input.id, context.workspaceId) as Row | undefined,
          input.expectedVersion,
          '日程',
        );
        const deleted = db
          .prepare(
            `DELETE FROM calendar_events
             WHERE id = ? AND workspace_id = ? AND version = ?`,
          )
          .run(input.id, context.workspaceId, input.expectedVersion).changes;
        if (deleted !== 1)
          throw new ClientError('CONFLICT', '日程刚刚被别人改了，请重试', {
            idempotencyKey: idempotency.key,
          });
        const result: DeleteResult = {
          entityType: 'calendarEvent',
          id: input.id,
          auditRef: crypto.randomUUID(),
          deletedAt: new Date().toISOString(),
        };
        insertAudit.run(
          result.auditRef,
          result.entityType,
          result.id,
          context.workspaceId,
          result.deletedAt,
        );
        remember(
          context.workspaceId,
          idempotency.key,
          idempotency.digest,
          result,
        );
        return result;
      });
    },

    getNote(context, id) {
      const row = selectNoteById.get(id, context.workspaceId) as
        Row | undefined;
      if (!row) throw new ClientError('NOT_FOUND', '找不到这条笔记');
      return noteOf(row);
    },

    listNotes(context, filter, page) {
      const keyword =
        filter.query === undefined
          ? undefined
          : `%${filter.query.toLowerCase().replaceAll('%', '').replaceAll('_', '')}%`;
      // SQLite 的 LIKE 只对 ASCII 折叠大小写，中文原样比对 —— 这跟 0.1 的
      // `toLowerCase().includes()` 对中文的行为一致（两者都不折叠），所以搜索结果不变。
      const rows = (
        keyword === undefined
          ? db
              .prepare(
                `SELECT * FROM notes WHERE workspace_id = ?
                 ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
              )
              .all(context.workspaceId, page.limit + 1, offsetOf(page.cursor))
          : db
              .prepare(
                `SELECT * FROM notes
                 WHERE workspace_id = ? AND (lower(title) LIKE ? OR lower(body) LIKE ?)
                 ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
              )
              .all(
                context.workspaceId,
                keyword,
                keyword,
                page.limit + 1,
                offsetOf(page.cursor),
              )
      ) as Row[];
      const more = rows.length > page.limit;
      const items = rows.slice(0, page.limit).map(summaryOf);
      const nextCursor = more
        ? String(offsetOf(page.cursor) + page.limit)
        : undefined;
      return {
        items,
        ...(nextCursor ? { nextCursor } : {}),
      } satisfies NotePage;
    },

    createNote(context, input, idempotency) {
      return transaction(db, () => {
        const replayed = replay<Note>(
          context.workspaceId,
          idempotency.key,
          idempotency.digest,
        );
        if (replayed) return replayed;
        const now = new Date().toISOString();
        const note: Note = {
          id: crypto.randomUUID(),
          workspaceId: context.workspaceId,
          title: input.title,
          body: input.body,
          version: 1,
          ...(input.sourceConversationId
            ? { sourceConversationId: input.sourceConversationId }
            : {}),
          createdAt: now,
          updatedAt: now,
        };
        db.prepare(
          `INSERT INTO notes
             (id, workspace_id, title, body, version, source_conversation_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          note.id,
          note.workspaceId,
          note.title,
          note.body,
          note.version,
          note.sourceConversationId ?? null,
          note.createdAt,
          note.updatedAt,
        );
        remember(
          context.workspaceId,
          idempotency.key,
          idempotency.digest,
          note,
        );
        return note;
      });
    },

    updateNote(context, input, patch, idempotency) {
      return transaction(db, () => {
        const replayed = replay<Note>(
          context.workspaceId,
          idempotency.key,
          idempotency.digest,
        );
        if (replayed) return replayed;
        const current = guard(
          selectNoteById.get(input.id, context.workspaceId) as Row | undefined,
          input.expectedVersion,
          '笔记',
        );
        const merged = {
          ...noteOf(current),
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        const changed = db
          .prepare(
            `UPDATE notes SET title = ?, body = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND workspace_id = ? AND version = ?`,
          )
          .run(
            merged.title,
            merged.body,
            merged.updatedAt,
            input.id,
            context.workspaceId,
            input.expectedVersion,
          ).changes;
        if (changed !== 1)
          throw new ClientError('CONFLICT', '笔记刚刚被别人改了，请重试', {
            idempotencyKey: idempotency.key,
          });
        const saved = noteOf(
          selectNoteById.get(input.id, context.workspaceId) as Row,
        );
        remember(
          context.workspaceId,
          idempotency.key,
          idempotency.digest,
          saved,
        );
        return saved;
      });
    },

    removeNote(context, input, idempotency) {
      return transaction(db, () => {
        const replayed = replay<DeleteResult>(
          context.workspaceId,
          idempotency.key,
          idempotency.digest,
        );
        if (replayed) return replayed;
        guard(
          selectNoteById.get(input.id, context.workspaceId) as Row | undefined,
          input.expectedVersion,
          '笔记',
        );
        const deleted = db
          .prepare(
            'DELETE FROM notes WHERE id = ? AND workspace_id = ? AND version = ?',
          )
          .run(input.id, context.workspaceId, input.expectedVersion).changes;
        if (deleted !== 1)
          throw new ClientError('CONFLICT', '笔记刚刚被别人改了，请重试', {
            idempotencyKey: idempotency.key,
          });
        const result: DeleteResult = {
          entityType: 'note',
          id: input.id,
          auditRef: crypto.randomUUID(),
          deletedAt: new Date().toISOString(),
        };
        insertAudit.run(
          result.auditRef,
          result.entityType,
          result.id,
          context.workspaceId,
          result.deletedAt,
        );
        remember(
          context.workspaceId,
          idempotency.key,
          idempotency.digest,
          result,
        );
        return result;
      });
    },
  };
}
