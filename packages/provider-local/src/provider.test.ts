import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalProvider } from './provider.ts';

/**
 * 本地文件提供方的行为（ADR-016）。
 *
 * 最要紧的一条是「数据归提供方」：本体崩了、重启了，这些数据还在 —— 因为数据
 * 从来就不在本体里。剩下的用例守住幂等、版本冲突与坏文件不覆盖，都是用户数据
 * 相关的边界，出错时不能悄悄改坏。
 */

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'one-provider-'));
  dirs.push(dir);
  return path.join(dir, 'calendar.json');
};

afterEach(() => {
  // 目录留在系统临时区，由系统清理；这里刻意不做删除。
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

describe('本地文件提供方', () => {
  it('数据落在自己的文件里，进程重建后仍在', async () => {
    const file = scratch();
    const first = createLocalProvider(file, 'calendar');
    await first.create(context, { ...meeting, idempotencyKey: 'k1' });

    // 模拟提供方重启：换一个实例，从同一个文件读。
    const second = createLocalProvider(file, 'calendar');
    const page = (await second.list(context, {
      rangeStart: '2026-10-07T00:00:00+08:00',
      rangeEnd: '2026-10-08T00:00:00+08:00',
      timeZone: 'Asia/Shanghai',
      limit: 20,
    })) as { items: { title: string }[] };
    expect(page.items.map((item) => item.title)).toEqual(['面试']);
  });

  it('幂等回执也落盘，重启后重复确认不会建出第二条', async () => {
    const file = scratch();
    const first = createLocalProvider(file, 'calendar');
    const created = await first.create(context, {
      ...meeting,
      idempotencyKey: 'same',
    });

    const second = createLocalProvider(file, 'calendar');
    const again = await second.create(context, {
      ...meeting,
      idempotencyKey: 'same',
    });
    expect(again).toEqual(created);
    const page = (await second.list(context, {
      rangeStart: '2026-10-07T00:00:00+08:00',
      rangeEnd: '2026-10-08T00:00:00+08:00',
      timeZone: 'Asia/Shanghai',
      limit: 20,
    })) as { items: unknown[] };
    expect(page.items).toHaveLength(1);
  });

  it('同一把幂等键配不同内容要报冲突，而不是改写已有日程', async () => {
    const provider = createLocalProvider(scratch(), 'calendar');
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
    const provider = createLocalProvider(scratch(), 'calendar');
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
    const provider = createLocalProvider(scratch(), 'notes');
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

  it('数据文件损坏时拒绝启动，绝不拿空数据覆盖它', () => {
    const file = scratch();
    writeFileSync(file, '{ 这不是 JSON', 'utf8');
    // 静默当成空库的话，用户会以为日程全没了，而不是文件坏了。
    expect(() => createLocalProvider(file, 'calendar')).toThrow(/损坏/);
  });
});
