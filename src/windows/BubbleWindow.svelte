<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
  import type { AgentId, Message } from '../../packages/contracts/src';
  import { client, link } from '../lib/client';
  import { pickActiveConversationId } from '../lib/active';
  import { pendingOf } from '../lib/proposal';
  import { shell } from '../lib/tauri';
  import ProposalCard from './ProposalCard.svelte';

  let snapshot = $state(client.getSnapshot());
  let input = $state('');
  let error = $state('');
  let coreState = $state(link.state());
  let inputElement = $state<HTMLInputElement | null>(null);

  const agents: { id: AgentId; name: string }[] = [
    { id: 'chat', name: 'Chat Agent' },
    { id: 'claude-code', name: 'Claude Code' },
    { id: 'mcode', name: 'MCode' },
  ];
  const PREVIEW = 60;

  const activeId = $derived(pickActiveConversationId(snapshot));
  const activeRun = $derived(
    snapshot.runs.find(
      (run) => run.conversationId === activeId && run.status === 'running',
    ),
  );
  const agentName = (id: AgentId) =>
    agents.find((agent) => agent.id === id)?.name ?? id;

  const lastReply = $derived.by((): Message | undefined => {
    for (const event of [...snapshot.events].reverse())
      if (
        event.type === 'message.created' &&
        event.message.role === 'assistant'
      )
        return event.message;
    return undefined;
  });

  /**
   * 有待确认的日程时，云让位给卡片。
   *
   * 不是「顺便加一行」：正是在这种时候用户最需要一个能点的按钮 —— 本体已经把
   * 草稿摆在桌面端上了，宠物端装作没看见，用户会以为刚才那句白说了。
   */
  const pendingProposal = $derived(
    coreState === 'ready' ? pendingOf(snapshot.proposals) : undefined,
  );

  /**
   * 刚被处理掉的那条也要露一下脸。
   *
   * 云表示的是「**当下**」，而刚跑完的那句回复写的是「确认后才会写进日历」。
   * 草稿已经写进去了、云里还挂着这句承诺 —— 那不是过时文案，是界面在说假话。
   * 只在「这条提议是在本窗口打开之后才被解决的」时才显示它，因此关掉再打开
   * 就回到状态云，不会永远停在一张旧结果卡上。
   */
  let settledAtMount = new Set<string>();
  onMount(() => {
    settledAtMount = new Set(
      snapshot.proposals
        .filter((item) => item.status !== 'pending')
        .map((item) => item.id),
    );
  });
  const freshOutcome = $derived.by(() => {
    if (coreState !== 'ready' || pendingProposal) return undefined;
    return [...snapshot.proposals]
      .reverse()
      .find(
        (item) => item.status !== 'pending' && !settledAtMount.has(item.id),
      );
  });
  const shownProposal = $derived(pendingProposal ?? freshOutcome);

  /**
   * 云只表示"正在做什么"，不是聊天记录：给一行状态加一段被截断的回答。
   * 没有本体时如实说没连接，绝不拿上一轮的旧内容冒充现在的状态。
   */
  const preview = $derived.by(() => {
    if (coreState !== 'ready') return '';
    if (pendingProposal) return '';
    const live = activeRun ? snapshot.drafts[activeRun.id] : undefined;
    const text = activeRun
      ? live || '正在准备回复…'
      : (lastReply?.content ?? '说一句，我就在这儿。');
    const trimmed = text.replace(/\s+/g, ' ').trim();
    return trimmed.length > PREVIEW ? `${trimmed.slice(0, PREVIEW)}…` : trimmed;
  });

  onMount(() => {
    const stop = client.subscribe(() => {
      snapshot = client.getSnapshot();
    });
    const stopLink = link.subscribe(() => {
      coreState = link.state();
    });
    // 打开对话条就是为了打字，焦点应该已经在框里。
    void tick().then(() => {
      inputElement?.focus();
      getCurrentWebviewWindow()
        .setFocus()
        .catch(() => undefined);
    });
    return () => {
      stop();
      stopLink();
    };
  });

  /**
   * 有待确认的草稿就把对话条撑高，解决完收回去。
   *
   * 比的是「上一次是什么状态」而不是「现在是不是高」—— 直接调 `setSize` 的话，
   * 每次快照推送都会对壳喊一嗓子同样的尺寸，而壳每次都要重新仲裁一整组窗口。
   */
  let wasTall: string | null = null;
  $effect(() => {
    const mode = pendingProposal ? 'action' : freshOutcome ? 'card' : 'normal';
    // 比的是「上一次是什么状态」而不是「现在该是几档」—— 否则每次快照推送都要
    // 对壳喊一嗓子同样的尺寸，而壳每次都要重新仲裁一整组窗口。
    if (wasTall === mode) return;
    wasTall = mode;
    void shell.resizeBubble(mode).catch(() => undefined);
  });

  async function send() {
    if (!activeId || !input.trim() || coreState !== 'ready') return;
    const text = input;
    input = '';
    error = '';
    try {
      await client.sendMessage(activeId, text);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : '操作失败，请重试';
    }
  }

  function stop() {
    if (!activeRun) return;
    error = '';
    void client.cancelRun(activeRun.id).catch((cause: unknown) => {
      error = cause instanceof Error ? cause.message : '停止失败，请重试';
    });
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      void shell.hideBubble();
    }
  }}
