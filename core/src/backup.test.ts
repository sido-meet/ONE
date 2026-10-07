import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBackupService } from './backup.ts';
import {
  BACKUP_EXPORT_CAPABILITY,
  BACKUP_IMPORT_CAPABILITY,
  BACKUP_SCHEMA_VERSION,
  explainBundleRejection,
  parseBackupBundle,
} from '../../packages/contracts/src/backup.ts';
import { createMemoryStore } from '../../packages/mock-runtime/src/store-memory.ts';
import type {
  ConversationStore,
  ProviderId,
} from '../../packages/contracts/src/index.ts';

/**
 * 备份的判据（ADR-029）。
 *
 * 这组用例守三件事，每一件都对应一种**用户真的会踩**的坏法：
 *
 * 1. **半个包比没有包更危险。** 导出时任何一个参与者交不出来，就不该写文件。
 * 2. **半个导入比不导入更糟。** 用户看着日历回来了、日程没了，而没人告诉他。
 * 3. **备份是不可信输入。** 别的版本、坏形状、太大 —— 一律拒，不猜。
 */

const scratch = () => mkdtempSync(path.join(tmpdir(), 'one-backup-'));

const WELCOME = {
  id: 'welcome',
  workspaceId: 'personal',
  title: '从这里开始 ONE',
  agentId: 'chat' as const,
  createdAt: '2026-10-07T00:00:00.000Z',
};

const slice = (kind: 'calendar' | 'notes') => ({
  schemaVersion: BACKUP_SCHEMA_VERSION,
  kind,
  data:
    kind === 'calendar'
      ? {
          calendarEvents: [{ id: 'e1', title: '开会' }],
          audits: [],
          receipts: {},
        }
      : { notes: [{ id: 'n1', title: '记一下' }], audits: [], receipts: {} },
});

/** 一个只有日历与笔记两个参与者、名册上都申报了备份能力的假本体。 */
const fakeCore = (options: {
  /** 哪个参与者会失败。 */
  failing?: ProviderId;
  /** 名册上少了某个参与者（模拟「装了没运行」）。 */
  absent?: ProviderId;
}) => {
  const calls: { target: ProviderId; capability: string }[] = [];
  const imported: Record<string, unknown> = {};
  return {
    calls,
    imported,
    core: {
      invoke(target: ProviderId, capability: string): Promise<unknown> {
        calls.push({ target, capability });
        if (capability === BACKUP_IMPORT_CAPABILITY) {
          imported[target] = slice(
            target === 'local.calendar' ? 'calendar' : 'notes',
          ).data;
          return Promise.resolve({ ok: true });
        }
        if (target === options.failing)
          return Promise.reject(new Error('这个参与者交不出来'));
        return Promise.resolve(
          slice(target === 'local.calendar' ? 'calendar' : 'notes'),
        );
      },
      roster() {
        return ['local.calendar', 'local.notes']
          .filter((id) => id !== options.absent)
          .map((id) => ({
            role: 'provider',
            provider: id,
            capabilities: [BACKUP_EXPORT_CAPABILITY, BACKUP_IMPORT_CAPABILITY],
          }));
      },
    },
  };
};

const service = (core: unknown, store: ConversationStore, dir: string) =>
  createBackupService({
    core: core as never,
    store,
    version: '0.2.0-dev',
    dataDir: dir,
    contextFor: (requestId) => ({
      requestId,
      workspaceId: 'personal',
      source: 'ui',
    }),
  });

