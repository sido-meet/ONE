import { readFileSync } from 'node:fs';

/**
 * 0.1 的 JSON 数据文件的**只读**解析器（R01 迁移的输入）。
 *
 * 0.2 之后日历与笔记都在 SQLite 里（见 `db.ts`），这份格式只会出现在已经用旧版跑过
 * 一次的用户机器上。所以这里**只读不写**：写过它的只有 0.1 的提供方，而那份代码已经
 * 不再被运行。用户原始数据一个字节都不动 —— 迁移成功也只是把它改名成 `.migrated`。
 *
 * **坏文件必须让整次导入失败。** 原来这里是「读不出来就抛，提供方拒绝启动」，
 * 那条纪律在换存储之后不能丢，只是搬了家：现在它守着的是导入这一步。静默跳过的话，
 * 用户会看到一个空的日历 —— 那和「数据丢了」在界面上长得一模一样，而真相（文件就在
 * 那个目录里，只是没导进去）只写在日志里。宁可开不起来。
 */

export interface LegacyNote {
  id: string;
  workspaceId: string;
  title: string;
  body: string;
  version: number;
  sourceConversationId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LegacyEvent {
  id: string;
  workspaceId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  version: number;
  sourceConversationId?: string;
}

export interface LegacyAudit {
  auditRef: string;
  entityType: string;
  id: string;
  workspaceId: string;
  deletedAt: string;
}

export interface LegacyData {
  notes: LegacyNote[];
  calendarEvents: LegacyEvent[];
  audits: LegacyAudit[];
  receipts: Record<string, { digest: string; result: unknown }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const arrayOf = (
  value: unknown,
  field: string,
  file: string,
): Record<string, unknown>[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error(`旧数据文件的 ${field} 不是数组，拒绝导入：${file}`);
  return value.filter((item) => {
    if (isRecord(item)) return true;
    throw new Error(
      `旧数据文件的 ${field} 里有不是对象的条目，拒绝导入：${file}`,
    );
  });
};

/**
 * 读一份旧数据文件。
 *
 * 形状不对（不是对象）一律拒绝。字段里的具体内容不再逐个校验 —— 那是本体边界的
 * 职责，而且这里拒绝的代价太大：一个字段名对不上就让用户开不起来，而数据其实还在。
 * 真有坏实体时，SQLite 的 `NOT NULL` 会拦下它，那条迁移照样回滚。
 */
export function readLegacyData(file: string): LegacyData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new Error(
      `数据文件损坏，已拒绝导入：${file}（${(cause as Error).message}）`,
    );
  }
  if (!isRecord(parsed))
    throw new Error(`数据文件形状不对，已拒绝导入：${file}`);
  return {
    notes: arrayOf(parsed.notes, 'notes', file) as unknown as LegacyNote[],
    calendarEvents: arrayOf(
      parsed.calendarEvents,
      'calendarEvents',
      file,
    ) as unknown as LegacyEvent[],
    audits: arrayOf(parsed.audits, 'audits', file) as unknown as LegacyAudit[],
    receipts: receiptsOf(parsed.receipts),
  };
}

/**
 * 回执字典的形状对不对，这里**不逐条查**。
 *
 * 导入时每一条都要有 `digest` 与 `result`；少一个的那条会让「这把幂等键用过没有」
 * 变成一个说不清的答案 —— 而那正是重复写入要防的那件事。所以这里只保证是个字典，
 * 逐条的形状由 SQL 的 NOT NULL 在导入时拦下（拦下就是整次导入回滚，正是我们要的）。
 */
const receiptsOf = (value: unknown): LegacyData['receipts'] => {
  if (!isRecord(value)) return {};
  const out: LegacyData['receipts'] = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isRecord(entry) && 'digest' in entry && 'result' in entry)
      out[key] = entry as never;
  }
  return out;
};
