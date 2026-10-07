/**
 * 备份包的契约（ADR-029）。
 *
 * 数据分两个库、两个进程（`core.db` 归本体、`local.db` 归本地提供方），所以「备份」
 * 天然是个**跨进程**动作。这个文件把那份跨进程的形状写死：谁交什么、包长什么样、
 * 哪些输入一律拒绝。
 *
 * 三条判断标准：
 *
 * 1. **备份文件是不可信输入。** 用户会从别处拿一个包来导入，也可能是自己半年前导的。
 *    所以解析一律「不认识就拒」，不做尽力而为的修补——猜错一个字段会把数据写坏，
 *    而写坏的数据用户往往要到很久以后才发现。
 * 2. **本体不解释提供方那一份。** 它把每个参与者交回来的东西原样放进包里，也原样
 *    交还回去。谁的形状谁负责——本体要是去理解日历的字段，就等于把领域知识搬回了
 *    本体，ADR-016 那条线就白划了。
 * 3. **大小上限要有。** 一个声称是备份的 JSON 可以是 4GB；在读进内存之前就得拒。
 */

import type { Conversation, DurableEvent, Workspace } from './index.ts';

/**
 * 备份包版本。**改格式就升它**，旧版本明确拒绝而不是尽力解析。
 *
 * 只加可选字段不用升：老包少一个字段，导入时按「没有这个字段」处理即可。
 */
export const BACKUP_SCHEMA_VERSION = 1;

/**
 * 提供方用它交出/收回**整份**数据。
 *
 * 刻意不叫 `calendar.export` / `notes.export`：那是一个提供方的全部数据，不是某一个
 * 域的一次操作。日历与笔记由同一个进程各管一份，导出却只有一份——与 `page.read`
 * 同级，都是「跨域」的能力。
 */
export const BACKUP_EXPORT_CAPABILITY = 'data.export';
export const BACKUP_IMPORT_CAPABILITY = 'data.import';

/** 一个提供方要申报的备份能力。缺一个，本体就不给它备份，也不假装导过了。 */
export const BACKUP_ACTIONS = ['export', 'import'] as const;

/** 一个包的上限。个人单机十年也就这个量级；超过就是别的东西，不按备份处理。 */
export const MAX_BACKUP_BYTES = 256 * 1024 * 1024;

/** 单个字段（正文、回复）的上限。防止一个 300MB 的字符串把内存吃光。 */
export const MAX_BACKUP_TEXT = 8 * 1024 * 1024;

/** 一个包里的对话数上限。用来在读进内存之前先按字节粗筛一次。 */
export const MAX_BACKUP_RECORDS = 200_000;

/** 一个参与者交回来的那一份。它自己的形状，**本体不解释**。 */
export interface ProviderBackup {
  schemaVersion: number;
  /** 说清这是哪种数据：日历 / 笔记。字段名对不上时，界面靠它说人话。 */
  kind: string;
  data: unknown;
}

/** 本体自己的那一份。 */
export interface ConversationBackup {
  schemaVersion: number;
  workspaces: Workspace[];
  conversations: Conversation[];
  events: DurableEvent[];
}

/** 磁盘上那份文件的形状。 */
export interface BackupBundle {
  schemaVersion: number;
  exportedAt: string;
  appVersion: string;
  conversations: ConversationBackup;
  /** 键是寻址键（provider id）。本体按名册逐个对上，对不上的原样保留、不报错。 */
  providers: Record<string, ProviderBackup>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown, max = MAX_BACKUP_TEXT): value is string =>
  typeof value === 'string' && value.length <= max;

/** 只认我们自己发得出去的版本。别的数字一律拒绝。 */
const isKnownVersion = (value: unknown): value is number =>
  value === BACKUP_SCHEMA_VERSION;

/**
 * 校验一个参与者交回来的那一份。
 *
 * `data` 的形状**故意不管**：那是提供方自己的格式，本体看不懂也不该看懂。只挡住
 * 「根本不是一个对象」这种连 JSON 都不是的情况。
 */
