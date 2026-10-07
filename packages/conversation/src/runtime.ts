import { ClientError } from '../../contracts/src/index.ts';
import type {
  AgentId,
  CalendarDraft,
  Conversation,
  ConversationRuntime,
  ConversationState,
  ConversationStore,
  DurableEvent,
  DurablePayloadInput,
  NoteDraft,
  Proposal,
  ProposalDraft,
  ProposalResolution,
  ReplyAgent,
  Run,
  RunStatus,
  Snapshot,
} from '../../contracts/src/index.ts';

/**
 * 会话运行时 —— **唯一的一份实现**（ADR-028）。
 *
 * 三条规矩决定了这个文件的样子：
 *
 * 1. **状态归本体。** 这里不 new 任何数组当权威状态：`workspaces` / `conversations` /
 *    `events` 来自 Store，其余全是从 `events` **投影**出来的。存两份必然漂移 ——
 *    漂移之后界面显示的与库里存的对不上，而用户没法知道该信哪个。
 * 2. **Agent 只回答「说什么」。** 它拿到「这句话 + 上一条回复」，交回「这段话 + 可选
 *    的草稿」。它不持有对话，也不决定 seq。用户切 Agent 时换的是「谁回答」，不是
 *    「谁记着说过什么」—— 所以 Agent 是一个**列表**，不是一个。
 * 3. **先答话，再落历史。** Agent 抛错时这次发送不留任何痕迹：用户看到的是「失败
 *    那句话还在输入框里」，底下不该多出一条他已经不承认发过的消息。
 */

/** 从事件投影出 Run 列表。`status` 由 started / finished 两个事件推出来。 */
const indexRuns = (events: readonly DurableEvent[]): Run[] => {
  const order: Run[] = [];
  const byId = new Map<string, Run>();
  for (const event of events) {
    if (event.type === 'run.started') {
      const run: Run = { ...event.run };
      byId.set(run.id, run);
      order.push(run);
    } else if (event.type === 'run.finished') {
      const existing = byId.get(event.run.id);
      // 没有 started 的 finished 是坏数据，不给它凭空造一条 Run —— 那会让界面显示
      // 一次用户没见过的运行。宁可少显示，也不要显示假的。
      if (existing) existing.status = event.run.status;
    }
  }
  return order;
};

/** 从事件投影出提议列表。`created` / `rejected` 由 settled 事件补上。 */
const indexProposals = (events: readonly DurableEvent[]): Proposal[] => {
  const order: Proposal[] = [];
  const byId = new Map<string, Proposal>();
  for (const event of events) {
    if (event.type === 'proposal.created') {
      const proposal: Proposal = structuredClone(event.proposal);
      byId.set(proposal.id, proposal);
      order.push(proposal);
    } else if (event.type === 'proposal.settled') {
      const existing = byId.get(event.resolution.proposalId);
      if (!existing) continue;
      const { status, entityId, reason, at } = event.resolution;
      existing.status = status;
      if (status === 'created')
        existing.created = {
          entityId: entityId ?? '',
          at: at || existing.createdAt,
        };
      else
        existing.rejected = {
          reason: reason ?? '',
          at: at || existing.createdAt,
        };
    }
  }
  return order;
};

export interface RuntimeOptions {
  /** 新对话默认用哪个 Agent。默认第一个。 */
  defaultAgentId?: AgentId;
}