/>

<div class="strip">
  <section class="cloud" aria-live="polite" aria-label="ONE 当前状态">
    <p class="cloud-head">
      {#if activeRun}<span class="dots" aria-hidden="true"
          ><i></i><i></i><i></i></span
        >{/if}
      {coreState === 'ready'
        ? activeRun
          ? `${agentName(activeRun.agentId)} 正在思考`
          : 'ONE'
        : coreState === 'rejected'
          ? 'ONE 拒绝了这个客户端'
          : coreState === 'connecting'
            ? '正在连接 ONE 本体'
            : 'ONE 本体未连接'}
      <button
        class="close"
        aria-label="关闭"
        title="关闭（Esc）"
        onclick={() => void shell.hideBubble()}
      >
        ✕
      </button>
    </p>
    {#if shownProposal}
      <ProposalCard proposal={shownProposal} compact />
    {:else}
      <p
        class="cloud-body"
        class:working={!!activeRun}
        class:muted={coreState !== 'ready'}
      >
        {coreState === 'ready'
          ? preview
          : link.problem() ||
            '本体没有运行或还没接受这个客户端，这里不会显示旧内容。'}
      </p>
    {/if}
  </section>

  <form
    class="bar"
    onsubmit={(event) => {
      event.preventDefault();
      void send();
    }}
  >
    <button
      type="button"
      class="grip"
      aria-label="移动这条对话条：拖动，或用方向键移动"
      title="拖动移动"
      onmousedown={() => void shell.startDrag()}
    ></button>
    <label class="sr-only" for="quick-input">对 ONE 说点什么</label>
    <!-- 自动填充/autocomplete 全部关掉：一聚焦就弹的下拉会盖住状态云，
         而这条输入框本来就没有可填的历史。 -->
    <input
      id="quick-input"
      bind:this={inputElement}
      bind:value={input}
      maxlength="8000"
      placeholder={error ||
        (coreState === 'ready' ? '对 ONE 说点什么…' : '本体未连接')}
      disabled={coreState !== 'ready'}
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      onkeydown={(event) => {
        // 中文输入法确认候选词时也会给 Enter，不能当成发送。
        if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault();
          if (!activeRun) void send();
        }
      }}
    />
    {#if activeRun}
      <button class="stop" type="button" onclick={stop}>停止</button>
    {:else}
      <button
        class="send"
        type="submit"
        disabled={!input.trim() || coreState !== 'ready'}>发送</button
      >
    {/if}
  </form>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  /* app.css paints :root; the window must stay transparent around the card. */
  :global(html:root),
  :global(body) {
    background: transparent;
    overflow: hidden;
  }
  .strip {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    padding: 8px 10px 10px;
    background: transparent;
  }
  /* The cloud sits above the bar and points back at the pet. */
  .cloud {
    position: relative;
    padding: 8px 10px 10px;
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 16px;
    box-shadow: 0 6px 18px rgba(48, 59, 53, 0.12);
  }
  .cloud::before {
    content: '';
    position: absolute;
    top: -7px;
    left: 50%;
    width: 12px;
    height: 12px;
    background: #fff;
    border-left: 1px solid var(--line);
    border-top: 1px solid var(--line);
    transform: translateX(-50%) rotate(45deg);
  }
  .cloud-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: 12px;
    color: var(--accent);
  }
  .dots {
    display: inline-flex;
    gap: 3px;
  }
  .dots i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
    animation: blink 1.1s ease-in-out infinite;
  }
  .dots i:nth-child(2) {
    animation-delay: 0.18s;
  }
  .dots i:nth-child(3) {
    animation-delay: 0.36s;
  }
  .cloud-body {
    margin: 4px 0 0;
    font-size: 13px;
    line-height: 1.5;
    color: #4a544d;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .cloud-body.working {
    color: #303b35;
  }
  .cloud-body.muted {
    color: var(--muted);
  }
  .close {
    margin-left: auto;
    padding: 0 4px;
    border: none;
    background: transparent;
    font-size: 12px;
    color: var(--muted);
    line-height: 1;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 6px 5px 4px;
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: 0 4px 14px rgba(48, 59, 53, 0.1);
  }
  .grip {
    flex-shrink: 0;
    width: 10px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 5px;
    cursor: grab;
    background: repeating-linear-gradient(
      230deg,
      rgba(64, 103, 71, 0.4) 0 3px,
      transparent 3px 6px
    );
  }
  input {
    flex: 1;
    min-width: 0;
    padding: 6px 4px;
    border: none;
    background: transparent;
    font-size: 13px;
  }
  input:focus-visible {
    outline: 2px solid #688858;
    outline-offset: 2px;
  }
  input:disabled {
    color: var(--muted);
  }
  .send,
  .stop {
    flex-shrink: 0;
    padding: 6px 12px;
    border: none;
    border-radius: 8px;
    background: var(--accent);
    color: #fff;
    font-size: 12px;
  }
  .stop {
    background: #8a3b2f;
  }
  .send:disabled {
    background: #c3cbc4;
  }
  .error {
    margin: 0;
    font-size: 12px;
    color: #8a3b2f;
  }
  @keyframes blink {
    0%,
    100% {
      opacity: 0.25;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dots i {
      animation: none;
      opacity: 0.8;
    }
  }
</style>
