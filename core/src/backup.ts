import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ClientError } from '../../packages/contracts/src/index.ts';
import type {
  CommandContext,
  ConversationStore,
  ProviderId,
} from '../../packages/contracts/src/index.ts';
import {
  BACKUP_ACTIONS,
  BACKUP_EXPORT_CAPABILITY,
  BACKUP_IMPORT_CAPABILITY,
  BACKUP_SCHEMA_VERSION,
  MAX_BACKUP_BYTES,
  explainBundleRejection,
  parseBackupBundle,
  parseProviderBackup,
} from '../../packages/contracts/src/backup.ts';
import type {
  BackupBundle,
  ProviderBackup,
} from '../../packages/contracts/src/backup.ts';

/**
 * 备份编排（ADR-029）。
 *
 * 数据分两个库、两个进程，所以备份天然是**跨进程**动作。只有本体能同时看到两边：它
 * 持有对话，又是领域能力的唯一调用方（ADR-016）。所以这里只做编排 —— 问每个参与者
 * 要它自己那一份，原样拼进包，原样交还回去。
 *
 * **本体不解释参与者交回来的东西**。那一份的形状由提供方负责；本体要是开始理解日历
 * 的字段，就等于把领域知识搬回了本体，ADR-016 那条线就白划了。
 *
 * ## 跨库原子性做不到，就不假装做得到
 *
 * 导入分两段：① **整包先校验**，任何一段不过就一个字节都不写；② 校验全过之后各库
 * 各自在一个事务里应用。真的写失败时，逐段说清哪一段没进去、需要重试。两个进程、
 * 两个文件，没有跨库的原子性可言 —— 所以返回值长成那样是刻意的，不是没做完。
 */

/** 本体编排要用的那一点本体能力。写窄一点，别把整个 Core 递进来。 */
export interface BackupCore {
  /** 本体自己发起的能力调用（与 `page.read` 走同一条路，ADR-016）。 */
  invoke(
    target: ProviderId,
    capability: string,
    args?: unknown,
  ): Promise<unknown>;
  roster(): {
    role: string;
    provider?: string;
    capabilities?: readonly string[];
  }[];
}

/**
 * 导入结果。**逐段报告**，因为跨库原子性做不到（见文件头）——
 * 一个只有「成功 / 失败」的返回值会让人以为要么全成了、要么全没成。
 */
export interface ImportOutcome {
  conversations: { applied: boolean; reason?: string };
  /** 键是寻址键。没装的参与者**不列** —— 没装的东西没有可导入的数据。 */
  providers: Record<string, { applied: boolean; reason?: string }>;
}

export interface BackupService {
  /** 导出到指定路径。路径必须是绝对路径 —— 相对路径的分歧不该由本体替用户决定。 */
  exportTo(file: string): Promise<BackupBundle>;
  importFrom(file: string): Promise<ImportOutcome>;
  forget(conversationId: string): void;
  /** 默认导出目录下最新的一份备份。没有就 undefined。界面用它做「恢复上一次备份」。 */
  latestExport(): string | undefined;
  exportDir(): string;
}

