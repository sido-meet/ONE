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

/* ---------- 备份那一段的形状（ADR-029） ---------- */

/** 备份里的一条实体。字段与 0.1 的 JSON 文件一致，导入与恢复走同一条路。 */
interface EntityShape {
  id: string;
  workspaceId: string;
  title: string;
  version: number;
  sourceConversationId?: string;
}
interface CalendarEntity extends EntityShape {
  startsAt: string;
  endsAt: string;
  timeZone: string;
}
interface NoteEntity extends EntityShape {
  body: string;
  createdAt: string;
  updatedAt: string;
}
interface AuditShape {
  auditRef: string;
  entityType: string;
  id: string;
  workspaceId: string;
  deletedAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isLine = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024;
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const entityOf = (value: unknown): EntityShape | null => {
  if (!isRecord(value)) return null;
  if (!isLine(value.id) || !isLine(value.workspaceId) || !isLine(value.title))
    return null;
  if (!isCount(value.version)) return null;
  if (
    value.sourceConversationId !== undefined &&
    !isLine(value.sourceConversationId)
  )
    return null;
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    title: value.title,
    version: value.version,
    ...(value.sourceConversationId
      ? { sourceConversationId: value.sourceConversationId }
      : {}),
  };
};

/**
 * 校验一份备份数据，**全过了才返回**，任何一处不像样就抛。
 *
 * 这是**不可信输入**：包可能是用户从别处拿的，也可能是自己半年前导的。所以一律
 * 「不认识就拒」，不做尽力而为的修补 —— 猜错一个字段会把数据写坏，而写坏的数据
 * 用户往往要到很久以后才发现。
 *
 * 一条都没校验过就写库，比完全不导入糟得多：用户看着日历回来了、日程没了。
 */
