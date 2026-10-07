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
 * 内存版会话存储（ADR-028）。
 *
 * **它不是「假实现」，是这份契约的另一半**：生产用 SQLite，测试与开发用这份，两边跑
 * **同一组契约测试**。所以 seq 的语义必须一模一样 —— 每段对话从 1 开始、不跳号、
 * 不重复，而且回滚时把计数器一起退回去（SQLite 那边靠事务天然做到）。
 *
 * 用一个全局单调递增的计数器看着更省事，但它会让 seq 跳号，于是「重连快照无缺失无
 * 重复」这条判据在测试里验不到、在生产里却被破坏 —— 测试通过而线上出问题是最坏的
 * 一种组合。
 *
 * `restore` 是为了**让「重启」这条判据在内存实现上也能测**：内存 Store 没有文件，
 * 「重启」就是新实例从 `restore` 的内容重建，seq 计数器必须从已有事件里重新数出来
 * —— 否则第二个实例会从 1 重新发号，把已经发出去的号再发一遍。
 */
export interface MemoryStoreOptions {
  workspaces?: Workspace[];
  conversations?: Conversation[];
  /** 「重启」前的状态：新实例从这份内容重建。 */
  restore?: ConversationState;
}

export function createMemoryStore(
  options: MemoryStoreOptions = {},
): ConversationStore {
  const restored = options.restore;
  const workspaces: Workspace[] = structuredClone(
    options.workspaces ??
      restored?.workspaces ?? [{ id: 'personal', name: '个人空间' }],
  );
  // **必须克隆。** 按引用存的话，`setConversationAgent` 会把调用方传进来的那个对象
  // 一起改掉 —— 测试里共用一个 `WELCOME` 常量，于是上一条用例把下一条的 agentId
  // 换成了 mcode，下一条报「未知 Agent」却查不出原因。存进去的必须是它自己的副本。
  const conversations: Conversation[] = structuredClone(
    options.conversations ?? restored?.conversations ?? [],
  );
  const events: DurableEvent[] = structuredClone(restored?.events ?? []);
  /** 每段对话已经用到几号。 */
  const lastSeq = new Map<string, number>();
  for (const event of events) {
    const current = lastSeq.get(event.conversationId) ?? 0;
    if (event.seq > current) lastSeq.set(event.conversationId, event.seq);
  }
  let closed = false;

  const assertOpen = () => {
    if (closed) throw new Error('store 已关闭');
  };

  const nextSeq = (conversationId: string) => {
    const seq = (lastSeq.get(conversationId) ?? 0) + 1;
    lastSeq.set(conversationId, seq);
    return seq;
  };

  return {
    open(): ConversationState {
      assertOpen();
      return {
        workspaces: structuredClone(workspaces),
        conversations: structuredClone(conversations),
        events: structuredClone(events),
      };
    },
    appendBatch(
      conversationId,
      payloads: DurablePayloadInput[],
    ): DurableEvent[] {
      assertOpen();
      // 先全部分配好再一起落：seq 必须是连续的一段，中间任何一个失败都不该留下半个。
      const staged = payloads.map(
        (payload): DurableEvent =>
          ({
            ...structuredClone(payload),
            id: crypto.randomUUID(),
            conversationId,
            seq: nextSeq(conversationId),
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
          }) as DurableEvent,
      );
      events.push(...staged);
      return structuredClone(staged);
    },
    createConversation(conversation: Conversation) {
      assertOpen();
      conversations.push(structuredClone(conversation));
    },
    setConversationAgent(
      conversationId,
      agentId: AgentId,
      payload: DurablePayloadInput,
    ) {
      assertOpen();
      const conversation = conversations.find(
        (item) => item.id === conversationId,
      );
      if (conversation) conversation.agentId = agentId;
      return this.appendBatch(conversationId, [payload])[0]!;
    },
    close() {
      closed = true;
    },
  };
}
