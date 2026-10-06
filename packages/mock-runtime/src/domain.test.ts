import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockClient } from './index';
import type { CommandContext, OneClient } from '../../contracts/src';

let client: OneClient;
afterEach(() => {
  client?.dispose();
});

const ctx = (overrides: Partial<CommandContext> = {}): CommandContext => ({
  requestId: crypto.randomUUID(),
  workspaceId: 'personal',
  source: 'ui',
  ...overrides,
});

const meeting = {
  title: '面试',
  startsAt: '2026-10-07T15:00:00+08:00',
  endsAt: '2026-10-07T16:00:00+08:00',
  timeZone: 'Asia/Shanghai',
};

describe('Calendar and Notes contracts', () => {
  it('creates one event per idempotency key and replays the same result', async () => {
    client = createMockClient();
    const input = { ...meeting, idempotencyKey: 'confirm-1' };
    const first = await client.calendarCreate(ctx(), input);
    const second = await client.calendarCreate(ctx(), input);
    expect(second).toEqual(first);
    expect(client.getSnapshot().calendarEvents).toHaveLength(1);
    expect(first.version).toBe(1);
  });

  it('rejects the same key reused for a different request', async () => {
    client = createMockClient();
    await client.calendarCreate(ctx(), { ...meeting, idempotencyKey: 'k1' });
    await expect(
      client.calendarCreate(ctx(), {
        ...meeting,
        title: '另一个日程',
        idempotencyKey: 'k1',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { idempotencyKey: 'k1' },
    });
    expect(client.getSnapshot().calendarEvents).toHaveLength(1);
  });

  it('keeps the newer note version when a stale writer retries', async () => {
    client = createMockClient();
    const note = await client.notesCreate(ctx(), {
      title: '会议记录',
      body: '第一版',
      idempotencyKey: 'n1',
    });
    const updated = await client.notesUpdate(ctx(), {
      id: note.id,
      expectedVersion: 1,
      patch: { body: '第二版' },
      idempotencyKey: 'n2',
    });
    expect(updated).toMatchObject({ version: 2, body: '第二版' });
    await expect(
      client.notesUpdate(ctx(), {
        id: note.id,
        expectedVersion: 1,
        patch: { body: '过期写入' },
        idempotencyKey: 'n3',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { expectedVersion: 1, currentVersion: 2 },
    });
    // The rejected draft must not overwrite anything.
    expect(client.getSnapshot().notes[0]).toMatchObject({
      version: 2,
      body: '第二版',
    });
  });

  it('validates time, time zone and unknown fields at the boundary', async () => {
    client = createMockClient();
    const create = (patch: Record<string, unknown>) =>
      client.calendarCreate(ctx(), {
        ...meeting,
        idempotencyKey: 'v',
        ...patch,
      });
    await expect(
      create({
        startsAt: '2026-10-07T16:00:00+08:00',
        endsAt: '2026-10-07T15:00:00+08:00',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      create({ endsAt: '2026-10-07T16:00:00' }),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(create({ timeZone: 'Mars/Olympus' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(create({ unknownField: 1 })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(
      client.notesUpdate(ctx(), {
        id: 'n',
        expectedVersion: 1,
        patch: {},
        idempotencyKey: 'v',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(client.getSnapshot().calendarEvents).toHaveLength(0);
  });

  it('lists overlapping events in range with a working cursor', async () => {
    client = createMockClient();
    for (const [index, day] of ['07', '08', '09'].entries()) {
      await client.calendarCreate(ctx(), {
        ...meeting,
        title: `第 ${index + 1} 天`,
        startsAt: `2026-10-${day}T09:00:00+08:00`,
        endsAt: `2026-10-${day}T10:00:00+08:00`,
        idempotencyKey: `day-${day}`,
      });
    }
    // Ends exactly at rangeStart, so it must not show up as an overlap.
    await client.calendarCreate(ctx(), {
      ...meeting,
      title: '前一天',
      startsAt: '2026-10-06T09:00:00+08:00',
      endsAt: '2026-10-07T00:00:00+08:00',
      idempotencyKey: 'day-06',
    });
    const range = {
      rangeStart: '2026-10-07T00:00:00+08:00',
      rangeEnd: '2026-10-10T00:00:00+08:00',
      timeZone: 'Asia/Shanghai',
    };
    const first = await client.calendarList(ctx(), { ...range, limit: 2 });
    expect(first.items.map((item) => item.title)).toEqual([
      '第 1 天',
      '第 2 天',
    ]);
    expect(first.nextCursor).toBe('2');
    const second = await client.calendarList(ctx(), {
      ...range,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.title)).toEqual(['第 3 天']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('returns note summaries without bodies and filters by keyword', async () => {
    client = createMockClient();
    await client.notesCreate(ctx(), {
      title: '路线图',
      body: '宠物窗口优先',
      idempotencyKey: 'a',
    });
    await client.notesCreate(ctx(), {
      title: '采购清单',
      body: '键盘',
      idempotencyKey: 'b',
    });
    const all = await client.notesList(ctx(), {});
    expect(all.items).toHaveLength(2);
    expect(all.items[0]).not.toHaveProperty('body');
    const found = await client.notesList(ctx(), { query: '键盘' });
    expect(found.items.map((item) => item.title)).toEqual(['采购清单']);
  });

  it('deletes once per key and leaves an audit reference', async () => {
    client = createMockClient();
    const note = await client.notesCreate(ctx(), {
      title: '待删除',
      body: '',
      idempotencyKey: 'd1',
    });
    const input = { id: note.id, expectedVersion: 1, idempotencyKey: 'd2' };
    const first = await client.notesDelete(ctx(), input);
    const again = await client.notesDelete(ctx(), input);
    expect(again).toEqual(first);
    expect(first.auditRef).toBeTruthy();
    await expect(
      client.notesDelete(ctx(), { ...input, idempotencyKey: 'd3' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(client.getSnapshot().notes).toHaveLength(0);
  });

  it('keeps workspaces separate and reports disposed clients', async () => {
    client = createMockClient();
    const other = ctx({ workspaceId: 'work' });
    const note = await client.notesCreate(other, {
      title: '公司笔记',
      body: '',
      idempotencyKey: 'shared',
    });
    expect((await client.notesList(ctx(), {})).items).toHaveLength(0);
    await expect(
      client.notesUpdate(ctx(), {
        id: note.id,
        expectedVersion: 1,
        patch: { title: '越权' },
        idempotencyKey: 'x',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const local = await client.notesCreate(ctx(), {
      title: '个人笔记',
      body: '',
      idempotencyKey: 'shared',
    });
    expect(local.id).not.toBe(note.id);
    client.dispose();
    await expect(client.notesList(ctx(), {})).rejects.toMatchObject({
      code: 'DISPOSED',
    });
  });

  it('notifies subscribers on domain changes and isolates snapshot copies', async () => {
    client = createMockClient();
    const listener = vi.fn();
    client.subscribe(listener);
    await client.calendarCreate(ctx(), { ...meeting, idempotencyKey: 'n' });
    expect(listener).toHaveBeenCalledTimes(1);
    await client.notesList(ctx(), {});
    expect(listener).toHaveBeenCalledTimes(1);
    const snapshot = client.getSnapshot();
    snapshot.calendarEvents.length = 0;
    expect(client.getSnapshot().calendarEvents).toHaveLength(1);
  });
});
