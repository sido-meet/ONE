<script lang="ts">
  import { onMount } from 'svelte';
  import type { AgentId, Message } from '../../packages/contracts/src';
  import { client, serviceState } from '../lib/client';
  import { pickActiveConversationId } from '../lib/active';
  import { shell } from '../lib/tauri';

  let snapshot = $state(client.getSnapshot());
  let input = $state('');
  let error = $state('');
  const agents: { id: AgentId; name: string }[] = [
    { id: 'chat', name: 'Chat Agent' },
    { id: 'claude-code', name: 'Claude Code' },
    { id: 'mcode', name: 'MCode' },
  ];

  const activeId = $derived(pickActiveConversationId(snapshot));
  const conversation = $derived(
    snapshot.conversations.find((item) => item.id === activeId),
  );
  const events = $derived(
    snapshot.events.filter((event) => event.conversationId === activeId),
  );
  const activeRun = $derived(
    snapshot.runs.find(
      (run) => run.conversationId === activeId && run.status === 'running',
    ),
  );
  const unavailable = $derived(serviceState() === 'unavailable');
  const agentName = (id: AgentId) =>
    agents.find((agent) => agent.id === id)?.name ?? id;

  /** The work panel owns the live reply, so history only shows finished turns. */
  const liveText = $derived(
    activeRun ? snapshot.drafts[activeRun.id] || '正在准备回复…' : '',
  );
  const lastReply = $derived.by((): Message | undefined => {
    for (const event of [...events].reverse())
      if (
        event.type === 'message.created' &&
        event.message.role === 'assistant'
      )
        return event.message;
    return undefined;
  });

  onMount(() => {
    const unsubscribe = client.subscribe(() => {
      snapshot = client.getSnapshot();
    });
    return unsubscribe;
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
    if (!activeId || !input.trim()) return;
    const text = input;
    input = '';
    await act(() => client.sendMessage(activeId!, text));
  }
  /** Arrow keys move the window so the drag strip is usable without a mouse. */
  function move(event: KeyboardEvent) {
    const step = event.shiftKey ? 1 : 16;
    const offset: Record<string, [number, number]> = {
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
    };
    const next = offset[event.key];
    if (!next) return;
    event.preventDefault();
    void shell.moveWindow(next[0], next[1]);
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape') void shell.hideBubble();
  }}
/>