export function createBackupService(options: {
  core: BackupCore;
  store: ConversationStore;
  version: string;
  dataDir: string;
  /** 工作区从哪来 —— 本体说了算，不让提供方自己猜（ADR-016）。 */
  contextFor: (requestId: string) => CommandContext;
  onConversationsReplaced?: () => void;
}): BackupService {
  const { core, store, version, dataDir } = options;
  const dir = path.join(dataDir, 'exports');

  /** 在场、且申报了**全部**备份能力的参与者。少报一个就不给它备份，也不假装导过了。 */
  const capableProviders = (): ProviderId[] => {
    const found: ProviderId[] = [];
    for (const entry of core.roster()) {
      if (entry.role !== 'provider' || !entry.provider) continue;
      const has = (action: (typeof BACKUP_ACTIONS)[number]) =>
        entry.capabilities?.includes(
          `${action === 'export' ? BACKUP_EXPORT_CAPABILITY : BACKUP_IMPORT_CAPABILITY}`,
        );
      if (!BACKUP_ACTIONS.every(has)) continue;
      found.push(entry.provider as ProviderId);
    }
    return found;
  };

  const askForSlice = async (target: ProviderId): Promise<ProviderBackup> => {
    const raw = await core.invoke(target, BACKUP_EXPORT_CAPABILITY, {
      context: options.contextFor(`backup-export-${target}`),
    });
    const parsed = parseProviderBackup(raw);
    if (!parsed)
      throw new ClientError(
        'INTERNAL',
        `「${target}」交回来的备份不符合格式，这次导出作废（没有写文件）。`,
      );
    return parsed;
  };

  return {
    async exportTo(file) {
      if (!path.isAbsolute(file))
        throw new ClientError(
          'VALIDATION',
          '备份文件要用完整路径，不用相对路径。',
        );
      // 一个参与者都没问成就不写文件：半个包比没有包更危险 —— 用户会拿它去恢复，
      // 然后发现少了一半日程，而且没有任何地方告诉他这件事。
      const providers: Record<string, ProviderBackup> = {};
      for (const target of capableProviders())
        providers[target] = await askForSlice(target);

      const state = store.open();
      const bundle: BackupBundle = {
        schemaVersion: BACKUP_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        appVersion: version,
        conversations: {
          schemaVersion: BACKUP_SCHEMA_VERSION,
          workspaces: state.workspaces,
          conversations: state.conversations,
          events: state.events,
        },
        providers,
      };
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
      return bundle;
    },

    async importFrom(file) {
      if (!path.isAbsolute(file))
        throw new ClientError(
          'VALIDATION',
          '备份文件要用完整路径，不用相对路径。',
        );
      let raw: string;
      try {
        // 先看大小再读：备份是**不可信输入**，一个声称是备份的 JSON 可以是 4GB。
        const bytes = readFileSync(file, 'utf8');
        if (bytes.length > MAX_BACKUP_BYTES)
          throw new ClientError(
            'VALIDATION',
            `这个文件太大（${Math.round(bytes.length / 1024 / 1024)}MB），不像一份备份。`,
          );
        raw = bytes;
      } catch (error) {
        throw new ClientError(
          'NOT_FOUND',
          `读不到这个文件：${file}。${error instanceof Error ? error.message : ''}`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ClientError(
          'VALIDATION',
          '这个文件不是合法的 JSON，没有导入任何内容。',
        );
      }
      // **整包先校验。** 任何一段不过就一个字节都不写 —— 半截导入比不导入更糟：
      // 用户看着日历回来了、日程没了，而没有任何地方告诉他这件事。
      const bundle = parseBackupBundle(parsed);
      if (!bundle)
        throw new ClientError('VALIDATION', explainBundleRejection(parsed));

      const outcome: ImportOutcome = {
        conversations: { applied: false },
        providers: {},
      };
      try {
        store.replaceAll(bundle.conversations);
        outcome.conversations = { applied: true };
        options.onConversationsReplaced?.();
      } catch (error) {
        outcome.conversations = {
          applied: false,
          reason: error instanceof Error ? error.message : '对话没能写进去',
        };
      }

      for (const [target, slice] of Object.entries(bundle.providers)) {
        // 包里有、现在没装的参与者：跳过并说明，不当成失败 —— 那份数据在这个机器上
        // 没有地方可去，报错只会让用户以为备份坏了。
        if (!capableProviders().includes(target as ProviderId)) {
          outcome.providers[target] = {
            applied: false,
            reason: '这个参与者现在没装，那一份没有导入。',
          };
          continue;
        }
        try {
          await core.invoke(target as ProviderId, BACKUP_IMPORT_CAPABILITY, {
            context: options.contextFor(`backup-import-${target}`),
            data: slice.data,
          });
          outcome.providers[target] = { applied: true };
        } catch (error) {
          outcome.providers[target] = {
            applied: false,
            reason: error instanceof Error ? error.message : '没能写进去',
          };
        }
      }
      return outcome;
    },

    forget(conversationId: string) {
      if (!store.forgetConversation(conversationId))
        throw new ClientError('NOT_FOUND', '找不到这段对话', {
          conversationId,
        });
      options.onConversationsReplaced?.();
    },

    latestExport() {
      let newest: { file: string; at: number } | undefined;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return undefined;
      }
      for (const name of names)
        if (name.endsWith('.json')) {
          const at = name.lastIndexOf('-');
          const stamp = Number(
            name.slice(at + 1, name.length - '.json'.length),
          );
          if (!Number.isFinite(stamp)) continue;
          if (!newest || stamp > newest.at) newest = { file: name, at: stamp };
        }
      return newest ? path.join(dir, newest.file) : undefined;
    },

    exportDir: () => dir,
  };
}
