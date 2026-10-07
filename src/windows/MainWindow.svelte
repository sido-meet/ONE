<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
  import type { AgentId } from '../../packages/contracts/src';
  import { client, link } from '../lib/client';
  import { createDraftBook } from '../lib/drafts';
  import { shouldStickToBottom, stickToBottom } from '../lib/follow';
  import { proposalsByMessage } from '../lib/proposal';
  import { failureOf, reasonOf } from '../lib/send';
  import type { SendFailure } from '../lib/send';
  import { shell, listenBeforeQuit } from '../lib/tauri';
  import ProposalCard from './ProposalCard.svelte';

  // 本轮范围：桌面端只保证"能独立接上本体、不假装有功能"，交互打磨放到后面。
  let snapshot = $state(client.getSnapshot());
  let selectedId = $state('welcome');
  let page = $state<'chat' | 'plan'>('chat');
  let input = $state('');
  let coreState = $state(link.state());
  /** 送不出去的那句话。留着就能重试，清掉等于让用户重打一遍。 */
  let failure = $state<SendFailure | undefined>(undefined);

  /**
   * 每对话各留一份草稿（P06）。切走时存、切回时取，键是**对话**不是窗口 ——
   * 一个全局草稿只够防「刷新」，防不了「换到别的对话再换回来」。
   */
  const drafts = createDraftBook();
  const goto = (id: string) => {
    drafts.save(selectedId, input);
    selectedId = id;
    page = 'chat';
    input = drafts.take(id);
    failure = undefined;
  };

  /** 按 messageId 分组一次，渲染时直接查 —— 别在模板里 filter 整个数组。 */
  const proposalsOf = $derived.by(() => {
    const grouped = proposalsByMessage(snapshot.proposals);
    return (messageId: string) => grouped.get(messageId) ?? [];
  });

  const agents: { id: AgentId; name: string }[] = [
    { id: 'chat', name: 'Chat Agent' },
    { id: 'claude-code', name: 'Claude Code' },
    { id: 'mcode', name: 'MCode' },
  ];
  const conversation = $derived(
    snapshot.conversations.find((item) => item.id === selectedId),
  );
  const events = $derived(
    snapshot.events.filter((event) => event.conversationId === selectedId),
  );
  const activeRun = $derived(
    snapshot.runs.find(
      (run) => run.conversationId === selectedId && run.status === 'running',
    ),
  );
  const agentName = (id: AgentId) =>
    agents.find((agent) => agent.id === id)?.name ?? id;

  onMount(() => {
    const stop = client.subscribe(() => {
      snapshot = client.getSnapshot();
    });
    const stopLink = link.subscribe(() => {
      coreState = link.state();
    });
    return () => {
      stop();
      stopLink();
    };
  });

  onMount(() => {
    const stopRunningWork = async () => {
      const running = client
        .getSnapshot()
        .runs.filter((run) => run.status === 'running');
      await Promise.all(running.map((run) => client.cancelRun(run.id)));
    };
    const stopBeforeQuit = listenBeforeQuit(() => {
      void (async () => {
        await stopRunningWork();
        await shell.forceQuit();
      })();
    });
    const closeRequested = getCurrentWebviewWindow().onCloseRequested(
      (event) => {
        event.preventDefault();
        void shell.quit();
      },
    );
    return () => {
      void stopBeforeQuit.then((stop) => stop());
      void closeRequested.then((stop) => stop());
    };
  });

  async function send() {
    const text = input.trim();
    if (!text) return;
    failure = undefined;
    try {
      await client.sendMessage(selectedId, text);
      // **送出去了才清框。** 失败时这句话得留在原地，旁边就有重试。
      input = '';
      drafts.clear(selectedId);
    } catch (cause) {
      failure = failureOf(text, cause);
    }
  }

  /** 重试就是原样再送一遍那句话 —— 不重新加工，也不替用户改写。 */
  async function retry() {
    if (!failure?.retryable) return;
    const text = failure.text;
    failure = undefined;
    try {
      await client.sendMessage(selectedId, text);
      input = '';
      drafts.clear(selectedId);
    } catch (cause) {
      failure = failureOf(text, cause);
    }
  }

  async function act(action: () => Promise<unknown>) {
    try {
      await action();
    } catch (cause) {
      failure = failureOf('', cause);
    }
  }

  async function create() {
    try {
      drafts.save(selectedId, input);
      const made = await client.createConversation();
      input = '';
      selectedId = made.id;
      page = 'chat';
      failure = undefined;
    } catch (cause) {
      failure = failureOf('', cause);
    }
  }

  /**
   * **只有用户本来就在底部时才跟着新内容往下滚**（P06）。
   *
   * 他往上翻是为了读更早的一段，回复到达时把他拽回底部，等于当着他的面把字抽走，
   * 而且他不知道为什么。所以判断的是「发送前他是不是贴着底」，不是「内容是不是
   * 变长了」。
   */
  let scroller = $state<HTMLDivElement | null>(null);
  let sticking = $state(true);
  const onScroll = () => {
    if (!scroller) return;
    sticking = shouldStickToBottom({
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
    });
  };

  $effect(() => {
    // 依赖这两条：消息条数与正在增长的草稿。读出来只是为了让这条 effect 在
    // 「内容变了」时重跑，值本身用不上。
    const messages = events.length;
    const runId = activeRun?.id;
    const live = runId ? snapshot.drafts[runId] : '';
    void messages;
    void live;
    if (!sticking || !scroller) return;
    void tick().then(() => {
      if (scroller) scroller.scrollTop = stickToBottom(scroller);
    });
  });