function parseBackupSlice(
  kind: 'calendar' | 'notes',
  data: unknown,
): {
  entities: (CalendarEntity | NoteEntity)[];
  audits: AuditShape[];
  receipts: Record<string, { digest: string; result: unknown }>;
} {
  if (!isRecord(data))
    throw new ClientError('VALIDATION', '备份里这一份不是一个对象。');
  const raw = kind === 'calendar' ? data.calendarEvents : data.notes;
  if (!Array.isArray(raw))
    throw new ClientError(
      'VALIDATION',
      kind === 'calendar' ? '备份里没有日程列表。' : '备份里没有笔记列表。',
    );
  const entities: (CalendarEntity | NoteEntity)[] = [];
  for (const item of raw) {
    const base = entityOf(item);
    if (!base)
      throw new ClientError(
        'VALIDATION',
        '备份里有一条记录字段不对，没有导入任何内容。',
      );
    if (kind === 'calendar') {
      const event = item as Record<string, unknown>;
      if (
        !isLine(event.startsAt) ||
        !isLine(event.endsAt) ||
        !isLine(event.timeZone)
      )
        throw new ClientError(
          'VALIDATION',
          '备份里有一条日程字段不对，没有导入任何内容。',
        );
      entities.push({
        ...base,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        timeZone: event.timeZone,
      });
    } else {
      const note = item as Record<string, unknown>;
      if (
        !isLine(note.body) ||
        !isLine(note.createdAt) ||
        !isLine(note.updatedAt)
      )
        throw new ClientError(
          'VALIDATION',
          '备份里有一条笔记字段不对，没有导入任何内容。',
        );
      entities.push({
        ...base,
        body: note.body,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      });
    }
  }
  const audits: AuditShape[] = [];
  if (data.audits !== undefined) {
    if (!Array.isArray(data.audits))
      throw new ClientError('VALIDATION', '备份里的审计条目不是一个列表。');
    for (const item of data.audits) {
      if (
        !isRecord(item) ||
        !isLine(item.auditRef) ||
        !isLine(item.entityType) ||
        !isLine(item.id) ||
        !isLine(item.workspaceId) ||
        !isLine(item.deletedAt)
      )
        throw new ClientError(
          'VALIDATION',
          '备份里有一条审计条目不对，没有导入任何内容。',
        );
      audits.push({
        auditRef: item.auditRef,
        entityType: item.entityType,
        id: item.id,
        workspaceId: item.workspaceId,
        deletedAt: item.deletedAt,
      });
    }
  }
  const receipts: Record<string, { digest: string; result: unknown }> = {};
  if (data.receipts !== undefined) {
    if (!isRecord(data.receipts))
      throw new ClientError('VALIDATION', '备份里的幂等回执不是一个对象。');
    for (const [key, value] of Object.entries(data.receipts)) {
      if (!isRecord(value) || !isLine(value.digest))
        throw new ClientError(
          'VALIDATION',
          '备份里有一条幂等回执不对，没有导入任何内容。',
        );
      receipts[key] = { digest: value.digest, result: value.result };
    }
  }
  return { entities, audits, receipts };
}

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

  /** 交出这个身份的全部数据（ADR-029）。形状与 0.1 的 JSON 文件一致。 */
  exportSlice(kind: 'calendar' | 'notes', workspaceId: string): unknown;
  /**
   * 整库改写这个工作区的这一份数据，一个事务（ADR-029）。
   *
   * **先整体校验，全过了才动任何一行** —— 半截导入比不导入更糟。
   */
  replaceWorkspace(
    kind: 'calendar' | 'notes',
    workspaceId: string,
    data: unknown,
  ): void;
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
  // 导入用：整份按原样写回去，不走 create/update —— 那是给「用户新建/编辑」走的，
  // 带版本守卫与幂等回执，备份恢复不需要再走一遍那套语义。
  const insertEvent = db.prepare(
    `INSERT INTO calendar_events
       (id, workspace_id, title, starts_at, ends_at, time_zone, version, source_conversation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertNote = db.prepare(
    `INSERT INTO notes
       (id, workspace_id, title, body, version, source_conversation_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
    /**
     * 交出**这个身份**的全部数据（ADR-029）。
     *
     * 形状与 0.1 的 JSON 文件一模一样 —— 日历身份交 `{calendarEvents, audits,
     * receipts}`，笔记身份交 `{notes, audits, receipts}`。这不是偷懒：备份格式与
     * 迁移格式一致，导入与恢复走的是同一条解析与写入路径，少一处能出错的地方。
     *
     * **回执与审计一起交**，不然导入之后「这把幂等键用过没有」就丢了，重复确认会
     * 建出第二条 —— 而用户看到的是「我只是点了一下」。
     */
    exportSlice(kind: 'calendar' | 'notes', workspaceId: string): unknown {
      const entityTable = kind === 'calendar' ? 'calendar_events' : 'notes';
      const entities = db
        .prepare(`SELECT * FROM ${entityTable} WHERE workspace_id = ?`)
        .all(workspaceId) as Row[];
      const audits = db
        .prepare(
          'SELECT * FROM audit_entries WHERE workspace_id = ? AND entity_type = ?',
        )
        .all(
          workspaceId,
          kind === 'calendar' ? 'calendarEvent' : 'note',
        ) as Row[];
      const receipts = db
        .prepare('SELECT * FROM command_receipts WHERE workspace_id = ?')
        .all(workspaceId) as {
        idempotency_key: string;
        digest: string;
        result: string;
      }[];
      return {
        ...(kind === 'calendar'
          ? { calendarEvents: entities.map(eventOf) }
          : { notes: entities.map(noteOf) }),
        audits: audits.map((row) => ({
          auditRef: text(row, 'audit_ref'),
          entityType: text(row, 'entity_type'),
          id: text(row, 'id'),
          workspaceId: text(row, 'workspace_id'),
          deletedAt: text(row, 'deleted_at'),
        })),
        // 键是 `${workspaceId}:${idempotencyKey}`，与 0.1 保持一致：回执的键空间由
        // 提供方自己定义，本体不解释（ADR-029）。
        receipts: Object.fromEntries(
          receipts.map((row) => [
            `${workspaceId}:${row.idempotency_key}`,
            { digest: row.digest, result: JSON.parse(row.result) as unknown },
          ]),
        ),
      };
    },
    /**
     * **整库改写**这个工作区的这一份数据，一个事务（ADR-029）。
     *
     * 先整体校验、全过了再动任何一行：半截导入比不导入更糟 —— 用户看着日历回来了、
     * 日程没了，而没有任何地方告诉他这件事。
     */
    replaceWorkspace(
      kind: 'calendar' | 'notes',
      workspaceId: string,
      data: unknown,
    ): void {
      const slice = parseBackupSlice(kind, data);
      const entityTable = kind === 'calendar' ? 'calendar_events' : 'notes';
      const entityType = kind === 'calendar' ? 'calendarEvent' : 'note';
      transaction(db, () => {
        db.prepare(`DELETE FROM ${entityTable} WHERE workspace_id = ?`).run(
          workspaceId,
        );
        db.prepare(
          'DELETE FROM audit_entries WHERE workspace_id = ? AND entity_type = ?',
        ).run(workspaceId, entityType);
        db.prepare('DELETE FROM command_receipts WHERE workspace_id = ?').run(
          workspaceId,
        );
        for (const entity of slice.entities) {
          if (kind === 'calendar') {
            const event = entity as CalendarEntity;
            insertEvent.run(
              event.id,
              event.workspaceId,
              event.title,
              event.startsAt,
              event.endsAt,
              event.timeZone,
              event.version,
              event.sourceConversationId ?? null,
            );
          } else {
            const note = entity as NoteEntity;
            insertNote.run(
              note.id,
              note.workspaceId,
              note.title,
              note.body,
              note.version,
              note.sourceConversationId ?? null,
              note.createdAt,
              note.updatedAt,
            );
          }
        }
        for (const audit of slice.audits)
          insertAudit.run(
            audit.auditRef,
            audit.entityType,
            audit.id,
            audit.workspaceId,
            audit.deletedAt,
          );
        for (const [key, receipt] of Object.entries(slice.receipts)) {
          const cut = key.indexOf(':');
          if (cut <= 0) continue;
          insertReceipt.run(
            key.slice(0, cut),
            key.slice(cut + 1),
            receipt.digest,
            JSON.stringify(receipt.result),
            new Date().toISOString(),
          );
        }
      });
    },
  };
}
