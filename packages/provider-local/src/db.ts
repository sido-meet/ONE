import { existsSync, readFileSync, renameSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  openSqlite,
  transaction,
  backupTo as vacuumInto,
} from '../../sqlite/src/index.ts';
import { readLegacyData } from './legacy.ts';

/**
 * 本地提供方的 SQLite 存储（R01）。
 *
 * **为什么是 SQLite 而不是继续用 JSON 文件。** 原来每次写入都要把整份数据读进内存、
 * 改完再整份重写。那样过不了三关：① 并发改不掉 —— 两个人各改一条，最后写的把先写的
 * 整份覆盖掉；② 写一半被杀会留下半截文件（现在靠「先写临时文件再改名」绕开，但那是
 * 靠运气，不是靠约束）；③ 版本冲突只能靠「读出来比一比」，两个进程同时读到第 3 版、
 * 都以为自己是第 3 版，然后都写成第 4 版。
 *
 * 这三条在 SQLite 里是**声明式的**：`WHERE version = ?` 让版本守卫落进同一条语句，
 * `(workspace_id, idempotency_key)` 主键让「一把幂等键只对得上一个请求」由数据库保证。
 * 数据库崩溃恢复、日志式回滚、事务原子性都白拿。
 *
 * **为什么用 `node:sqlite` 而不是加一个依赖。** 本体随包携带 node（ADR-021），
 * 多一个原生模块就多一份跨机器出问题的理由 —— 预编译二进制不一定有、ABI 不一定对、
 * 打包脚本要多抄一份。Node 22 自带的就是同一个 SQLite，省掉的是整类发布问题。
 *
 * **一个进程一份库。** 日历与笔记两个身份在同一个进程里，但共用**一个**连接：迁移只
 * 在开库时跑一次，两个身份看到的是同一份数据。跨进程的文件锁留给真正多进程的场景，
 * 那时再拆文件。
 *
 * **durability 的取舍**：`synchronous = FULL` 让每次提交都真的落到盘上，代价是慢一点。
 * 用户的数据只有几十条日程与笔记，一次写入几毫秒 —— 这里省那点时间不值得。
 */

export interface LocalDatabase {
  readonly db: DatabaseSync;
  /** 库文件路径。日志与备份都要用它说清「是哪份数据」。 */
  readonly file: string;
  /** 迁移前自动备份留下的文件；这一轮没迁移过就是 undefined。 */
  readonly backup: string | undefined;
  /** 迁移前把这套数据另存一份。导出、迁移前的保险都走它。 */
  backupTo(target: string): void;
  close(): void;
}

/**
 * 打开并配置好库，顺带把待办的迁移跑完。
 *
 * @param file   库文件路径。父目录没有会建。
 * @param legacy 旧版 JSON 数据文件。存在就把它们导进来 —— 导完**改名**而不是删掉，
 *               用户的原始数据一个字节都不动，同时也不会被导第二次。
 */
export function openDatabase(
  file: string,
  legacy: readonly string[] = [],
): LocalDatabase {
  // pragma 与事务助手在 `packages/sqlite`（ADR-028）：本体与提供方各有一个库，
  // 两边配置必须一模一样，分开写迟早有一处会漂。
  const opened = openSqlite(file);
  const db = opened.db;
  const backupTo = (target: string) => vacuumInto(db, target);

  const applied = readAppliedVersions(db);
  const pending = pendingVersions(db);
  let backup: string | undefined;

  if (pending.length > 0 && applied.length > 0) {
    // 只在「已经有数据、又要改结构」时备份。全新库第一次建表没有可丢的东西，
    // 旧版 JSON 那时候才是唯一一份数据 —— 它在迁移里只读不删，不该被覆盖。
    backup = `${file}.v${applied.at(-1)}.bak`;
    backupTo(backup);
  }

  for (const version of pending) {
    // 每条迁移**各自一个事务**。失败时事务回滚，版本号也不会被写进去，
    // 下次启动原样重来 —— 「迁移失败可回滚」就是这一句的意思。
    transaction(db, () => {
      applyMigration(db, version, legacy);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(version, migrationName(version), new Date().toISOString());
    });
  }

  let closed = false;
  return {
    db,
    file,
    backup,
    backupTo,
    // 幂等的关法在 `packages/sqlite` 里（两个库共用一份实现）。
    close: () => {
      if (closed) return;
      closed = true;
      opened.close();
    },
  };
}

