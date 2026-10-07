import { openSqlite, transaction } from '../../sqlite/src/index.ts';
import type { SqliteDatabase } from '../../sqlite/src/index.ts';
import type {
  AgentId,
  Conversation,
  ConversationState,
  ConversationStore,
  DurableEvent,
  DurablePayloadInput,
  Workspace,
} from '../../contracts/src/index.ts';

/**
 * 本体的会话存储（ADR-028）。
 *
 * **对话归本体。** 这是本体自己的库（`<数据目录>/core.db`），与提供方的 `local.db`
 * 分开 —— 两边所有者不同，分成两个文件才不会让本体去写提供方的 schema。
 *
 * **事件是唯一真相。** `runs` 与 `proposals` 是从 `conversation_events` 投影出来的，
 * 这里**不**另存一份。存两份必然漂移，而漂移之后界面显示的与库里存的对不上，用户
 * 没法知道该信哪个。
 *
 * **`seq` 不重复也不跳号**：`conversation_events` 上有 `PRIMARY KEY (conversation_id,
 * seq)`，跳号会直接撞主键。分配在事务里做 —— 一批事件要么全拿到号、要么一个都没拿
 * 到，绝不会出现「拿到一半的号」。
 */

export type ConversationDatabase = SqliteDatabase;

export function openConversationDatabase(file: string): ConversationDatabase {
  // pragma 由 `openSqlite` 配 —— 与提供方的 `local.db` 走同一套，两边行为不能不一样。
  const database = openSqlite(file);
  const { db } = database;

  for (const statement of SCHEMA) db.exec(statement);
  // 一个全新库第一次进来，给它那个「从这里开始 ONE」对话 —— 没有它，桌面端打开
  // 是一片空白，用户以为坏了。
  const seeded = db
    .prepare('SELECT COUNT(*) AS c FROM conversations')
    .get() as { c: number };
  if (seeded.c === 0) {
    transaction(db, () => {
      db.prepare(
        'INSERT INTO workspaces (id, name) VALUES (?, ?) ON CONFLICT (id) DO NOTHING',
      ).run('personal', '个人空间');
      db.prepare(
        `INSERT INTO conversations (id, workspace_id, title, agent_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        'welcome',
        'personal',
        '从这里开始 ONE',
        'chat',
        new Date().toISOString(),
      );
    });
  }

  return database;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS workspaces (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id),
    title        TEXT NOT NULL,
    agent_id     TEXT NOT NULL,
    created_at   TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agent_bindings (
    id                  TEXT PRIMARY KEY,
    conversation_id     TEXT NOT NULL REFERENCES conversations (id),
    agent_id            TEXT NOT NULL,
    external_session_id TEXT,
    last_projected_seq  INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations (id),
    agent_id        TEXT NOT NULL,
    status          TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    ended_at        TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS runs_by_status ON runs (status, conversation_id)`,
  // seq 不跳号就由这个主键兜着：跳号会直接撞主键，插不进去。
  `CREATE TABLE IF NOT EXISTS conversation_events (
    conversation_id TEXT NOT NULL REFERENCES conversations (id),
    seq             INTEGER NOT NULL,
    id              TEXT NOT NULL UNIQUE,
    type            TEXT NOT NULL,
    payload         TEXT NOT NULL,
    schema_version  INTEGER NOT NULL,
    created_at      TEXT NOT NULL,
    PRIMARY KEY (conversation_id, seq)
  )`,
];

export function createSqliteConversationStore(
  database: ConversationDatabase,
): ConversationStore {
  const { db } = database;

  const selectLastSeq = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS seq FROM conversation_events WHERE conversation_id = ?',
  );
  const insertEvent = db.prepare(
    `INSERT INTO conversation_events
       (conversation_id, seq, id, type, payload, schema_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectConversations = db.prepare(
    'SELECT id, workspace_id, title, agent_id, created_at FROM conversations ORDER BY created_at, id',
  );
  const selectWorkspaces = db.prepare(
    'SELECT id, name FROM workspaces ORDER BY id',
  );
  const insertConversation = db.prepare(
    `INSERT INTO conversations (id, workspace_id, title, agent_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const updateAgent = db.prepare(
    'UPDATE conversations SET agent_id = ? WHERE id = ?',
  );
  const selectEvents = db.prepare(
    'SELECT conversation_id, seq, id, type, payload, schema_version, created_at FROM conversation_events ORDER BY conversation_id, seq',
  );

  return {
    open(): ConversationState {
      const workspaces: Workspace[] = (
        selectWorkspaces.all() as { id: string; name: string }[]
      ).map((row) => ({ id: row.id, name: row.name }));
      const conversations: Conversation[] = (
        selectConversations.all() as {
          id: string;
          workspace_id: string;
          title: string;
          agent_id: AgentId;
          created_at: string;
        }[]
      ).map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        title: row.title,
        agentId: row.agent_id,
        createdAt: row.created_at,
      }));
      // 事件按 payload 还原成判别联合的形状：`payload` 只存载荷本身，type 与
      // conversation_id/seq 在外面，所以拼回来时 type 要从列里取，不能信 JSON。
      const events: DurableEvent[] = (
        selectEvents.all() as {
          conversation_id: string;
          seq: number;
          id: string;
          type: string;
          payload: string;
          schema_version: number;
          created_at: string;
        }[]
      ).map((row) => ({
        ...(JSON.parse(row.payload) as Record<string, unknown>),
        id: row.id,
        conversationId: row.conversation_id,
        seq: Number(row.seq),
        schemaVersion: Number(row.schema_version) as 1,
        createdAt: row.created_at,
        type: row.type,
      })) as DurableEvent[];
      return { workspaces, conversations, events };
    },
    appendBatch(
      conversationId: string,
      payloads: DurablePayloadInput[],
    ): DurableEvent[] {
      // 整批在**一个事务**里：seq 从库里读出来的最大值接着发，中途失败连号都不占。
      return transaction(db, () => {
        let seq = (selectLastSeq.get(conversationId) as { seq: number }).seq;
        const written: DurableEvent[] = [];
        for (const payload of payloads) {
          seq += 1;
          const id = crypto.randomUUID();
          const createdAt = new Date().toISOString();
          const { type, ...body } = payload as DurablePayloadInput &
            Record<string, unknown>;
          insertEvent.run(
            conversationId,
            seq,
            id,
            type,
            JSON.stringify(body),
            1,
            createdAt,
          );
          written.push({
            ...payload,
            id,
            conversationId,
            seq,
            schemaVersion: 1,
            createdAt,
          });
        }
        return written;
      });
    },
    createConversation(conversation: Conversation) {
      transaction(db, () => {
        insertConversation.run(
          conversation.id,
          conversation.workspaceId,
          conversation.title,
          conversation.agentId,
          conversation.createdAt,
        );
      });
    },
    setConversationAgent(
      conversationId: string,
      agentId: AgentId,
      payload: DurablePayloadInput,
    ) {
      // 改对话与记那条事件**同事务**：分开写会出现「说换了但没换」，或者换成功了却
      // 没有任何记录，重启后回到旧 Agent 而用户以为已经换过。
      return transaction(db, () => {
        updateAgent.run(agentId, conversationId);
        let seq = (selectLastSeq.get(conversationId) as { seq: number }).seq;
        seq += 1;
        const id = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        const { type, ...body } = payload as DurablePayloadInput &
          Record<string, unknown>;
        insertEvent.run(
          conversationId,
          seq,
          id,
          type,
          JSON.stringify(body),
          1,
          createdAt,
        );
        return {
          ...payload,
          id,
          conversationId,
          seq,
          schemaVersion: 1,
          createdAt,
        } as DurableEvent;
      });
    },
    close() {
      database.close();
    },
  };
}
