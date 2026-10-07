import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '../../mock-runtime/src/store-memory.ts';
import {
  createSqliteConversationStore,
  openConversationDatabase,
} from './store-sqlite.ts';
import type { ConversationDatabase } from './store-sqlite.ts';
import { createConversationRuntime } from './runtime.ts';
import type {
  ConversationStore,
  ReplyAgent,
} from '../../contracts/src/index.ts';

/**
 * 会话存储的**契约测试**（ADR-028）。
 *
 * 两份实现跑**同一组用例**。这是「换掉存储不等于换掉状态机」那句话的兑现方式 ——
 * 只测 SQLite 那份的话，内存那份随时可以悄悄坏掉，而它是测试与开发天天在用的那一份。
 *
 * 这组用例守的都是**行为判据**，不是「重新实现一遍」：
 * - seq 不重复、不跳号（重连快照无缺失无重复的根据）；
 * - 一批事件要么全在要么全不在（崩在中间不留半条 Run）；
 * - 重启后状态还在（对话归本体）；
 * - 崩在半路的 Run 回来是 `interrupted`，不是永远转圈。
 */

const opened: ConversationDatabase[] = [];

const scratch = () => mkdtempSync(path.join(tmpdir(), 'one-conversation-'));

afterEach(() => {
  while (opened.length > 0) opened.pop()?.close();
});

const WELCOME = {
  id: 'welcome',
  workspaceId: 'personal',
  title: '从这里开始 ONE',
  agentId: 'chat' as const,
  createdAt: '2026-10-07T00:00:00.000Z',
};

/**
 * 两份实现的差异只在「怎么重新拿到一份内容」，所以用例只给一个 `reopen` 钩子，
 * 其余完全共用 —— 差别只藏在钩子里，用例本身察觉不到。
 */
const implementations: {
  name: string;
  make(dir: string): {
    store: ConversationStore;
    reopen(dir: string): ConversationStore;
  };
}[] = [
  {
    name: '内存',
    make(dir) {
      void dir;
      const store = createMemoryStore({ conversations: [WELCOME] });
      return {
        store,
        reopen: () => createMemoryStore({ restore: store.open() }),
      };
    },
  },
  {
    name: 'SQLite',
    make(dir) {
      const database = openConversationDatabase(path.join(dir, 'core.db'));
      opened.push(database);
      const store = createSqliteConversationStore(database);
      return {
        store,
        reopen: () => {
          const next = openConversationDatabase(path.join(dir, 'core.db'));
          opened.push(next);
          return createSqliteConversationStore(next);
        },
      };
    },
  },
];

const message = (content: string) => ({
  type: 'message.created' as const,
  message: { id: `m-${content}`, role: 'user' as const, content },
});

const run = (id: string) => ({
  id,
  conversationId: 'welcome',
  agentId: 'chat' as const,
  status: 'running' as const,
});