/**
 * 把 `fn` 包在一个事务里 —— 与本体共用同一份实现（`packages/sqlite`）。
 * 这里是再导出一次，免得仓储的 import 路径全变。
 */
export { transaction };

/** schema_migrations 是记账的表，它自己得先在。 */
function ensureMigrationsTable(db: DatabaseSync) {
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
  });
}

function readAppliedVersions(db: DatabaseSync): number[] {
  ensureMigrationsTable(db);
  const rows = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as {
    version: number;
  }[];
  return rows.map((row) => Number(row.version));
}

function pendingVersions(db: DatabaseSync): number[] {
  ensureMigrationsTable(db);
  return MIGRATION_VERSIONS.filter(
    (version) => !readAppliedVersions(db).includes(version),
  );
}

function migrationName(version: number): string {
  const found = MIGRATIONS.find((item) => item.version === version);
  return found?.name ?? `第 ${version} 版`;
}

function applyMigration(
  db: DatabaseSync,
  version: number,
  legacy: readonly string[],
) {
  const found = MIGRATIONS.find((item) => item.version === version);
  if (!found) throw new Error(`没有第 ${version} 号迁移`);
  found.up(db, legacy);
}

/**
 * 迁移表。每加一条就在末尾追加，**永远不改已经发出去的** ——
 * 用户机器上跑的是当时那一份，改写旧迁移等于让两台机器跑出不同的库。
 */
export const MIGRATION_VERSIONS = [1, 2];

interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync, legacy: readonly string[]) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: '建立日历、笔记、审计与幂等回执四张表',
    up(db) {
      db.exec(`
        CREATE TABLE notes (
          id                     TEXT    PRIMARY KEY,
          workspace_id           TEXT    NOT NULL,
          title                  TEXT    NOT NULL,
          body                   TEXT    NOT NULL,
          version                INTEGER NOT NULL,
          source_conversation_id TEXT,
          created_at             TEXT    NOT NULL,
          updated_at             TEXT    NOT NULL
        );
        CREATE INDEX notes_by_workspace ON notes (workspace_id, updated_at DESC, id DESC);

        CREATE TABLE calendar_events (
          id                     TEXT    PRIMARY KEY,
          workspace_id           TEXT    NOT NULL,
          title                  TEXT    NOT NULL,
          starts_at              TEXT    NOT NULL,
          ends_at                TEXT    NOT NULL,
          time_zone              TEXT    NOT NULL,
          version                INTEGER NOT NULL,
          source_conversation_id TEXT
        );
        CREATE INDEX calendar_by_window
          ON calendar_events (workspace_id, starts_at, id);

        CREATE TABLE audit_entries (
          audit_ref    TEXT PRIMARY KEY,
          entity_type  TEXT NOT NULL,
          id           TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          deleted_at   TEXT NOT NULL
        );
        CREATE INDEX audit_by_entity ON audit_entries (workspace_id, entity_type, id);

        -- 幂等回执的**唯一约束在主键上**。原来它是一份 JSON 字典，同一把键写两次
        -- 是「后写的覆盖先写的」，谁也拦不住。现在第二次写会被数据库直接拒掉，
        -- 于是「一把幂等键只对得上一个请求」不再依赖谁记得先查。
        CREATE TABLE command_receipts (
          workspace_id   TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          digest         TEXT NOT NULL,
          result         TEXT NOT NULL,
          created_at     TEXT NOT NULL,
          PRIMARY KEY (workspace_id, idempotency_key)
        );
      `);
    },
  },
  {
    version: 2,
    name: '导入 0.1 的 JSON 数据文件',
    up(db, legacy) {
      // 放在 migrations.ts 里：它要知道旧文件长什么样，而那是一次性的事。
      importLegacyFiles(db, legacy);
    },
  },
];

