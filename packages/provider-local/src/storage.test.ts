import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, transaction } from './db.ts';
import type { LocalDatabase } from './db.ts';
import { createRepository } from './repository.ts';
import { createLocalProvider } from './provider.ts';
import type { LocalProvider } from './provider.ts';
import type { CommandContext } from '../../contracts/src/index.ts';
import {
  parseCalendarCreate,
  requestDigest,
} from '../../contracts/src/index.ts';

/**
 * 迁移与事务边界（R01）。
 *
 * 这些用例守的都是「用户的数据不能被一次升级弄丢」。0.1 用的是「整份 JSON 读出来、
 * 改完整份写回去」，所以从来不需要迁移；换成 SQLite 之后，多了一整个「旧数据怎么进来
 * 的」环节，那个环节出错的代价就是用户的日程和笔记。
 *
 * 两条规矩贯穿本文件：
 *
 * 1. **每条迁移各自一个事务。** 失败就回滚，版本号也不写进去，下次启动原样重来。
 * 2. **旧文件一个字节都不动。** 导成功也只是改名成 `.migrated`。
 */

const opened: LocalDatabase[] = [];
const scratch = () => mkdtempSync(path.join(tmpdir(), 'one-migrate-'));

const start = (
  kind: 'calendar' | 'notes',
  dir: string,
  legacy: string[] = [],
): { provider: LocalProvider; database: LocalDatabase } => {
  const database = openDatabase(path.join(dir, 'local.db'), legacy);
  opened.push(database);
  return {
    provider: createLocalProvider(createRepository(database.db), kind),
    database,
  };
};

/** 重启：关掉句柄，从同一个库文件重新开。 */
const restart = (
  kind: 'calendar' | 'notes',
  dir: string,
  database: LocalDatabase,
): { provider: LocalProvider; database: LocalDatabase } => {
  database.close();
  return start(kind, dir);
};

afterEach(() => {
  while (opened.length > 0) opened.pop()?.close();
});

const context: CommandContext = {
  requestId: 'r',
  workspaceId: 'personal',
  source: 'ui',
};

const legacyFile = (dir: string, name: string, data: unknown) => {
  const file = path.join(dir, name);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return file;
};

const legacyCalendar = {
  notes: [],
  calendarEvents: [
    {
      id: 'evt-1',
      workspaceId: 'personal',
      title: '0.1 时代的面试',
      startsAt: '2026-10-07T15:00:00+08:00',
      endsAt: '2026-10-07T16:00:00+08:00',
      timeZone: 'Asia/Shanghai',
      version: 3,
    },
  ],
  audits: [],
  // 回执里的 digest 是**真的算出来的**：0.1 存的就是 `requestDigest(parsed)`，
  // 编一个假的出来，这条用例就验不到「重放」而只验到「冲突」。
  receipts: {
    'personal:key-1': {
      digest: requestDigest(
        parseCalendarCreate({
          title: '0.1 时代的面试',
          startsAt: '2026-10-07T15:00:00+08:00',
          endsAt: '2026-10-07T16:00:00+08:00',
          timeZone: 'Asia/Shanghai',
          idempotencyKey: 'key-1',
        }),
      ),
      result: { id: 'evt-1' },
    },
  },
};

const legacyNotes = {
  notes: [
    {
      id: 'note-1',
      workspaceId: 'personal',
      title: '0.1 时代的笔记',
      body: '正文还在。',
      version: 2,
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-02T10:00:00.000Z',
    },
  ],
  calendarEvents: [],
  audits: [],
  receipts: {},
};