<div class="bubble">
  <header>
    <button
      class="drag"
      aria-label="移动小聊天框：拖动，或用方向键移动（按住 Shift 微调）"
      title="拖动移动"
      onmousedown={() => void shell.startDrag()}
      onkeydown={move}
    ></button>
    <div class="titles">
      <strong>{conversation?.title ?? '还没有对话'}</strong>
      <span>与主窗口同一对话 · 模拟数据</span>
    </div>
    <div class="actions">
      <button title="在主窗口打开" onclick={() => void shell.openMain()}
        >展开</button
      >
      <button title="显示桌面宠物" onclick={() => void shell.showPet()}
        >宠物</button
      >
      <button title="关闭小聊天框" onclick={() => void shell.hideBubble()}
        >✕</button
      >
    </div>
  </header>

  {#if unavailable}
    <p class="banner" role="alert">
      原型服务不可用：请在主窗口确认 ONE 仍在运行。
    </p>
  {/if}

  <section class="work" aria-label="ONE 当前工作" aria-live="polite">
    <p class="work-head">
      {#if activeRun}<span class="dot" aria-hidden="true"></span>{/if}
      {activeRun
        ? `${agentName(activeRun.agentId)} 正在回复`
        : lastReply
          ? `${agentName(lastReply.agentId ?? 'chat')} · 上次回复`
          : 'ONE 空闲'}
    </p>
    <p class="work-body">
      {activeRun
        ? liveText
        : (lastReply?.content ?? '说一句话，这里就会开始。')}
    </p>
  </section>

  <div class="messages" aria-label="聊天记录">
    {#if events.length === 0}
      <p class="empty">历史会同时出现在主窗口。</p>
    {/if}
    {#each events as event (event.id)}
      {#if event.type === 'message.created'}
        <p class:mine={event.message.role === 'user'} class="line">
          <span class="who"
            >{event.message.role === 'user'
              ? '你'
              : `${agentName(event.message.agentId ?? 'chat')} · 模拟`}</span
          >
          {event.message.content}
        </p>
      {:else if event.type === 'agent.changed'}
        <p class="divider">已切换至 {agentName(event.agentId)} · 历史保留</p>
      {:else if event.type === 'run.finished' && event.run.status === 'cancelled'}
        <p class="divider">回复已停止</p>
      {/if}
    {/each}
  </div>

  <div class="composer">
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <label class="sr-only" for="bubble-input">发送消息</label>
    <textarea
      id="bubble-input"
      bind:value={input}
      rows="2"
      maxlength="8000"
      placeholder="告诉 ONE，你在想什么…"
      onkeydown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          if (!activeRun) void send();
        }
      }}></textarea>
    <div class="row">
      <label class="agent">
        Agent
        <select
          value={conversation?.agentId ?? ''}
          disabled={!!activeRun || !activeId}
          onchange={(event) =>
            act(() =>
              client.changeAgent(
                activeId!,
                event.currentTarget.value as AgentId,
              ),
            )}
        >
          {#each agents as agent}<option value={agent.id}
              >{agent.name} · 模拟</option
            >{/each}
        </select>
      </label>
      {#if activeRun}<button
          class="stop"
          onclick={() => act(() => client.cancelRun(activeRun!.id))}
          >停止</button
        >{:else}<button class="send" disabled={!input.trim()} onclick={send}
          >发送</button
        >{/if}
    </div>
  </div>
</div>

<style>
  /* app.css paints :root; a rounded window needs the page behind it cleared. */
  :global(html:root),
  :global(body) {
    background: transparent;
  }
  .bubble {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    background: #f7f7f2;
    border: 1px solid var(--line);
    border-radius: 12px;
    overflow: hidden;
  }
  header {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 12px 10px 26px;
    background: #eeefe8;
    border-bottom: 1px solid var(--line);
  }
  .drag {
    position: absolute;
    left: 8px;
    top: 50%;
    transform: translateY(-50%);
    width: 12px;
    height: 26px;
    padding: 0;
    border: none;
    border-radius: 6px;
    cursor: grab;
    background: repeating-linear-gradient(
      180deg,
      rgba(64, 103, 71, 0.4) 0 3px,
      transparent 3px 6px
    );
  }
  .titles {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .titles strong {
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .titles span {
    font-size: 12px;
    color: var(--muted);
  }
  .actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .actions button {
    border: 1px solid var(--line);
    background: #fff;
    border-radius: 8px;
    padding: 4px 8px;
    font-size: 12px;
  }
  .banner {
    margin: 0;
    padding: 8px 12px;
    font-size: 12px;
    background: #fdf1ef;
    color: #8a3b2f;
    border-bottom: 1px solid #f2d8d2;
  }
  .work {
    margin: 10px 12px 0;
    padding: 10px 12px;
    background: #eef2ea;
    border: 1px solid #dbe3d4;
    border-radius: 10px;
    flex-shrink: 0;
  }
  .work-head {
    margin: 0 0 4px;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--accent);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.2s ease-in-out infinite;
  }
  .work-body {
    margin: 0;
    font-size: 13px;
    line-height: 1.6;
    color: #303b35;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 108px;
    overflow-y: auto;
  }
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .empty {
    margin: auto;
    font-size: 12px;
    color: var(--muted);
    text-align: center;
  }
  .line {
    margin: 0;
    font-size: 13px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .line.mine {
    color: var(--accent);
  }
  .who {
    display: block;
    font-size: 12px;
    color: var(--muted);
    margin-bottom: 2px;
  }
  .divider {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
    text-align: center;
  }
  .composer {
    border-top: 1px solid var(--line);
    padding: 10px 12px 12px;
  }
  textarea {
    width: 100%;
    resize: none;
    padding: 8px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: #fff;
    font-size: 13px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 8px;
  }
  .agent {
    font-size: 12px;
    color: var(--muted);
  }
  select {
    margin-left: 4px;
    padding: 4px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: #fff;
  }
  .send,
  .stop {
    padding: 6px 14px;
    border-radius: 8px;
    border: 1px solid transparent;
    font-size: 13px;
  }
  .send {
    background: var(--accent);
    color: #fff;
  }
  .stop {
    background: #fff;
    border-color: var(--line);
  }
  .error {
    margin: 0 0 8px;
    font-size: 12px;
    color: #8a3b2f;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot {
      animation: none;
    }
  }
</style>