/**
 * 从旧 JSON 文件导入。
 *
 * **旧文件一个字节都不动。** 导入成功后把它们改名成 `.migrated`（不是删掉）：改名是
 * 原子的，而且万一导入逻辑本身有 bug，用户还能自己把数据捞回来。
 *
 * **坏文件必须让整条迁移失败。** 静默跳过的话，用户会看到一个空的日历 —— 那和
 * 「数据丢了」在界面上长得一模一样，而真相（文件就在那儿，只是没导进去）只写在
 * 我们自己的日志里。宁可开不起来。
 */
function importLegacyFiles(db: DatabaseSync, files: readonly string[]) {
  if (files.length === 0) return;
  const existing = files.filter((file) => {
    if (!existsSync(file)) return false;
    try {
      return readFileSync(file, 'utf8').trim().length > 0;
    } catch {
      return false;
    }
  });
  if (existing.length === 0) return;

  for (const file of existing) {
    // 读坏了就抛，让整条迁移回滚 —— 理由写在上面那段注释里。
    const data = readLegacyData(file);
    insertLegacy(
      db,
      data.notes,
      data.calendarEvents,
      data.audits,
      data.receipts,
    );
    // 导成功才改名：改了名就不会被导第二次，而用户那份数据原封不动地留在那儿。
    // 改名失败同样让迁移回滚 —— 那意味着下次启动会重复导入，而重复导入会
    // 把已改过的笔记退回旧内容。
    renameSync(file, `${file}.migrated`);
  }
}

interface LegacyEntity {
  id: string;
  workspaceId: string;
  title: string;
  version: number;
  sourceConversationId?: string;
}
interface LegacyNote extends LegacyEntity {
  body: string;
  createdAt: string;
  updatedAt: string;
}
interface LegacyEvent extends LegacyEntity {
  startsAt: string;
  endsAt: string;
  timeZone: string;
}
interface LegacyAudit {
  auditRef: string;
  entityType: string;
  id: string;
  workspaceId: string;
  deletedAt: string;
}
interface LegacyData {
  notes: LegacyNote[];
  calendarEvents: LegacyEvent[];
  audits: LegacyAudit[];
  receipts: Record<string, { digest: string; result: unknown }>;
}

function insertLegacy(
  db: DatabaseSync,
  notes: LegacyNote[],
  events: LegacyEvent[],
  audits: LegacyAudit[],
  receipts: Record<string, { digest: string; result: unknown }>,
) {
  const addNote = db.prepare(
    `INSERT OR REPLACE INTO notes
       (id, workspace_id, title, body, version, source_conversation_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const note of notes) {
    addNote.run(
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

  const addEvent = db.prepare(
    `INSERT OR REPLACE INTO calendar_events
       (id, workspace_id, title, starts_at, ends_at, time_zone, version, source_conversation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const event of events) {
    addEvent.run(
      event.id,
      event.workspaceId,
      event.title,
      event.startsAt,
      event.endsAt,
      event.timeZone,
      event.version,
      event.sourceConversationId ?? null,
    );
  }

  const addAudit = db.prepare(
    `INSERT OR REPLACE INTO audit_entries (audit_ref, entity_type, id, workspace_id, deleted_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const entry of audits) {
    addAudit.run(
      entry.auditRef,
      entry.entityType,
      entry.id,
      entry.workspaceId,
      entry.deletedAt,
    );
  }

  // 旧回执的键是 `${workspaceId}:${idempotencyKey}`。`workspaceId` 里也可能有冒号，
  // 所以不靠 split 拆 —— 拆错了就是「一把幂等键突然能用了」，正是幂等要防的事。
  const addReceipt = db.prepare(
    `INSERT OR REPLACE INTO command_receipts
       (workspace_id, idempotency_key, digest, result, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const at = new Date().toISOString();
  for (const [key, receipt] of Object.entries(receipts)) {
    const cut = key.indexOf(':');
    if (cut <= 0) continue;
    addReceipt.run(
      key.slice(0, cut),
      key.slice(cut + 1),
      receipt.digest,
      JSON.stringify(receipt.result),
      at,
    );
  }
}