export function createConversationRuntime(
  store: ConversationStore,
  agents: readonly ReplyAgent[],
  options: RuntimeOptions = {},
): ConversationRuntime {
  const state: ConversationState = store.open();
  const listeners = new Set<() => void>();
  /**
   * 正在流的迭代器，记下来是为了**能真的打断它**（ADR-031）。
   *
   * 以前这里放的是 `setInterval` 的句柄，`clearInterval` 就等于「回复停了」。现在回复
   * 的节奏由 Agent 自己管（模拟 Agent 逐字，真模型按网络节奏一段段），运行时手里
   * 只有迭代器 —— 所以停止回复分两步：
   *
   * 1. **`abort()` 是掐断**。只靠 `iterator.return()` 掐不断：生成器挂在一次 `await`
   *    上时，return 请求排在 pending 的 `next` 后面，那一次等待照走、那一段照交 ——
   *    界面已经停了，对面还在收 token（契约测试里那条「一个都不许再交」就是它逼出来的）。
   * 2. **`return()` 是善后**：让生成器走 `finally`、让适配器关掉 socket。
   *
   * 两者都要，顺序是先 abort 再 return。
   */
  const streams = new Map<string, AsyncIterator<string>>();
  /**
   * 每个 Run 一个控制器，**与 Run 同时生、同时灭**。它比 `streams` 活得久一点：连
   * 「Agent 正在起稿、还没交出流」那段也算在内 —— 那段里真模型正在发 HTTP 请求，
   * 用户这时关掉本体，那条请求也该被掐掉。
   */
  const controllers = new Map<string, AbortController>();
  /** 每次 Run 起稿时 Agent 给的草稿，跑完时用来落提议。只有起草成功才落。 */
  const attempts = new Map<string, ProposalDraft>();
  /** 流式半截。**不是持久历史**（token delta 不当永久历史），所以只活在内存里。 */
  const drafts: Record<string, string> = {};
  let disposed = false;

  const assertOpen = () => {
    if (disposed) throw new ClientError('DISPOSED', '会话服务已关闭');
  };
  const notify = () => listeners.forEach((listener) => listener());

  const agentById = (id: AgentId): ReplyAgent => {
    const found = agents.find((item) => item.id === id);
    if (!found) throw new ClientError('VALIDATION', '未知 Agent');
    return found;
  };

  const findConversation = (id: string) => {
    assertOpen();
    const conversation = state.conversations.find((item) => item.id === id);
    if (!conversation) throw new ClientError('NOT_FOUND', '找不到这个对话');
    return conversation;
  };

  const appendBatch = (
    conversationId: string,
    payloads: DurablePayloadInput[],
  ) => {
    const written = store.appendBatch(conversationId, payloads);
    state.events.push(...written);
    return written;
  };

  const runningRun = (conversationId: string) =>
    indexRuns(state.events).find(
      (run) =>
        run.conversationId === conversationId && run.status === 'running',
    );

  /**
   * 本体崩在回复生成到一半时，重启后这次 Run 既不能说 `running`（界面永远转圈），
   * 也不能说 `completed`（谎称生成成功了）。落成 `interrupted`（ADR-028）。
   *
   * **必须在开库时做**：库里有正在跑的 Run 是「上次崩了」，不是「这次正在跑」——
   * 后者只活在内存里，流式半截从不落库。
   */
  for (const run of indexRuns(state.events)) {
    if (run.status === 'running')
      appendBatch(run.conversationId, [
        { type: 'run.finished', run: { ...run, status: 'interrupted' } },
      ]);
  }

  /** 上一条 assistant 回复的正文。笔记的「把刚才那段记下来」要靠它。 */
  const lastAssistantReply = (conversationId: string): string | undefined => {
    for (let i = state.events.length - 1; i >= 0; i -= 1) {
      const event = state.events[i]!;
      if (
        event.type === 'message.created' &&
        event.conversationId === conversationId &&
        event.message.role === 'assistant'
      )
        return event.message.content;
    }
    return undefined;
  };

  const makeProposal = (
    conversationId: string,
    messageId: string,
    attempt: ProposalDraft,
  ): Proposal => {
    const workspaceId =
      state.conversations.find((item) => item.id === conversationId)
        ?.workspaceId ??
      state.workspaces[0]?.id ??
      'personal';
    const base = {
      id: crypto.randomUUID(),
      status: 'pending' as const,
      messageId,
      workspaceId,
      sourceConversationId: conversationId,
      createdAt: new Date().toISOString(),
    };
    // 判别联合在这里合拢：domain 与 draft 在类型上是绑着的，拼错的话这一行就
    // 通不过，而不是等本体边界才发现。
    return attempt.domain === 'calendar'
      ? { ...base, domain: 'calendar', draft: attempt.draft as CalendarDraft }
      : { ...base, domain: 'notes', draft: attempt.draft as NoteDraft };
  };

  /**
   * 停掉一次 Run 的**传输**：先掐断等待，再让迭代器善后。
   *
   * 顺序不能反。反过来的话 `return()` 排在 pending 的 `next` 后面，而那次 next 要等到
   * 等待自然走完才轮得到 `return` —— 等于什么都没掐断。
   */
  const stopStream = (runId: string) => {
    controllers.get(runId)?.abort();
    controllers.delete(runId);
    const iterator = streams.get(runId);
    streams.delete(runId);
    void iterator?.return?.();
  };

  /**
   * 一次 Run 结束。**成型回复、可选的提议、Run 结束 —— 一批事件一次事务**。
   *
   * 分三次写的话，崩在中间会留下「回复在但 Run 还在转」或者「提议在但回复不在」。
   */
  const finish = (run: Run, status: RunStatus) => {
    stopStream(run.id);
    const draft = drafts[run.id] ?? '';
    const attempt = attempts.get(run.id);
    attempts.delete(run.id);
    delete drafts[run.id];

    const payloads: DurablePayloadInput[] = [];
    // 半截回复不算回复：被取消时它没成型，不落 `message.created`，界面上只留「回复
    // 已停止」。落进去等于把用户没看完的东西当成他说过的话。
    if (draft && status !== 'cancelled') {
      const message = {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        agentId: run.agentId,
        content: draft,
      };
      payloads.push({ type: 'message.created', message });
      // 提议挂在**跑完**的那条回复下面。被取消的回复不提议：用户按了停止，他要的是
      // 停下来，而不是一份他没看完就替他起草好的日程。
      if (status === 'completed' && attempt)
        payloads.push({
          type: 'proposal.created',
          proposal: makeProposal(run.conversationId, message.id, attempt),
        });
    }
    payloads.push({ type: 'run.finished', run: { ...run, status } });
    appendBatch(run.conversationId, payloads);
    notify();
  };

  return {
    getSnapshot(): Snapshot {
      return structuredClone({
        workspaces: state.workspaces,
        conversations: state.conversations,
        events: state.events,
        runs: indexRuns(state.events),
        drafts: { ...drafts },
        proposals: indexProposals(state.events),
      });
    },
    subscribe(listener) {
      assertOpen();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async createConversation(title?: string) {
      assertOpen();
      // **不用默认参数。** `function f(x = '默认')` 只对 `undefined` 生效，
      // 而管道传不了 `undefined`：`JSON.stringify([undefined])` 得到的是
      // `"[null]"`。于是 `x.trim()` 在真实调用路径上抛异常 —— 桌面端
      // 「开始新对话」一点就是「ONE 内部出了点问题」，对话压根没建出来。
      const text = typeof title === 'string' ? title.trim() : '';
      const conversation: Conversation = {
        id: crypto.randomUUID(),
        workspaceId: state.workspaces[0]?.id ?? 'personal',
        title: text || '新的对话',
        agentId: options.defaultAgentId ?? agents[0]?.id ?? 'chat',
        createdAt: new Date().toISOString(),
      };
      store.createConversation(conversation);
      state.conversations.push(conversation);
      notify();
      return structuredClone(conversation);
    },
    async changeAgent(conversationId, agentId) {
      const conversation = findConversation(conversationId);
      // 先验 Agent 存不存在，再验有没有在跑：两者都失败时，「未知 Agent」更接近
      // 用户真正按错的地方。
      agentById(agentId);
      if (runningRun(conversationId))
        throw new ClientError('BUSY', '请先停止当前回复，再切换 Agent');
      if (conversation.agentId === agentId) return;
      const event = store.setConversationAgent(conversationId, agentId, {
        type: 'agent.changed',
        agentId,
      });
      conversation.agentId = agentId;
      state.events.push(event);
      notify();
    },
    async sendMessage(conversationId, text) {
      const conversation = findConversation(conversationId);
      const input = typeof text === 'string' ? text.trim() : '';
      if (!input || input.length > 8000)
        throw new ClientError('VALIDATION', '请输入 1–8000 字的消息');
      if (runningRun(conversationId))
        throw new ClientError('BUSY', '当前对话正在回复');

      // **先答话，再落历史。** Agent 抛错时这次发送不留任何痕迹。
      // 解析的也是**用户的输入**，不是 Agent 刚编出来的回复：回复里会复述原话
      // （「你说：明天下午三点…」），拿去解析会抽出一份标题是半句客套话的日程草稿。
      //
      // 控制器在**起稿之前**就有：真模型那一步就是发 HTTP 请求，它必须能被掐断，
      // 而不是「等它交出流之后才算开始跑」。
      const runId = crypto.randomUUID();
      const controller = new AbortController();
      const answer = await agentById(conversation.agentId).reply({
        text: input,
        lastReply: lastAssistantReply(conversationId),
        signal: controller.signal,
      });

      const run: Run = {
        id: runId,
        conversationId,
        agentId: conversation.agentId,
        status: 'running',
      };
      controllers.set(run.id, controller);
      appendBatch(conversationId, [
        {
          type: 'message.created',
          message: { id: crypto.randomUUID(), role: 'user', content: input },
        },
        { type: 'run.started', run },
      ]);
      if (answer.draft) attempts.set(run.id, answer.draft);

      drafts[run.id] = '';
      /**
       * **消费 Agent 的流，而不是替它假装流**（ADR-031）。
       *
       * 以前这里是 `setInterval` 每 28 毫秒从一整句里切三个字 —— 那是模拟流式：内容
       * 早就在本地，只是放慢了给人看。真模型的内容是一边收一边出来的，那种写法根本
       * 接不上。现在谁 yield 什么就显示什么：一个状态机、两种节奏。
       *
       * 循环要能被从外部打断：`drafts[run.id]` 一旦没了，就是 `finish` 已经收尾
       * （取消或重绑），这时立刻退出，不再往一个已经不存在的 Run 上追加。
       */
      const iterator = answer.content[Symbol.asyncIterator]();
      streams.set(run.id, iterator);
      void (async () => {
        try {
          for (;;) {
            const step = await iterator.next();
            if (step.done) break;
            if (drafts[run.id] === undefined) break;
            drafts[run.id] += step.value;
            notify();
          }
          if (drafts[run.id] !== undefined) finish(run, 'completed');
        } catch (cause) {
          // 流到一半断了：**半截不落历史**（ADR-031 第 2 条），但要在界面上说清为什么断，
          // 而不是让 Run 永远停在「正在回复」。
          if (drafts[run.id] !== undefined) {
            finish(run, 'interrupted');
            process.stderr.write(
              `ONE 会话：${run.id} 的回复中断：${String(cause)}\n`,
            );
          }
        }
      })();
      notify();
      return structuredClone(run);
    },
    async cancelRun(runId) {
      assertOpen();
      const run = indexRuns(state.events).find((item) => item.id === runId);
      if (!run) throw new ClientError('NOT_FOUND', '找不到这次运行');
      if (run.status === 'running') finish(run, 'cancelled');
    },
    /**
     * 本体把处理结果写回会话。运行时**自己不碰领域能力** —— 真正写进日历的永远是本体
     * （ADR-016/022）；这一层只负责「这条提议现在什么状态」。
     */
    async settleProposal(proposalId, resolution) {
      assertOpen();
      const proposal = indexProposals(state.events).find(
        (item) => item.id === proposalId,
      );
      if (!proposal)
        throw new ClientError('NOT_FOUND', '找不到这条提议', { proposalId });
      if (proposal.status !== 'pending')
        throw new ClientError('CONFLICT', '这条提议已经处理过了', {
          proposalId,
          status: proposal.status,
        });
      const settled: ProposalResolution = {
        ...resolution,
        at: resolution.at || new Date().toISOString(),
      };
      appendBatch(proposal.sourceConversationId, [
        { type: 'proposal.settled', resolution: settled },
      ]);
      notify();
      return structuredClone(
        indexProposals(state.events).find((item) => item.id === proposalId) ??
          proposal,
      );
    },
    rebind() {
      // 内存里正在流的半截回复已经没有意义了 —— 库都被换掉了，那次 Run 在新状态里
      // 什么都不是。把**传输**也停掉，不然它会对着一个已经不存在的对话继续写。
      [...controllers.keys()].forEach(stopStream);
      attempts.clear();
      for (const key of Object.keys(drafts)) delete drafts[key];
      const fresh = store.open();
      state.workspaces = fresh.workspaces;
      state.conversations = fresh.conversations;
      state.events = fresh.events;
      // 新库里的「正在跑」同样是上次留下的 —— 按开库那套规矩诚实地收尾。
      for (const run of indexRuns(state.events)) {
        if (run.status === 'running')
          appendBatch(run.conversationId, [
            { type: 'run.finished', run: { ...run, status: 'interrupted' } },
          ]);
      }
      notify();
    },
    dispose() {
      // 本体要退出了，还在收 token 的那条连接不能留到进程被杀 —— 那是在白花钱。
      [...controllers.keys()].forEach(stopStream);
      attempts.clear();
      listeners.clear();
      store.close();
      disposed = true;
    },
  };
}