describe.each(implementations)('会话存储契约（$name）', ({ make }) => {
  it('seq 从 1 开始、连续、不重复', () => {
    const { store } = make(scratch());
    const first = store.appendBatch('welcome', [message('一'), message('二')]);
    expect(first.map((event) => event.seq)).toEqual([1, 2]);

    const second = store.appendBatch('welcome', [message('三')]);
    expect(second[0]!.seq).toBe(3);

    const all = store
      .open()
      .events.filter((event) => event.conversationId === 'welcome');
    const seqs = all.map((event) => event.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('每段对话各编各的号，互不干扰', () => {
    const { store } = make(scratch());
    store.appendBatch('welcome', [message('一'), message('二')]);
    store.createConversation({ ...WELCOME, id: 'second', title: '第二段' });
    // 第二段对话的第一条是 1 号，不是 3 号 —— 界面的 seq 是**按对话**判重连的。
    const written = store.appendBatch('second', [message('别的对话')]);
    expect(written[0]!.seq).toBe(1);
  });

  it('一批事件要么全在要么全不在', () => {
    const { store } = make(scratch());
    const written = store.appendBatch('welcome', [
      { type: 'run.started', run: run('r1') },
      { type: 'run.finished', run: { ...run('r1'), status: 'completed' } },
    ]);
    expect(written).toHaveLength(2);
    const started = store
      .open()
      .events.filter((event) => event.type === 'run.started');
    const finished = store
      .open()
      .events.filter((event) => event.type === 'run.finished');
    expect(started).toHaveLength(1);
    expect(finished).toHaveLength(1);
    // 两条连号：中间少一条就说明「开始」与「结束」被拆开了。
    expect(finished[0]!.seq).toBe(started[0]!.seq + 1);
  });

  it('重启后对话与事件都还在', () => {
    const dir = scratch();
    const first = make(dir);
    first.store.appendBatch('welcome', [
      message('崩之前说的话'),
      message('还有这句'),
    ]);
    first.store.createConversation({
      ...WELCOME,
      id: 'c2',
      title: '第二段对话',
    });

    // 复用**同一个** harness 的 reopen —— 新 make 一个等于另起炉灶，测的就不是重启了。
    const after = first.reopen(dir).open();
    expect(after.conversations.map((item) => item.id).sort()).toEqual([
      'c2',
      'welcome',
    ]);
    const contents = after.events
      .filter((event) => event.type === 'message.created')
      .map(
        (event) => (event as { message: { content: string } }).message.content,
      );
    expect(contents).toEqual(['崩之前说的话', '还有这句']);
    // 重开后接着发号，不会把已经发出去的号再发一遍。
    expect(
      first.reopen(dir).appendBatch('welcome', [message('重启之后')])[0]!.seq,
    ).toBe(3);
  });

  it('改 Agent 与那条事件同事务', () => {
    const { store } = make(scratch());
    const [event] = store.appendBatch('welcome', [message('先说一句')]);
    const written = store.setConversationAgent('welcome', 'mcode', {
      type: 'agent.changed',
      agentId: 'mcode',
    });
    expect(written.seq).toBe(event!.seq + 1);
    expect(written.type).toBe('agent.changed');
    expect(store.open().conversations[0]!.agentId).toBe('mcode');
  });
});

/**
 * 「崩在半路」这条判据要有一个**真的跑起来的运行时**才验得到，所以不放在上面的
 * 契约表里 —— 它本来就只有一份实现，不是两份实现的共同行为。
 */
describe('本体重启后正在跑的回复', () => {
  const agent: ReplyAgent = {
    id: 'chat',
    name: 'Chat Agent',
    async reply() {
      // 永不结束的回复：只要有定时器在跑，Run 就是 running。
      return { content: '很长很长的一段回复'.repeat(200) };
    },
  };

  it('回来是 interrupted，不是 running 也不是 completed', async () => {
    vi.useFakeTimers();
    try {
      const store = createMemoryStore({ conversations: [WELCOME] });
      const runtime = createConversationRuntime(store, [agent], { tickMs: 1 });
      await runtime.sendMessage('welcome', '说点什么');
      expect(
        runtime.getSnapshot().runs.some((item) => item.status === 'running'),
      ).toBe(true);

      const reopened = createConversationRuntime(store, [agent], { tickMs: 1 });
      const runs = reopened.getSnapshot().runs;
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe('interrupted');
      reopened.dispose();
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('中断的那次不留下半截回复', async () => {
    vi.useFakeTimers();
    try {
      const store = createMemoryStore({ conversations: [WELCOME] });
      const runtime = createConversationRuntime(store, [agent], { tickMs: 1 });
      await runtime.sendMessage('welcome', '说点什么');
      // 流出一点再「崩」：半截只该活在内存里。
      await vi.advanceTimersByTimeAsync(20);

      const reopened = createConversationRuntime(store, [agent], { tickMs: 1 });
      const replies = reopened
        .getSnapshot()
        .events.filter((event) => event.type === 'message.created')
        .map((event) => (event as { message: { role: string } }).message.role);
      // 只有用户那一句。半截回复不是回复 —— 落进去等于把用户没看完的东西当成他说过的话。
      expect(replies).toEqual(['user']);
      reopened.dispose();
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('中断过一次之后再开，不会重复记一次', async () => {
    vi.useFakeTimers();
    try {
      const store = createMemoryStore({ conversations: [WELCOME] });
      const first = createConversationRuntime(store, [agent], { tickMs: 1 });
      await first.sendMessage('welcome', '说点什么');

      const second = createConversationRuntime(store, [agent], { tickMs: 1 });
      const seqs = second
        .getSnapshot()
        .events.filter((event) => event.conversationId === 'welcome')
        .map((event) => event.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
      // 关掉再开两次，不该每次都多一条 run.finished。
      const third = createConversationRuntime(store, [agent], { tickMs: 1 });
      expect(
        third
          .getSnapshot()
          .events.filter((event) => event.type === 'run.finished'),
      ).toHaveLength(1);
      third.dispose();
      second.dispose();
      first.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
