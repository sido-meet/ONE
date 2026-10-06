<script lang="ts">
  import { onMount } from 'svelte';
  import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
  import type { AgentId } from '../../packages/contracts/src';
  import { client, windowLabel } from '../lib/client';
  import { shell } from '../lib/tauri';
  import { HOST_BEFORE_QUIT } from '../lib/protocol';

  let snapshot = $state(client.getSnapshot());
  let selectedId = $state('welcome');
  let page = $state<'chat' | 'plan'>('chat');
  let input = $state('');
  let error = $state('');
  let petVisible = $state(true);
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
  onMount(() =>
    client.subscribe(() => {
      snapshot = client.getSnapshot();
    }),
  );
  /**
   * Quitting stops what is running before the process goes away. The shell falls
   * back to a forced exit if this window cannot answer, so it never hangs.
   */
  onMount(() => {
    if (windowLabel !== 'main') return;
    const stopRunningWork = async () => {
      const running = client
        .getSnapshot()
        .runs.filter((run) => run.status === 'running');
      await Promise.all(running.map((run) => client.cancelRun(run.id)));
    };
    const beforeQuit = getCurrentWebviewWindow().listen(
      HOST_BEFORE_QUIT,
      () => {
        void (async () => {
          await stopRunningWork();
          await shell.forceQuit();
        })();
      },
    );
    const closeRequested = getCurrentWebviewWindow().onCloseRequested(
      (event) => {
        event.preventDefault();
        void shell.quit();
      },
    );
    return () => {
      void beforeQuit.then((stop) => stop());
      void closeRequested.then((stop) => stop());
    };
  });
  async function act(action: () => Promise<unknown>) {
    error = '';
    try {
      await action();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : '操作失败，请重试';
    }
  }
  async function send() {
    if (!input.trim()) return;
    await act(async () => {
      await client.sendMessage(selectedId, input);
      input = '';
    });
  }
  async function create() {
    await act(async () => {
      selectedId = (await client.createConversation()).id;
      page = 'chat';
      input = '';
    });
  }
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
      ><span class="brand-symbol">o</span> ONE<span class="version">0.0.1</span
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
          onclick={() => {
            selectedId = item.id;
            page = 'chat';
            input = '';
            error = '';
          }}><span class="conversation-dot"></span>{item.title}</button
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
      <div class="pet-tools">
        <p class="section-label">桌面入口</p>
        <button
          onclick={() =>
            act(async () => {
              await shell.openBubble();
            })}>打开小聊天框</button
        >
        {#if petVisible}<button
            onclick={() =>
              act(async () => {
                await shell.hidePet();
                petVisible = false;
              })}>隐藏宠物</button
          >{:else}<button
            onclick={() =>
              act(async () => {
                await shell.showPet();
                petVisible = true;
              })}>显示宠物</button
          >{/if}
      </div>
      <p>一个对话，持续生长。</p>
    </div>
  </aside>

  <main>
    <header>
      <div class="breadcrumb">
        ONE <span>/</span>
        {page === 'chat' ? '对话' : '项目起点'}
      </div>
      <span class="demo-badge"><span></span> 交互原型 · 模拟数据</span>
    </header>
    {#if page === 'chat'}
      <section class="chat-heading">
        <div>
          <p class="eyebrow">YOUR CONVERSATION, YOURS TO KEEP</p>
          <h1>{conversation?.title}</h1>
        </div>
        <label class="agent-picker"
          >当前 Agent
          <select
            value={conversation?.agentId}
            disabled={!!activeRun}
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
      <div class="chat-body" aria-label="聊天记录">
        {#if events.length === 0}
          <div class="welcome">
            <div class="orb" aria-hidden="true"><span></span><span></span></div>
            <p class="eyebrow">MEET ONE</p>
            <h2>想法，从一句话开始。</h2>
            <p>
              让对话留在这里，让不同的 Agent 接力。<br />先试着聊一句，感受 ONE
              的第一步。
            </p>
            <div class="suggestions">
              <button
                onclick={() => {
                  input = '一起规划我的 ONE 项目';
                }}>一起规划我的 ONE 项目 <span>↗</span></button
              >
              <button
                onclick={() => {
                  input = '解释一下：对话如何跨 Agent 保留？';
                }}>了解对话与 Agent <span>↗</span></button
              >
            </div>
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
        {#if error}<p class="error" role="alert">{error}</p>{/if}
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
            {:else}<button class="send" type="submit" disabled={!input.trim()}
                >发送 ↑</button
              >{/if}
          </div>
        </form>
        <p class="footnote">
          当前为本地模拟体验，刷新后清空。Claude Code 与 MCode 尚未连接。
        </p>
      </div>
    {:else}
      <section class="plan-page">
        <p class="eyebrow">BUILD ONE, STEP BY STEP</p>
        <h1>先让想法变得可体验。</h1>
        <p class="plan-intro">
          ONE 的起点已经准备好。每一层能力，都围绕同一个对话逐步生长。
        </p>
        <div class="milestones">
          <article>
            <span class="step">00 / 已准备</span>
            <h2>项目基础</h2>
            <p>开发文档、类型契约、模拟对话、测试与桌面壳配置。</p>
          </article>
          <article>
            <span class="step">01 / 下一步</span>
            <h2>让 ONE 活起来</h2>
            <p>桌面宠物、小聊天框，以及日历和笔记的完整模拟交互。</p>
          </article>
          <article>
            <span class="step">02 / 后续</span>
            <h2>连接真实能力</h2>
            <p>本地保存、真实模型、Agent 接力与统一的工具调用。</p>
          </article>
        </div>
        <div class="principle">
          <span>ONE PRINCIPLE</span>
          <h2>对话属于你。<br />Agent 是参与者。</h2>
          <p>切换的是处理对话的能力，保留的是你的目标、历史与工作成果。</p>
        </div>
        <p class="footnote">
          完整规划位于项目 README.md 与 docs/ 目录。此页用于说明开发阶段。
        </p>
      </section>
    {/if}
  </main>
</div>
