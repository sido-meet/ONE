import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryProviders } from './domain.ts';
import type { MemoryProviders } from './domain.ts';
import {
  parseCalendarCreate,
  parseCalendarList,
  parseNotesCreate,
  parseNotesUpdate,
} from '../../contracts/src/index.ts';
import type { CommandContext } from '../../contracts/src/index.ts';

let providers: MemoryProviders;
afterEach(() => {
  providers?.dispose();
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

/** 走真实链路：先在边界解析，再交给端口。提供方自己不再校验（ADR-016）。 */
const createEvent = (context: CommandContext, raw: Record<string, unknown>) =>
  providers.calendar.create(context, parseCalendarCreate(raw));

const listEvents = (context: CommandContext, raw: Record<string, unknown>) =>
  providers.calendar.list(context, parseCalendarList(raw));

const createNote = (context: CommandContext, raw: Record<string, unknown>) =>
  providers.notes.create(context, parseNotesCreate(raw));

const updateNote = (context: CommandContext, raw: Record<string, unknown>) =>
  providers.notes.update(context, parseNotesUpdate(raw));

describe('Calendar and Notes provider contracts', () => {
  it('creates one event per idempotency key and replays the same result', async () => {
    providers = createMemoryProviders();
    const input = { ...meeting, idempotencyKey: 'confirm-1' };
    const first = await createEvent(ctx(), input);
    const second = await createEvent(ctx(), input);
    expect(second).toEqual(first);
    expect(providers.read().calendarEvents).toHaveLength(1);
    expect(first.version).toBe(1);
  });

  it('rejects the same key reused for a different request', async () => {
    providers = createMemoryProviders();
    await createEvent(ctx(), { ...meeting, idempotencyKey: 'k1' });
    await expect(
      createEvent(ctx(), {
        ...meeting,
        title: '另一个日程',
        idempotencyKey: 'k1',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { idempotencyKey: 'k1' },
    });
    expect(providers.read().calendarEvents).toHaveLength(1);
  });

  it('keeps the newer note version when a stale writer retries', async () => {
    providers = createMemoryProviders();
    const note = await createNote(ctx(), {
      title: '会议记录',
      body: '第一版',
      idempotencyKey: 'n1',
    });
    const updated = await updateNote(ctx(), {
      id: note.id,
      expectedVersion: 1,
      patch: { body: '第二版' },
      idempotencyKey: 'n2',
    });
    expect(updated).toMatchObject({ version: 2, body: '第二版' });
    await expect(
      updateNote(ctx(), {
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
    expect(providers.read().notes[0]).toMatchObject({
      version: 2,
      body: '第二版',
    });
  });

  it('validates time, time zone and unknown fields at the boundary', () => {
    providers = createMemoryProviders();
    const invalid = (patch: Record<string, unknown>) => () =>
      parseCalendarCreate({
        ...meeting,
        idempotencyKey: 'v',
        ...patch,
      });
    expect(
      invalid({
        startsAt: '2026-10-07T16:00:00+08:00',
        endsAt: '2026-10-07T15:00:00+08:00',
      }),
    ).toThrow();
    expect(invalid({ endsAt: '2026-10-07T16:00:00' })).toThrow();
    expect(invalid({ timeZone: 'Mars/Olympus' })).toThrow();
    expect(invalid({ unknownField: 1 })).toThrow();
    expect(() =>
      parseNotesUpdate({
        id: 'n',
        expectedVersion: 1,
        patch: {},
        idempotencyKey: 'v',
      }),
    ).toThrow();
    expect(providers.read().calendarEvents).toHaveLength(0);
  });

  it('lists overlapping events in range with a working cursor', async () => {
    providers = createMemoryProviders();
    for (const [index, day] of ['07', '08', '09'].entries()) {
      await createEvent(ctx(), {
        ...meeting,
        title: `第 ${index + 1} 天`,
        startsAt: `2026-10-${day}T09:00:00+08:00`,
        endsAt: `2026-10-${day}T10:00:00+08:00`,
        idempotencyKey: `day-${day}`,
      });
    }
    // Ends exactly at rangeStart, so it must not show up as an overlap.
    await createEvent(ctx(), {
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
    const first = await listEvents(ctx(), { ...range, limit: 2 });
    expect(first.items.map((item) => item.title)).toEqual([
      '第 1 天',
      '第 2 天',
    ]);
    expect(first.nextCursor).toBe('2');
    const second = await listEvents(ctx(), {
      ...range,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.title)).toEqual(['第 3 天']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('returns note summaries without bodies and filters by keyword', async () => {
    providers = createMemoryProviders();
    await createNote(ctx(), {
      title: '路线图',
      body: '宠物窗口优先',
      idempotencyKey: 'a',
    });
    await createNote(ctx(), {
      title: '采购清单',
      body: '键盘',
      idempotencyKey: 'b',
    });
    const all = await providers.notes.list(ctx(), { limit: 20 });
    expect(all.items).toHaveLength(2);
    expect(all.items[0]).not.toHaveProperty('body');
    const found = await providers.notes.list(ctx(), {
      query: '键盘',
      limit: 20,
    });
    expect(found.items.map((item) => item.title)).toEqual(['采购清单']);
  });

  it('deletes once per key and leaves an audit reference', async () => {
    providers = createMemoryProviders();
    const note = await createNote(ctx(), {
      title: '待删除',
      body: '',
      idempotencyKey: 'd1',
    });
    const input = { id: note.id, expectedVersion: 1, idempotencyKey: 'd2' };
    const first = await providers.notes.remove(ctx(), input);
    const again = await providers.notes.remove(ctx(), input);
    expect(again).toEqual(first);
    expect(first.auditRef).toBeTruthy();
    await expect(
      providers.notes.remove(ctx(), { ...input, idempotencyKey: 'd3' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(providers.read().notes).toHaveLength(0);
  });

  it('keeps workspaces separate and reports disposed providers', async () => {
    providers = createMemoryProviders();
    const other = ctx({ workspaceId: 'work' });
    const note = await createNote(other, {
      title: '公司笔记',
      body: '',
      idempotencyKey: 'shared',
    });
    expect(
      (await providers.notes.list(ctx(), { limit: 20 })).items,
    ).toHaveLength(0);
    await expect(
      updateNote(ctx(), {
        id: note.id,
        expectedVersion: 1,
        patch: { title: '越权' },
        idempotencyKey: 'x',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const local = await createNote(ctx(), {
      title: '个人笔记',
      body: '',
      idempotencyKey: 'shared',
    });
    expect(local.id).not.toBe(note.id);
    providers.dispose();
    await expect(
      providers.notes.list(ctx(), { limit: 20 }),
    ).rejects.toMatchObject({ code: 'DISPOSED' });
  });

  it('hands out copies and notifies its own subscribers, not the session', async () => {
    providers = createMemoryProviders();
    const listener = vi.fn();
    const stop = providers.subscribe(listener);
    await createEvent(ctx(), { ...meeting, idempotencyKey: 'n' });
    expect(listener).toHaveBeenCalledTimes(1);
    await providers.notes.list(ctx(), { limit: 20 });
    expect(listener).toHaveBeenCalledTimes(1);

    const read = providers.read();
    read.calendarEvents.length = 0;
    expect(providers.read().calendarEvents).toHaveLength(1);

    stop();
    await createEvent(ctx(), { ...meeting, idempotencyKey: 'n2' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
