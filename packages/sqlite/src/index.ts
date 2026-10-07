import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite 的共用装配（本体与本地提供方各有一个库，配置必须一模一样）。
 *
 * 这几行 pragma 与事务助手放在**一处**是有理由的，不是为了少写代码：
 *
 * - **pragma 是「每连接」的设置**，不是库文件里的。换个连接读 `PRAGMA busy_timeout`
 *   永远是 0 —— 这一条已经骗过我一次，差点被当成 bug 写进 ADR-027。两处各写一遍的
 *   时候，迟早有一处忘了某一条，于是两个库的行为悄悄不一样。
 * - **`transaction` 的语义是契约**：`BEGIN IMMEDIATE` 而不是默认的 `BEGIN`。
 *   默认那一档是「用到才升级锁」，两个写者同时开始会在中途才发现撞车，整段白做。
 *   两边行为不一致的话，并发下出问题的是没设对的那一个。
 */

export interface SqliteDatabase {
  readonly db: DatabaseSync;
  readonly file: string;
  close(): void;
}

/**
 * 打开一个库并配好 pragma。父目录没有会建。
 *
 * **关两次就当没关过。** SIGINT、管道断开与正常退出路径可能先后都调一遍收尾 ——
 * 一个只该清理一次的动作，不该在第二次调用时把进程带崩。
 */
export function openSqlite(file: string): SqliteDatabase {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // WAL：读写不互相阻塞，提交是先写日志再改主文件，断电时最多丢最后一条。
  db.exec('PRAGMA journal_mode = WAL');
  // 用户的数据只有几十条，一次写入几毫秒 —— 省那点时间不值得。
  db.exec('PRAGMA synchronous = FULL');
  // 外键在本体的会话库里真的用到了（对话指向工作区），提供方那边用不到但开着无害。
  db.exec('PRAGMA foreign_keys = ON');
  // 另一个进程短暂占着库时先等，而不是立刻抛 SQLITE_BUSY。用户完全可能开两个 ONE。
  db.exec('PRAGMA busy_timeout = 5000');

  let closed = false;
  return {
    db,
    file,
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

/**
 * 把 `fn` 包在一个事务里。
 *
 * 嵌套调用不加判断 —— 各处的写操作都是完整的一笔，没有「事务里再开事务」这回事；
 * 真有的话 SQLite 会直接报错，比悄悄变成两笔事务好。
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚本身失败（比如连接已经断了）不能盖掉真正的错误 —— 那才是用户要看的。
    }
    throw error;
  }
}

/**
 * 把库另存一份完整快照（ADR-027）。
 *
 * 用 `VACUUM INTO` 而不是拷文件：拷文件会把 WAL 里还没并回主文件的部分落下，备份
 * 出来的是「主文件 + 碰运气凑出来的 -wal」。`VACUUM INTO` 给的是某个时刻的完整快照。
 */
export function backupTo(db: DatabaseSync, target: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
}