describe('导出', () => {
  it('包里有对话、也有每个参与者那一份', async () => {
    const dir = scratch();
    const store = createMemoryStore({ conversations: [WELCOME] });
    store.appendBatch('welcome', [
      {
        type: 'message.created',
        message: { id: 'm1', role: 'user', content: '你好' },
      },
    ]);
    const fake = fakeCore({});
    const bundle = await service(fake.core, store, dir).exportTo(
      path.join(dir, 'b.json'),
    );

    expect(bundle.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(bundle.conversations.conversations.map((item) => item.id)).toEqual([
      'welcome',
    ]);
    expect(bundle.conversations.events).toHaveLength(1);
    // 每个参与者一份，键是寻址键 —— 本体靠它对上名册（ADR-029）。
    expect(Object.keys(bundle.providers).sort()).toEqual([
      'local.calendar',
      'local.notes',
    ]);
  });

  it('一个参与者交不出来就不写文件', async () => {
    const dir = scratch();
    const file = path.join(dir, 'b.json');
    const fake = fakeCore({ failing: 'local.notes' });
    await expect(
      service(
        fake.core,
        createMemoryStore({ conversations: [WELCOME] }),
        dir,
      ).exportTo(file),
    ).rejects.toThrow();
    // 半个包比没有包更危险：用户会拿它去恢复，然后发现少了一半日程。
    const { existsSync } = await import('node:fs');
    expect(existsSync(file)).toBe(false);
  });

  it('没申报备份能力的参与者不参与，也不假装导过了', async () => {
    const dir = scratch();
    const fake = fakeCore({ absent: 'local.notes' });
    const bundle = await service(
      fake.core,
      createMemoryStore({}),
      dir,
    ).exportTo(path.join(dir, 'b.json'));
    expect(Object.keys(bundle.providers)).toEqual(['local.calendar']);
  });
});

describe('导入', () => {
  const goodBundle = () => ({
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: '2026-10-07T00:00:00.000Z',
    appVersion: '0.2.0-dev',
    conversations: {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      workspaces: [{ id: 'personal', name: '个人空间' }],
      conversations: [WELCOME],
      events: [
        {
          id: 'e1',
          conversationId: 'welcome',
          seq: 1,
          type: 'message.created',
          schemaVersion: 1,
          createdAt: '2026-10-07T00:00:00.000Z',
          message: { id: 'm1', role: 'user', content: '从备份里回来的话' },
        },
      ],
    },
    providers: {},
  });

  it('整份换掉，导入后状态与包里一致', async () => {
    const dir = scratch();
    const file = path.join(dir, 'b.json');
    const store = createMemoryStore({ conversations: [WELCOME] });
    store.appendBatch('welcome', [
      {
        type: 'message.created',
        message: { id: 'old', role: 'user', content: '旧的' },
      },
    ]);
    writeFileSync(file, JSON.stringify(goodBundle()), 'utf8');

    const fake = fakeCore({});
    await service(fake.core, store, dir).importFrom(file);

    const after = store.open();
    expect(after.events).toHaveLength(1);
    expect(after.events[0]!.id).toBe('e1');
  });

  it('坏文件一个字节都不写', async () => {
    const dir = scratch();
    const file = path.join(dir, 'bad.json');
    const store = createMemoryStore({ conversations: [WELCOME] });
    store.appendBatch('welcome', [
      {
        type: 'message.created',
        message: { id: 'old', role: 'user', content: '还在' },
      },
    ]);
    writeFileSync(file, JSON.stringify({ schemaVersion: 99 }), 'utf8');

    const fake = fakeCore({});
    await expect(
      service(fake.core, store, dir).importFrom(file),
    ).rejects.toThrow(/版本/);
    // 「日历回来了、日程没了」是这里要防的结果。
    expect(
      store
        .open()
        .events.map(
          (event) =>
            (event as { message: { content: string } }).message.content,
        ),
    ).toEqual(['还在']);
  });

  it('参与者导入失败时逐段报告，不假装全成了', async () => {
    const dir = scratch();
    const file = path.join(dir, 'b.json');
    const bundle = goodBundle();
    bundle.providers = {
      'local.calendar': slice('calendar'),
      'local.notes': slice('notes'),
    };
    writeFileSync(file, JSON.stringify(bundle), 'utf8');

    const fake = fakeCore({ failing: 'local.notes' });
    // 让导入那一路也失败，好验「逐段」而不是「全崩」。
    fake.core.invoke = (target: ProviderId, capability: string) => {
      if (capability === BACKUP_IMPORT_CAPABILITY && target === 'local.notes')
        return Promise.reject(new Error('写不进去'));
      return Promise.resolve({ ok: true });
    };
    const outcome = await service(
      fake.core,
      createMemoryStore({}),
      dir,
    ).importFrom(file);

    expect(outcome.conversations.applied).toBe(true);
    expect(outcome.providers['local.calendar']!.applied).toBe(true);
    // 跨库原子性做不到，所以必须逐段说清 —— 一个「成功/失败」会让人误以为全成了。
    expect(outcome.providers['local.notes']!.applied).toBe(false);
    expect(outcome.providers['local.notes']!.reason).toContain('写不进去');
  });

  it('包里有、现在没装的参与者说清楚「没装」而不是报错', async () => {
    const dir = scratch();
    const file = path.join(dir, 'b.json');
    const bundle = goodBundle();
    bundle.providers = { 'local.calendar': slice('calendar') };
    writeFileSync(file, JSON.stringify(bundle), 'utf8');

    const fake = fakeCore({ absent: 'local.calendar' });
    const outcome = await service(
      fake.core,
      createMemoryStore({}),
      dir,
    ).importFrom(file);
    expect(outcome.providers['local.calendar']!.applied).toBe(false);
    expect(outcome.providers['local.calendar']!.reason).toContain('没装');
  });
});

describe('备份文件是不受信任的输入', () => {
  it('版本不认识就拒，并说清是版本问题', () => {
    const raw = { schemaVersion: 99, conversations: {}, providers: {} };
    expect(parseBackupBundle(raw)).toBeNull();
    expect(explainBundleRejection(raw)).toContain('99');
  });

  it('缺 schemaVersion 说「不是完整导出的」', () => {
    expect(explainBundleRejection({ conversations: {} })).toContain(
      'schemaVersion',
    );
  });

  it('顶层不是对象就拒', () => {
    expect(parseBackupBundle('这不是 JSON 对象')).toBeNull();
    expect(parseBackupBundle(null)).toBeNull();
  });

  it('对话部分坏就说坏在哪，不笼统说「格式不对」', () => {
    const message = explainBundleRejection({
      schemaVersion: BACKUP_SCHEMA_VERSION,
      exportedAt: 'now',
      appVersion: 'x',
      conversations: {
        schemaVersion: BACKUP_SCHEMA_VERSION,
        workspaces: '不是数组',
      },
      providers: {},
    });
    expect(message).toContain('对话');
  });

  it('参与者那一份坏时要指名道姓是哪一份', () => {
    const message = explainBundleRejection({
      schemaVersion: BACKUP_SCHEMA_VERSION,
      exportedAt: 'now',
      appVersion: 'x',
      conversations: {
        schemaVersion: BACKUP_SCHEMA_VERSION,
        workspaces: [],
        conversations: [],
        events: [],
      },
      providers: {
        'local.notes': { schemaVersion: 3, kind: 'notes', data: {} },
      },
    });
    expect(message).toContain('local.notes');
  });
});

describe('彻底删除', () => {
  it('删掉的对话连事件一起消失，找不到就说找不到', () => {
    const store = createMemoryStore({ conversations: [WELCOME] });
    store.appendBatch('welcome', [
      {
        type: 'message.created',
        message: { id: 'm1', role: 'user', content: '私密' },
      },
    ]);
    const backup = createBackupService({
      core: fakeCore({}).core as never,
      store,
      version: 'x',
      dataDir: scratch(),
      contextFor: (requestId) => ({
        requestId,
        workspaceId: 'personal',
        source: 'ui',
      }),
    });
    backup.forget('welcome');
    const after = store.open();
    // 契约写着「追加历史不意味着永久不能删除私人数据」，所以这里是真删。
    expect(after.conversations).toHaveLength(0);
    expect(after.events).toHaveLength(0);
    expect(() => backup.forget('welcome')).toThrow(/找不到/);
  });
});
