import {
  assertValidRange,
  ClientError,
  requestDigest,
} from '../../contracts/src/index.ts';
import type {
  CalendarEvent,
  CalendarProvider,
  CommandContext,
  DeleteResult,
  Note,
  NotePage,
  NoteSummary,
  NotesProvider,
} from '../../contracts/src/index.ts';

export interface AuditEntry {
  auditRef: string;
  entityType: DeleteResult['entityType'];
  id: string;
  workspaceId: string;
  deletedAt: string;
}

interface MemoryState {
  notes: Note[];
  calendarEvents: CalendarEvent[];
  audits: AuditEntry[];
}

/**
 * 内存版提供方，用来验证端口契约（ADR-016）。
 *
 * 它**不做输入校验**：校验只在本体边界发生一次（domain.ts 的 parseXxx），
 * 因此这里收到的一定是已解析类型。省掉校验不是疏忽，而是把「谁负责校验」
 * 这件事收敛到唯一一处 —— 换实现时不会漏掉，也不会重复。
 *
 * 领域状态也不再有 notify 钩子指向会话：会话快照不含日历与笔记，创建日程
 * 不该让对话界面重绘。
 */
export interface MemoryProviders {
  calendar: CalendarProvider;
  notes: NotesProvider;
  /** 测试与调试用；返回快照式的拷贝，改它不影响提供方内部。 */
  read(): {
    notes: Note[];
    calendarEvents: CalendarEvent[];
    audits: AuditEntry[];
  };
  /** 仅供提供方自身刷新用（ADR-018 的摘要条），与会话订阅无关。 */
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export function createMemoryProviders(): MemoryProviders {
  const state: MemoryState = { notes: [], calendarEvents: [], audits: [] };
  const receipts = new Map<string, { digest: string; result: unknown }>();
  const listeners = new Set<() => void>();
  let disposed = false;

  const assertOpen = () => {
    if (disposed) throw new ClientError('DISPOSED', '领域服务已关闭');
  };
  const notify = () => listeners.forEach((listener) => listener());

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

  const calendar: CalendarProvider = {
    async list(context, input) {
      assertOpen();
      const start = Date.parse(input.rangeStart);
      const end = Date.parse(input.rangeEnd);
      const items = state.calendarEvents
        .filter((item) => item.workspaceId === context.workspaceId)
        .filter(
          (item) =>
            Date.parse(item.startsAt) < end && Date.parse(item.endsAt) > start,
        )
        .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
        .map((item) => structuredClone(item));
      return paginate(items, input.cursor, input.limit);
    },

    async create(context, input) {
      assertOpen();
      const digest = requestDigest(input);
      const replayed = replay<CalendarEvent>(
        context.workspaceId,
        input.idempotencyKey,
        digest,
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
      };
      if (input.sourceConversationId)
        event.sourceConversationId = input.sourceConversationId;
      state.calendarEvents.push(event);
      remember(context.workspaceId, input.idempotencyKey, digest, event);
      notify();
      return structuredClone(event);
    },

    async update(context, input) {
      assertOpen();
      const digest = requestDigest(input);
      const replayed = replay<CalendarEvent>(
        context.workspaceId,
        input.idempotencyKey,
        digest,
      );
      if (replayed) return replayed;
      const current = findEvent(context, input.id);
      guardVersion(current, input.expectedVersion, '日程');
      assertValidRange(
        input.patch.startsAt ?? current.startsAt,
        input.patch.endsAt ?? current.endsAt,
      );
      Object.assign(current, input.patch);
      current.version += 1;
      remember(context.workspaceId, input.idempotencyKey, digest, current);
      notify();
      return structuredClone(current);
    },

    async remove(context, input) {
      assertOpen();
      const digest = requestDigest(input);
      const replayed = replay<DeleteResult>(
        context.workspaceId,
        input.idempotencyKey,
        digest,
      );
      if (replayed) return replayed;
      const current = findEvent(context, input.id);
      guardVersion(current, input.expectedVersion, '日程');
      state.calendarEvents.splice(state.calendarEvents.indexOf(current), 1);
      const deletedAt = new Date().toISOString();
      const auditRef = crypto.randomUUID();
      state.audits.push({
        auditRef,
        entityType: 'calendarEvent',
        id: input.id,
        workspaceId: context.workspaceId,
        deletedAt,
      });
      const result: DeleteResult = {
        entityType: 'calendarEvent',
        id: input.id,
        auditRef,
        deletedAt,
      };
      remember(context.workspaceId, input.idempotencyKey, digest, result);
      notify();
      return structuredClone(result);
    },
  };

  const notes: NotesProvider = {
    async list(context, input): Promise<NotePage> {
      assertOpen();
      const keyword = input.query?.toLowerCase();
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
      return paginate(summaries, input.cursor, input.limit);
    },

    async get(context, input): Promise<Note> {
      assertOpen();
      const note = state.notes.find(
        (item) =>
          item.id === input.id && item.workspaceId === context.workspaceId,
      );
      // 找不到就说找不到，不拿「一条也没有」冒充 —— 那是两种完全不同的界面动作。
      if (!note)
        throw new ClientError('NOT_FOUND', '找不到这条笔记，可能已经删掉了');
      return structuredClone(note);
    },

    async create(context, input) {
      assertOpen();
      const digest = requestDigest(input);
      const replayed = replay<Note>(
        context.workspaceId,
        input.idempotencyKey,
        digest,
      );
      if (replayed) return replayed;
      const now = new Date().toISOString();
      const note: Note = {
        id: crypto.randomUUID(),
        workspaceId: context.workspaceId,
        title: input.title,
        body: input.body,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      if (input.sourceConversationId)
        note.sourceConversationId = input.sourceConversationId;
      state.notes.push(note);
      remember(context.workspaceId, input.idempotencyKey, digest, note);
      notify();
      return structuredClone(note);
    },

    async update(context, input) {
      assertOpen();
      const digest = requestDigest(input);
      const replayed = replay<Note>(
        context.workspaceId,
        input.idempotencyKey,
        digest,
      );
      if (replayed) return replayed;
      const current = findNote(context, input.id);
      guardVersion(current, input.expectedVersion, '笔记');
      Object.assign(current, input.patch);
      current.version += 1;
      current.updatedAt = new Date().toISOString();
      remember(context.workspaceId, input.idempotencyKey, digest, current);
      notify();
      return structuredClone(current);
    },

    async remove(context, input) {
      assertOpen();
      const digest = requestDigest(input);
      const replayed = replay<DeleteResult>(
        context.workspaceId,
        input.idempotencyKey,
        digest,
      );
      if (replayed) return replayed;
      const current = findNote(context, input.id);
      guardVersion(current, input.expectedVersion, '笔记');
      state.notes.splice(state.notes.indexOf(current), 1);
      const deletedAt = new Date().toISOString();
      const auditRef = crypto.randomUUID();
      state.audits.push({
        auditRef,
        entityType: 'note',
        id: input.id,
        workspaceId: context.workspaceId,
        deletedAt,
      });
      const result: DeleteResult = {
        entityType: 'note',
        id: input.id,
        auditRef,
        deletedAt,
      };
      remember(context.workspaceId, input.idempotencyKey, digest, result);
      notify();
      return structuredClone(result);
    },
  };

  return {
    calendar,
    notes,
    read: () => structuredClone(state),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      listeners.clear();
      disposed = true;
    },
  };
}