describe('从 0.1 的 JSON 数据迁移过来', () => {
  it('两个身份的旧文件一起导进同一个库，日历与笔记都在', async () => {
    const dir = scratch();
    const calendarFile = legacyFile(dir, 'local.calendar.json', legacyCalendar);
    const notesFile = legacyFile(dir, 'local.notes.json', legacyNotes);
    const { provider: calendar } = start('calendar', dir, [
      calendarFile,
      notesFile,
    ]);
    const { provider: notes } = start('notes', dir, [calendarFile, notesFile]);

    const events = (await calendar.list(context, {
      rangeStart: '2026-10-07T00:00:00+08:00',
      rangeEnd: '2026-10-08T00:00:00+08:00',
      timeZone: 'Asia/Shanghai',
      limit: 20,
    })) as { items: { title: string; version: number }[] };
    expect(events.items).toHaveLength(1);
    expect(events.items[0]).toMatchObject({
      title: '0.1 时代的面试',
      version: 3,
    });

    const summaries = (await notes.list(context, { limit: 20 })) as {
      items: { title: string }[];
    };
    expect(summaries.items.map((item) => item.title)).toEqual([
      '0.1 时代的笔记',
    ]);
  });

  it('版本号跟着过来 —— 拿旧版本号保存不会误判成冲突', async () => {
    const dir = scratch();
    const calendarFile = legacyFile(dir, 'local.calendar.json', legacyCalendar);
    const { provider } = start('calendar', dir, [calendarFile]);
    const saved = (await provider.update(context, {
      id: 'evt-1',
      expectedVersion: 3,
      patch: { title: '改过的面试' },
      idempotencyKey: 'after-migrate',
    })) as { version: number; title: string };
    expect(saved).toMatchObject({ version: 4, title: '改过的面试' });
  });

  it('幂等回执也跟着过来，重启后重复确认不会建出第二条', async () => {
    const dir = scratch();
    const calendarFile = legacyFile(dir, 'local.calendar.json', legacyCalendar);
    const first = start('calendar', dir, [calendarFile]);
    // 回执确实跟着过来了。
    const imported = first.database.db
      .prepare(
        'SELECT idempotency_key FROM command_receipts WHERE workspace_id = ?',
      )
      .all('personal') as { idempotency_key: string }[];
    expect(imported.map((row) => row.idempotency_key)).toEqual(['key-1']);

    // 重启：关掉句柄，重新开。旧文件已经改名，不会被导第二次。
    const second = restart('calendar', dir, first.database);
    expect(existsSync(calendarFile)).toBe(false);
    expect(existsSync(`${calendarFile}.migrated`)).toBe(true);

    const page = (await second.provider.list(context, {
      rangeStart: '2026-10-07T00:00:00+08:00',
      rangeEnd: '2026-10-08T00:00:00+08:00',
      timeZone: 'Asia/Shanghai',
      limit: 20,
    })) as { items: unknown[] };
    expect(page.items).toHaveLength(1);

    // 拿那把旧幂等键再来一次：回执认得，返回原来的结果，不建第二条。
    const replayed = (await second.provider.create(context, {
      title: '0.1 时代的面试',
      startsAt: '2026-10-07T15:00:00+08:00',
      endsAt: '2026-10-07T16:00:00+08:00',
      timeZone: 'Asia/Shanghai',
      idempotencyKey: 'key-1',
    })) as { id: string };
    expect(replayed.id).toBe('evt-1');
  });

  it('旧文件改名为 .migrated，内容一个字节没动', () => {
    const dir = scratch();
    const original = `${JSON.stringify(legacyCalendar, null, 2)}\n`;
    const calendarFile = path.join(dir, 'local.calendar.json');
    writeFileSync(calendarFile, original, 'utf8');
    start('calendar', dir, [calendarFile]);
    const renamed = `${calendarFile}.migrated`;
    expect(existsSync(calendarFile)).toBe(false);
    expect(readFileSync(renamed, 'utf8')).toBe(original);
  });

  it('空文件当作「没有旧数据」，不报错也不导空数组', () => {
    const dir = scratch();
    const calendarFile = path.join(dir, 'local.calendar.json');
    writeFileSync(calendarFile, '   \n', 'utf8');
    const { database } = start('calendar', dir, [calendarFile]);
    const rows = database.db
      .prepare('SELECT count(*) AS c FROM calendar_events')
      .get() as {
      c: number;
    };
    expect(Number(rows.c)).toBe(0);
    // 空文件不改名：它不是数据，删不删都无所谓，但改名会让「用户刚清空的文件」
    // 在下一次升级时又被当成旧数据看一遍。
    expect(existsSync(calendarFile)).toBe(true);
  });
});

describe('迁移失败可回滚', () => {
  it('旧文件坏掉时拒绝开库，而不是导出一个空的日历', () => {
    const dir = scratch();
    const calendarFile = path.join(dir, 'local.calendar.json');
    writeFileSync(calendarFile, '{ 这不是 JSON', 'utf8');
    // 静默跳过的话，用户会看到一个空的日历 —— 那和「数据丢了」在界面上长得一模一样，
    // 而真相（文件就在那个目录里）只写在日志里。
    expect(() => start('calendar', dir, [calendarFile])).toThrow(
      /损坏|拒绝导入/,
    );
  });

  it('回滚之后库里一条数据都没有，也没有记下「迁移过了」', () => {
    const dir = scratch();
    const calendarFile = legacyFile(dir, 'local.calendar.json', legacyCalendar);
    const broken = legacyFile(dir, 'local.notes.json', { notes: '这不是数组' });
    expect(() => start('calendar', dir, [calendarFile, broken])).toThrow(
      /不是数组|拒绝导入/,
    );

    // **不经过 openDatabase** 去看那份失败之后的库：openDatabase 会再跑一次迁移，
    // 而那样就看不出上一次留下了什么。用原生句柄打开，读到的东西才是失败现场。
    const raw = new DatabaseSync(path.join(dir, 'local.db'));
    const rows = raw
      .prepare('SELECT count(*) AS c FROM calendar_events')
      .get() as { c: number };
    expect(Number(rows.c)).toBe(0);
    const applied = raw
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as { version: number }[];
    // 第 1 版建表进去了（表确实在那儿），第 2 版没记 —— 下次启动还会原样再试一次。
    expect(applied.map((row) => Number(row.version))).toEqual([1]);
    raw.close();
  });

  it('坏文件原封不动地留在那儿，修好了下次启动自己接上', async () => {
    const dir = scratch();
    const calendarFile = legacyFile(dir, 'local.calendar.json', legacyCalendar);
    const broken = legacyFile(dir, 'local.notes.json', '{ 半截');
    expect(() => start('calendar', dir, [calendarFile, broken])).toThrow();

    // 用户（或我们）修好了那个文件。
    writeFileSync(broken, JSON.stringify(legacyNotes), 'utf8');
    const { provider } = start('notes', dir, [calendarFile, broken]);
    const page = (await provider.list(context, { limit: 20 })) as {
      items: { title: string }[];
    };
    expect(page.items.map((item) => item.title)).toEqual(['0.1 时代的笔记']);
  });
});