</script>

<div class="shell">
  <aside class="sidebar">
    <a
      class="brand"
      href="#chat"
      onclick={() => {
        page = 'chat';
      }}
      aria-label="ONE 首页"
      ><span class="brand-symbol">o</span> ONE<span class="version"
        >0.2.0-dev</span
      ></a
    >
    <div class="space-label">个人空间 <span>LOCAL</span></div>
    <button class="new-chat" onclick={create}><span>＋</span> 开始新对话</button
    >
    <div class="section-label">我的对话</div>
    <nav aria-label="对话列表">
      {#each snapshot.conversations as item (item.id)}
        <button
          class:chosen={selectedId === item.id && page === 'chat'}
          onclick={() => goto(item.id)}
          ><span class="conversation-dot"></span>{item.title}</button
        >
      {/each}
    </nav>
    <div class="sidebar-bottom">
      <button
        class:chosen={page === 'plan'}
        onclick={() => {
          page = 'plan';
        }}>◈ <span>项目起点</span><span class="arrow">↗</span></button
      >
      <p>一个对话，持续生长。</p>
    </div>
  </aside>

  <main>
    <header>
      <div class="breadcrumb">
        ONE <span>/</span>
        {page === 'chat' ? '对话' : '项目起点'}
      </div>
      <span class="demo-badge"><span></span> 桌面端客户端 · 本轮未打磨</span>
    </header>
    {#if page === 'chat'}
      <section class="chat-heading">
        <div>
          <p class="eyebrow">YOUR CONVERSATION, YOURS TO KEEP</p>
          <h1>{conversation?.title ?? '正在连接 ONE 本体…'}</h1>
        </div>
        <label class="agent-picker"
          >当前 Agent
          <select
            value={conversation?.agentId}
            disabled={!!activeRun || coreState !== 'ready'}
            onchange={(event) =>
              act(() =>
                client.changeAgent(
                  selectedId,
                  event.currentTarget.value as AgentId,
                ),
              )}
          >
            {#each agents as agent}<option value={agent.id}
                >{agent.name} · 模拟</option
              >{/each}
          </select>
        </label>
      </section>
      <div
        class="chat-body"
        bind:this={scroller}
        onscroll={onScroll}
        aria-label="聊天记录"
      >
        {#if coreState !== 'ready'}
          <div class="welcome">
            <p class="eyebrow">ONE 本体</p>
            <h2>
              {coreState === 'rejected' ? '协议不兼容' : '还没有连上 ONE 本体'}
            </h2>
            <p>
              {link.problem() ||
                '本体没有运行或还没接受这个客户端，这里不显示假数据。'}
            </p>
          </div>
        {:else if events.length === 0}
          <div class="welcome">
            <div class="orb" aria-hidden="true"><span></span><span></span></div>
            <p class="eyebrow">MEET ONE</p>
            <h2>想法，从一句话开始。</h2>
            <p>
              让对话留在这里，让不同的 Agent 接力。<br />先试着聊一句，感受 ONE
              的第一步。
            </p>
          </div>
        {/if}
        {#each events as event (event.id)}
          {#if event.type === 'message.created'}
            <article
              class:user-message={event.message.role === 'user'}
              class="message"
            >
              <div class="message-label">
                {event.message.role === 'user'
                  ? '你'
                  : `${agentName(event.message.agentId ?? 'chat')} · 模拟`}
              </div>
              <p>{event.message.content}</p>
              <!-- 提议挂在**自己那条**回复下面（ADR-022）。归属靠 messageId，
                   不靠「最新的那条」—— 那样三张卡会全部堆到最后一句上。 -->
              {#each proposalsOf(event.message.id) as proposal (proposal.id)}
                <ProposalCard
                  {proposal}
                  onJumpSource={(id) => {
                    selectedId = id;
                    page = 'chat';
                  }}
                />
              {/each}
            </article>
          {:else if event.type === 'agent.changed'}
            <p class="event-divider">
              已切换至 {agentName(event.agentId)} · 对话历史保留
            </p>
          {:else if event.type === 'run.finished' && event.run.status === 'cancelled'}
            <p class="event-divider">回复已停止</p>
          {/if}
        {/each}
        {#if activeRun}
          <article class="message">
            <div class="message-label">
              {agentName(activeRun.agentId)} · 模拟回复中
            </div>
            <p>
              {snapshot.drafts[activeRun.id] || '正在准备回复…'}<span
                class="cursor">▍</span
              >
            </p>
          </article>
        {/if}
      </div>
      <div class="composer-area">
        {#if failure}
          <!-- 失败条要说清发生了什么、能做什么，并且**那句话还在框里**：
               清掉等于让用户重打一遍，而重打的那遍往往还不一样。
               所以这里只有一个「重试」和一个「知道了」，没有「清空」。 -->
          <p class="error" role="alert">
            <span>{reasonOf(failure)}</span>
            {#if failure.retryable}
              <button type="button" class="retry" onclick={() => void retry()}
                >重试</button
              >
            {/if}
            <button
              type="button"
              class="retry"
              onclick={() => (failure = undefined)}>知道了</button
            >
          </p>
        {/if}
        <form
          onsubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label class="sr-only" for="message">发送消息</label>
          <textarea
            id="message"
            bind:value={input}
            placeholder="告诉 ONE，你在想什么…"
            rows="2"
            maxlength="8000"
            disabled={coreState !== 'ready'}
            oninput={() => {
              // 用户改了这句话，上面那条针对旧句子的失败提示就不再成立。
              if (failure && input.trim() !== failure.text) failure = undefined;
            }}
            onkeydown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.isComposing
              ) {
                event.preventDefault();
                if (!activeRun) void send();
              }
            }}></textarea>
          <div class="composer-footer">
            <span
              >↵ 发送 <span class="separator">·</span> Shift + Enter 换行</span
            >
            {#if activeRun}<button
                class="send"
                type="button"
                onclick={() => act(() => client.cancelRun(activeRun!.id))}
                >停止回复 ■</button
              >
            {:else}<button
                class="send"
                type="submit"
                disabled={!input.trim() || coreState !== 'ready'}>发送 ↑</button
              >{/if}
          </div>
        </form>
        <p class="footnote">
          这个窗口是本体的一个呈现形式，对话不在这里。回复仍是本地模拟。
        </p>
      </div>
    {:else}
      <section class="plan-page">
        <p class="eyebrow">BUILD ONE, STEP BY STEP</p>
        <h1>先让想法变得可体验。</h1>
        <p class="plan-intro">
          ONE
          本体已经独立，宠物端本轮做完；桌面端先能独立接上本体，交互后面再补。
        </p>
        <div class="milestones">
          <article>
            <span class="step">00 / 已完成</span>
            <h2>ONE 本体</h2>
            <p>独立进程持有唯一状态，客户端通过命名管道接入。</p>
          </article>
          <article>
            <span class="step">01 / 进行中</span>
            <h2>宠物端</h2>
            <p>桌面上的一根对话条与一朵状态云，全部状态来自本体。</p>
          </article>
          <article>
            <span class="step">02 / 计划</span>
            <h2>桌面端打磨</h2>
            <p>与宠物互调、窗口管理、完整的客户端联动界面。</p>
          </article>
        </div>
        <p class="footnote">
          完整规划位于项目 README.md 与 docs/ 目录。此页用于说明开发阶段。
        </p>
      </section>
    {/if}
  </main>
</div>