export function parseProviderBackup(value: unknown): ProviderBackup | null {
  if (!isRecord(value)) return null;
  if (!isKnownVersion(value.schemaVersion)) return null;
  if (!isText(value.kind, 64)) return null;
  if (value.data === undefined) return null;
  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    data: value.data,
  };
}

export function parseConversationBackup(
  value: unknown,
): ConversationBackup | null {
  if (!isRecord(value)) return null;
  if (!isKnownVersion(value.schemaVersion)) return null;
  if (!Array.isArray(value.workspaces) || !Array.isArray(value.conversations))
    return null;
  if (!Array.isArray(value.events)) return null;
  if (value.events.length > MAX_BACKUP_RECORDS) return null;
  // 每条事件都要有那五个字段，缺一条就是坏包 —— 放着不管的话，导入时会在别处炸，
  // 而那时候用户已经改了一半数据。
  for (const event of value.events) {
    if (!isRecord(event)) return null;
    if (!isText(event.id, 128) || !isText(event.conversationId, 128))
      return null;
    if (!isText(event.type, 64)) return null;
    if (typeof event.seq !== 'number' || !Number.isInteger(event.seq))
      return null;
    if (!isText(event.createdAt, 64)) return null;
  }
  for (const conversation of value.conversations) {
    if (!isRecord(conversation)) return null;
    if (!isText(conversation.id, 128) || !isText(conversation.title))
      return null;
    if (!isText(conversation.workspaceId, 128)) return null;
    if (!isText(conversation.agentId, 64)) return null;
  }
  return {
    schemaVersion: value.schemaVersion,
    workspaces: value.workspaces as Workspace[],
    conversations: value.conversations as Conversation[],
    events: value.events as DurableEvent[],
  };
}

/**
 * 校验整个包。**任何一个字段不过就整体拒绝**，不做「能救几段救几段」。
 *
 * 部分导入是最坏的结果：用户看着日历回来了，日程没了，而且没有任何地方告诉他这件事。
 */
export function parseBackupBundle(value: unknown): BackupBundle | null {
  if (!isRecord(value)) return null;
  if (!isKnownVersion(value.schemaVersion)) return null;
  if (!isText(value.exportedAt, 64) || !isText(value.appVersion, 64))
    return null;
  const conversations = parseConversationBackup(value.conversations);
  if (!conversations) return null;
  if (!isRecord(value.providers)) return null;
  const providers: Record<string, ProviderBackup> = {};
  for (const [key, slice] of Object.entries(value.providers)) {
    const parsed = parseProviderBackup(slice);
    if (!parsed) return null;
    providers[key] = parsed;
  }
  return {
    schemaVersion: value.schemaVersion,
    exportedAt: value.exportedAt,
    appVersion: value.appVersion,
    conversations,
    providers,
  };
}

/**
 * 一句话说清「这个文件为什么不能用」。
 *
 * 校验返回 `null` 时界面必须给得出**具体**的原因，否则用户拿到的是一句「导入失败」，
 * 面对一个自己导出来的文件时完全无从下手。
 */
export function explainBundleRejection(raw: unknown): string {
  if (!isRecord(raw)) return '这不是一个 ONE 备份文件（顶层不是对象）。';
  const version = raw.schemaVersion;
  if (version === undefined)
    return '备份文件缺少 schemaVersion，可能不是完整导出的。';
  if (!isKnownVersion(version))
    return `备份文件的版本是 ${String(version)}，这一版 ONE 读不了（认的是 ${BACKUP_SCHEMA_VERSION}）。`;
  const conversations = parseConversationBackup(raw.conversations);
  if (!conversations) return '备份文件里的对话部分坏了，没有导入任何内容。';
  if (!isRecord(raw.providers))
    return '备份文件缺少参与者数据，没有导入任何内容。';
  for (const [key, slice] of Object.entries(raw.providers)) {
    const parsed = parseProviderBackup(slice);
    if (!parsed) return `备份文件里「${key}」那一份坏了，没有导入任何内容。`;
  }
  return '备份文件不符合格式要求，没有导入任何内容。';
}