describe('迁移之前先备份', () => {
  it('有数据又有新版本要迁时，先落一份备份', () => {
    const dir = scratch();
    const { database } = start('calendar', dir);
    database.db
      .prepare(
        `INSERT INTO calendar_events
           (id, workspace_id, title, starts_at, ends_at, time_zone, version)
         VALUES ('e', 'personal', '迁移前建的', '2026-10-07T15:00:00+08:00',
                 '2026-10-07T16:00:00+08:00', 'Asia/Shanghai', 1)`,
      )
      .run();
    // 手工把「已应用的版本」退回去一格，模拟「又发了一版迁移」。
    database.db
      .prepare('DELETE FROM schema_migrations WHERE version = 2')
      .run();
    database.close();

    const again = openDatabase(path.join(dir, 'local.db'));
    opened.push(again);
    expect(again.backup).toBeTruthy();
    expect(existsSync(again.backup!)).toBe(true);
    const backup = openDatabase(again.backup!);
    const row = backup.db
      .prepare('SELECT title FROM calendar_events')
      .get() as {
      title: string;
    };
    backup.close();
    expect(row.title).toBe('迁移前建的');
  });

  it('全新库第一次建表不备份 —— 那时没有任何可丢的东西', () => {
    const dir = scratch();
    const { database } = start('calendar', dir);
    expect(database.backup).toBeUndefined();
  });

  it('备份是某个时刻的完整快照，不是主文件加一个碰运气的 -wal', () => {
    const dir = scratch();
    const { database } = start('notes', dir);
    database.db
      .prepare(
        `INSERT INTO notes (id, workspace_id, title, body, version, created_at, updated_at)
         VALUES ('n', 'personal', '备份里的笔记', '正文', 1, '2026-10-01T00:00:00.000Z',
                 '2026-10-01T00:00:00.000Z')`,
      )
      .run();
    const target = path.join(dir, 'backups', 'snapshot.db');
    database.backupTo(target);
    database.close();

    // 只把 .db 拿出去，不要 -wal / -shm，读出来必须已经是完整的。
    const snapshot = openDatabase(target);
    const row = snapshot.db.prepare('SELECT title FROM notes').get() as {
      title: string;
    };
    snapshot.close();
    expect(row.title).toBe('备份里的笔记');
  });
});

