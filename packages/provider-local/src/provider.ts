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
import type { CommandContext } from '../../contracts/src/index.ts';
import type { Repository } from './repository.ts';

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
 * 护住自己的数据。
 *
 * 0.2 起这一层只**解析与委派**：校验在 parseXxx，落库在 `Repository`（R01）。
 * 这里不再持有任何数据副本 —— 以前那份内存里的数组是「数据」的所在，现在它
 * 只是一次调用的输入。
 */

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
  repository: Repository,
  kind: 'calendar' | 'notes',
): LocalProvider {
  if (kind === 'calendar') {
    return {
      kind,
      async list(context, input) {
        const parsed = parseCalendarList(input);
        return repository.listEvents(
          context,
          { start: parsed.rangeStart, end: parsed.rangeEnd },
          {
            ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
            limit: parsed.limit,
          },
        );
      },
      async create(context, input) {
        const parsed = parseCalendarCreate(input);
        return repository.createEvent(
          context,
          {
            title: parsed.title,
            startsAt: parsed.startsAt,
            endsAt: parsed.endsAt,
            timeZone: parsed.timeZone,
            ...(parsed.sourceConversationId
              ? { sourceConversationId: parsed.sourceConversationId }
              : {}),
          },
          { key: parsed.idempotencyKey, digest: requestDigest(parsed) },
        );
      },
      async update(context, input) {
        const parsed = parseCalendarUpdate(input);
        return repository.updateEvent(
          context,
          { id: parsed.id, expectedVersion: parsed.expectedVersion },
          parsed.patch,
          // 区间合法性在**写之前**判，且看的是合并后那一版：拿到的是当前这一版，
          // 改完再判等于让用户为一次没保存成功的编辑背锅。
          (merged) => assertValidRange(merged.startsAt, merged.endsAt),
          { key: parsed.idempotencyKey, digest: requestDigest(parsed) },
        );
      },
      async remove(context, input) {
        const parsed = parseCalendarDelete(input);
        return repository.removeEvent(
          context,
          { id: parsed.id, expectedVersion: parsed.expectedVersion },
          { key: parsed.idempotencyKey, digest: requestDigest(parsed) },
        );
      },
    };
  }

  return {
    kind,
    /**
     * 取全文。编辑之前必须先读 —— 列表只给摘要，正文不在里面。
     * 读操作不写盘，因此没有幂等回执可言。
     */
    async get(context, input) {
      const parsed = parseNotesGet(input);
      return repository.getNote(context, parsed.id);
    },
    async list(context, input) {
      const parsed = parseNotesList(input);
      return repository.listNotes(
        context,
        parsed.query === undefined ? {} : { query: parsed.query },
        {
          ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
          limit: parsed.limit,
        },
      );
    },
    async create(context, input) {
      const parsed = parseNotesCreate(input);
      return repository.createNote(
        context,
        {
          title: parsed.title,
          body: parsed.body,
          ...(parsed.sourceConversationId
            ? { sourceConversationId: parsed.sourceConversationId }
            : {}),
        },
        { key: parsed.idempotencyKey, digest: requestDigest(parsed) },
      );
    },
    async update(context, input) {
      const parsed = parseNotesUpdate(input);
      return repository.updateNote(
        context,
        { id: parsed.id, expectedVersion: parsed.expectedVersion },
        parsed.patch,
        { key: parsed.idempotencyKey, digest: requestDigest(parsed) },
      );
    },
    async remove(context, input) {
      const parsed = parseNotesDelete(input);
      return repository.removeNote(
        context,
        { id: parsed.id, expectedVersion: parsed.expectedVersion },
        { key: parsed.idempotencyKey, digest: requestDigest(parsed) },
      );
    },
  };
}
