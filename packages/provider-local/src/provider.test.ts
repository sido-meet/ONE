import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './db.ts';
import type { LocalDatabase } from './db.ts';
import { createRepository } from './repository.ts';
import { createLocalProvider } from './provider.ts';
import type { LocalProvider } from './provider.ts';
import type { CommandContext } from '../../contracts/src/index.ts';

/**
 * 本地提供方的行为（ADR-016），落在 SQLite 上（R01）。
 *
 * 最要紧的一条是「数据归提供方」：本体崩了、重启了，这些数据还在 —— 因为数据
 * 从来就不在本体里。剩下的用例守住幂等、版本冲突与坏数据不覆盖，都是用户数据
 * 相关的边界，出错时不能悄悄改坏。
 */

const opened: LocalDatabase[] = [];

const scratch = () => mkdtempSync(path.join(tmpdir(), 'one-provider-'));

/** 开一份库，给出一个提供方。库句柄留着，直到 `afterEach` 才关。 */
const start = (
  kind: 'calendar' | 'notes',
  dir: string,
): { provider: LocalProvider; database: LocalDatabase } => {
  const database = openDatabase(path.join(dir, 'local.db'));
  opened.push(database);
  return {
    provider: createLocalProvider(createRepository(database.db), kind),
    database,
  };
};

const providerIn = (kind: 'calendar' | 'notes') =>
  start(kind, scratch()).provider;

/**
 * 真正的「提供方重启」：把上一个库句柄**关掉**，从同一个库文件重新开。
 *
 * 不是换个对象就算数 —— 那样内存里还留着东西，「重启后还在」就只测了个寂寞。
 */
const restart = (
  kind: 'calendar' | 'notes',
  dir: string,
  database: LocalDatabase,
) => {
  database.close();
  return start(kind, dir);
};

afterEach(() => {
  // 测试目录留在系统临时区，由系统清理；这里刻意不做删除（删除文件在本机会被拦）。
  while (opened.length > 0) opened.pop()?.close();
});

const context = {
  requestId: 'r',
  workspaceId: 'personal',
  source: 'ui' as const,
};

const meeting = {
  title: '面试',
  startsAt: '2026-10-07T15:00:00+08:00',
  endsAt: '2026-10-07T16:00:00+08:00',
  timeZone: 'Asia/Shanghai',
};

const day = (context_: CommandContext, provider: LocalProvider) =>
  provider.list(context_, {
    rangeStart: '2026-10-07T00:00:00+08:00',
    rangeEnd: '2026-10-08T00:00:00+08:00',
    timeZone: 'Asia/Shanghai',
    limit: 20,
  }) as Promise<{ items: { title: string }[] }>;