describe('事务与唯一约束', () => {
  it('回执那条路走不通时，实体也不会留下', async () => {
    const dir = scratch();
    const { provider, database } = start('calendar', dir);
    const when = (day: string, title: string) => ({
      title,
      startsAt: `2026-10-0${day}T15:00:00+08:00`,
      endsAt: `2026-10-0${day}T16:00:00+08:00`,
      timeZone: 'Asia/Shanghai',
    });
    await provider.create(context, {
      ...when('7', '第一条'),
      idempotencyKey: 'k',
    });

    // 同一把键配另一份内容：回执判定冲突，实体那一步也就跟着回滚了。
    await expect(
      provider.create(context, {
        ...when('8', '插不进去'),
        idempotencyKey: 'k',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const rows = database.db
      .prepare('SELECT title FROM calendar_events ORDER BY title')
      .all() as { title: string }[];
    expect(rows.map((row) => row.title)).toEqual(['第一条']);
  });

  it('事务里任何一步抛错，前面做过的都不算数', () => {
    const dir = scratch();
    const { database } = start('notes', dir);
    database.db
      .prepare(
        `INSERT INTO notes (id, workspace_id, title, body, version, created_at, updated_at)
         VALUES ('n', 'personal', '原标题', '正文', 1, '2026-10-01T00:00:00.000Z',
                 '2026-10-01T00:00:00.000Z')`,
      )
      .run();
    // 仓储里的每一次写都是「改实体 + 写回执」两笔，靠的就是这一句：抛了就都不算数。
    expect(() =>
      transaction(database.db, () => {
        database.db
          .prepare('UPDATE notes SET title = ? WHERE id = ?')
          .run('改了一半', 'n');
        throw new Error('半路失败');
      }),
    ).toThrow(/半路失败/);
    const row = database.db.prepare('SELECT title FROM notes').get() as {
      title: string;
    };
    expect(row.title).toBe('原标题');
  });

  it('没有事务助手这件事就守不住 —— 改一次语句不会偷偷带上事务', async () => {
    // 这条不是形式：以前版本守卫是「读出来比一比」，比与写之间有缝。
    // 现在 WHERE 里的 version 与改写在同一条语句里，中间没有缝。
    const dir = scratch();
    const { provider, database } = start('notes', dir);
    const note = (await provider.create(context, {
      title: '原标题',
      body: 'x',
      idempotencyKey: 'v',
    })) as { id: string };
    await provider.update(context, {
      id: note.id,
      expectedVersion: 1,
      patch: { title: '第 2 版' },
      idempotencyKey: 'v2',
    });
    const statement = database.db.prepare(
      'UPDATE notes SET title = ? WHERE id = ? AND workspace_id = ? AND version = ?',
    );
    expect(statement.run('偷偷改的', note.id, 'personal', 1).changes).toBe(0);
    expect(statement.run('也改不动', note.id, '另一个工作区', 2).changes).toBe(
      0,
    );
    expect(statement.run('这次才对', note.id, 'personal', 2).changes).toBe(1);
  });

  it('幂等键的主键就是那把键 —— 绕开查询直接写也会被数据库拒掉', () => {
    const dir = scratch();
    const { database } = start('calendar', dir);
    const insert = database.db.prepare(
      `INSERT INTO command_receipts (workspace_id, idempotency_key, digest, result, created_at)
       VALUES (?, ?, ?, '{}', '2026-10-01T00:00:00.000Z')`,
    );
    insert.run('personal', 'k', 'd1');
    // 「先查后写」那一步现在是多余的：这条约束才是真正的保证。
    expect(() => insert.run('personal', 'k', 'd2')).toThrow(/UNIQUE/);
  });

  it('同一把键在不同工作区各算一次', () => {
    const dir = scratch();
    const { database } = start('notes', dir);
    const insert = database.db.prepare(
      `INSERT INTO command_receipts (workspace_id, idempotency_key, digest, result, created_at)
       VALUES (?, ?, ?, '{}', '2026-10-01T00:00:00.000Z')`,
    );
    insert.run('personal', 'same', 'd1');
    expect(() => insert.run('work', 'same', 'd2')).not.toThrow();
  });

  it('版本守卫写在语句里：过期的写入改不动任何一行', async () => {
    const dir = scratch();
    const { provider, database } = start('calendar', dir);
    const event = (await provider.create(context, {
      title: '原标题',
      startsAt: '2026-10-07T15:00:00+08:00',
      endsAt: '2026-10-07T16:00:00+08:00',
      timeZone: 'Asia/Shanghai',
      idempotencyKey: 'g',
    })) as { id: string };
    await provider.update(context, {
      id: event.id,
      expectedVersion: 1,
      patch: { title: '第 2 版' },
      idempotencyKey: 'g2',
    });
    // 直接用过期版本号去改：0 行，不是 1 行。
    const changed = database.db
      .prepare(
        'UPDATE calendar_events SET title = ? WHERE id = ? AND version = ?',
      )
      .run('偷偷改的', event.id, 1).changes;
    expect(changed).toBe(0);
    const row = database.db
      .prepare('SELECT title FROM calendar_events')
      .get() as {
      title: string;
    };
    expect(row.title).toBe('第 2 版');
  });

  it('版本冲突的事务里不会留下回执', async () => {
    const dir = scratch();
    const { provider, database } = start('calendar', dir);
    const event = (await provider.create(context, {
      title: '原标题',
      startsAt: '2026-10-07T15:00:00+08:00',
      endsAt: '2026-10-07T16:00:00+08:00',
      timeZone: 'Asia/Shanghai',
      idempotencyKey: 'c1',
    })) as { id: string };
    await expect(
      provider.update(context, {
        id: event.id,
        expectedVersion: 99,
        patch: { title: '不会写进去' },
        idempotencyKey: 'c2',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // 回执是同一笔事务里写的：冲突回滚了，它也不该在。
    const receipt = database.db
      .prepare('SELECT 1 FROM command_receipts WHERE idempotency_key = ?')
      .get('c2');
    expect(receipt).toBeUndefined();
  });
});