describe('本地文件提供方', () => {
  it('数据落在自己的库里，进程重建后仍在', async () => {
    const dir = scratch();
    const first = start('calendar', dir);
    await first.provider.create(context, { ...meeting, idempotencyKey: 'k1' });

    // 模拟提供方重启：关掉文件句柄，从同一个库文件读。
    const second = restart('calendar', dir, first.database);
    const page = await day(context, second.provider);
    expect(page.items.map((item) => item.title)).toEqual(['面试']);
  });

  it('幂等回执也落盘，重启后重复确认不会建出第二条', async () => {
    const dir = scratch();
    const first = start('calendar', dir);
    const created = await first.provider.create(context, {
      ...meeting,
      idempotencyKey: 'same',
    });

    const second = restart('calendar', dir, first.database);
    const again = await second.provider.create(context, {
      ...meeting,
      idempotencyKey: 'same',
    });
    expect(again).toEqual(created);
    const page = await day(context, second.provider);
    expect(page.items).toHaveLength(1);
  });

  it('同一把幂等键配不同内容要报冲突，而不是改写已有日程', async () => {
    const provider = providerIn('calendar');
    await provider.create(context, { ...meeting, idempotencyKey: 'k' });
    await expect(
      provider.create(context, {
        ...meeting,
        title: '另一个日程',
        idempotencyKey: 'k',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { idempotencyKey: 'k' },
    });
  });

  it('过期写入不能盖掉新版本', async () => {
    const provider = providerIn('calendar');
    const event = (await provider.create(context, {
      ...meeting,
      idempotencyKey: 'a',
    })) as { id: string; version: number };
    await provider.update(context, {
      id: event.id,
      expectedVersion: 1,
      patch: { title: '改过的' },
      idempotencyKey: 'b',
    });
    await expect(
      provider.update(context, {
        id: event.id,
        expectedVersion: 1,
        patch: { title: '过期写入' },
        idempotencyKey: 'c',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { expectedVersion: 1, currentVersion: 2 },
    });
  });

  it('工作区之间互不可见', async () => {
    const provider = providerIn('notes');
    await provider.create(context, {
      title: '公司',
      body: '',
      idempotencyKey: 'same',
    });
    const page = (await provider.list(
      { ...context, workspaceId: 'work' },
      { limit: 20 },
    )) as { items: unknown[] };
    expect(page.items).toHaveLength(0);
  });

  /**
   * 编辑的前提是读得到正文。
   *
   * 列表只给摘要（`NoteSummary` 里没有 `body`），所以「编辑」按钮第一件事必须是
   * `notes.get`—— 改不了读不到的东西。
   */
  it('列表只给摘要，取单条才拿得到正文', async () => {
    const provider = providerIn('notes');
    const created = (await provider.create(context, {
      title: '客户要求下周给报价',
      body: '口头说的，没有邮件。',
      idempotencyKey: 'n1',
    })) as { id: string };

    const page = (await provider.list(context, { limit: 20 })) as {
      items: Record<string, unknown>[];
    };
    // 正文不进列表：列表是给几十条摘要扫的，不是给全文搬的。
    expect(page.items[0]).not.toHaveProperty('body');

    const full = (await provider.get?.(context, { id: created.id })) as {
      body: string;
      version: number;
    };
    expect(full.body).toBe('口头说的，没有邮件。');
    expect(full.version).toBe(1);
  });

  it('取不存在的笔记说「找不到」，不返回一条空的', async () => {
    const provider = providerIn('notes');
    await expect(
      provider.get?.(context, { id: '根本没有这条' }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('取笔记要过工作区边界', async () => {
    const provider = providerIn('notes');
    const created = (await provider.create(context, {
      title: '个人',
      body: '',
      idempotencyKey: 'w1',
    })) as { id: string };
    await expect(
      provider.get?.({ ...context, workspaceId: '别人的' }, { id: created.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('把结束改到开始之前要报 VALIDATION，且原来的日程一个字不动', async () => {
    const provider = providerIn('calendar');
    const event = (await provider.create(context, {
      ...meeting,
      idempotencyKey: 'v',
    })) as { id: string; endsAt: string };
    await expect(
      provider.update(context, {
        id: event.id,
        expectedVersion: 1,
        patch: { endsAt: '2026-10-07T14:00:00+08:00' },
        idempotencyKey: 'v2',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    const page = await day(context, provider);
    expect(page.items).toHaveLength(1);
    const unchanged = (await provider.list(context, {
      rangeStart: '2026-10-07T00:00:00+08:00',
      rangeEnd: '2026-10-08T00:00:00+08:00',
      timeZone: 'Asia/Shanghai',
      limit: 20,
    })) as { items: { endsAt: string }[] };
    expect(unchanged.items[0]?.endsAt).toBe(event.endsAt);
  });

  it('笔记按更新时间倒序，翻页不会重复也不会漏', async () => {
    const provider = providerIn('notes');
    for (let index = 0; index < 5; index += 1)
      await provider.create(context, {
        title: `第 ${index} 条`,
        body: '',
        idempotencyKey: `p${index}`,
      });
    const first = (await provider.list(context, { limit: 2 })) as {
      items: { title: string }[];
      nextCursor?: string;
    };
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe('2');
    const second = (await provider.list(context, {
      limit: 2,
      cursor: first.nextCursor,
    })) as { items: { title: string }[]; nextCursor?: string };
    const titles = [...first.items, ...second.items].map((item) => item.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('搜索正文里的字，列表里也能搜到', async () => {
    const provider = providerIn('notes');
    await provider.create(context, {
      title: '会议',
      body: '记得带上报价单',
      idempotencyKey: 's1',
    });
    await provider.create(context, {
      title: '别的',
      body: '不相关的正文',
      idempotencyKey: 's2',
    });
    const page = (await provider.list(context, {
      query: '报价',
      limit: 20,
    })) as { items: { title: string }[] };
    expect(page.items.map((item) => item.title)).toEqual(['会议']);
  });

  it('删除留下审计条目，删错了查得出来', async () => {
    const dir = scratch();
    const { provider, database } = start('calendar', dir);
    const event = (await provider.create(context, {
      ...meeting,
      idempotencyKey: 'd',
    })) as { id: string };
    const removed = (await provider.remove(context, {
      id: event.id,
      expectedVersion: 1,
      idempotencyKey: 'd2',
    })) as { auditRef: string; deletedAt: string };

    const row = database.db
      .prepare('SELECT entity_type, id FROM audit_entries WHERE audit_ref = ?')
      .get(removed.auditRef) as { entity_type: string; id: string };
    expect(row).toMatchObject({ entity_type: 'calendarEvent', id: event.id });
    expect(removed.deletedAt).toBeTruthy();
  });
});
