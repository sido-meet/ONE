<script lang="ts">
  import type {
    Proposal,
    ProposalResolution,
  } from '../../packages/contracts/src/index.ts';
  import { link } from '../lib/client';
  import { outcomeOf, titleOf, whenOf } from '../lib/proposal';

  /**
   * 待确认提议的卡片（ADR-022）。
   *
   * 两个窗口共用它，靠 `compact` 适配：主窗口把它挂在 assistant 消息下面，
   * 宠物端对话条只有 380×168，挤不下完整卡片，于是换成一行。
   *
   * 三个结果都有话说 —— 待确认、已写进去、没写进去。卡片从「待确认」直接变成空白，
   * 用户会以为它从没出现过。
   */
  let { proposal, compact = false }: { proposal: Proposal; compact?: boolean } =
    $props();

  let busy = $state(false);
  let error = $state('');
  /** 点了「拒绝」才问原因：一张卡上常驻一个输入框，会把它变成一个第二块聊天区。 */
  let asking = $state(false);
  let reason = $state('');

  const settled = $derived(proposal.status !== 'pending');

  async function decide(decision: 'confirm' | 'reject') {
    if (busy) return;
    error = '';
    busy = true;
    try {
      const answer = (await link.resolveProposal(
        proposal.id,
        decision,
        decision === 'reject' ? reason.trim() : undefined,
      )) as ProposalResolution;
      // 重复确认不报错，但界面要**说清楚没有再写一次**，而不是又演一遍成功。
      if (!answer.applied && answer.status === 'created') {
        error = '已经创建过了，没有重复创建。';
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : '处理失败，请重试';
    } finally {
      busy = false;
      asking = false;
    }
  }
</script>

<article class="card" class:compact class:done={settled} aria-label="日程草稿">
  <p class="head">
    <span class="kind">{settled ? '日程' : '日程草稿'}</span>
    <strong class="title">{titleOf(proposal)}</strong>
  </p>
  {#if proposal.domain === 'calendar'}
    <p class="when">{whenOf(proposal)}</p>
  {/if}

  {#if settled}
    <p class="outcome" role="status">{outcomeOf(proposal)}</p>
  {:else if asking}
    <div class="ask">
      <label class="sr-only" for={`why-${proposal.id}`}>不写进去的原因</label>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        id={`why-${proposal.id}`}
        type="text"
        maxlength="500"
        placeholder="为什么不写？回车确认"
        bind:value={reason}
        onkeydown={(event) => {
          if (event.key === 'Enter' && !event.isComposing && reason.trim())
            void decide('reject');
        }}
      />
      <button
        type="button"
        class="ghost"
        disabled={!reason.trim() || busy}
        onclick={() => void decide('reject')}
      >
        确认拒绝
      </button>
      <button type="button" class="ghost" onclick={() => (asking = false)}
        >算了</button
      >
    </div>
  {:else}
    <div class="acts">
      <button
        type="button"
        class="yes"
        disabled={busy}
        onclick={() => void decide('confirm')}
      >
        {busy ? '处理中…' : '确认写进日历'}
      </button>
      <button
        type="button"
        class="ghost"
        disabled={busy}
        onclick={() => (asking = true)}>拒绝</button
      >
    </div>
  {/if}

  {#if error}<p class="err" role="alert">{error}</p>{/if}
</article>

<style>
  .card {
    margin: 6px 0 2px;
    padding: 10px 12px;
    background: #f7faf6;
    border: 1px solid var(--line);
    border-radius: 12px;
  }
  /* 窄窗口里不能再堆三行：头与时点并排，按钮独占一行但压扁高度。 */
  .card.compact {
    margin: 6px 0 0;
    padding: 8px 10px;
    border-radius: 10px;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin: 0;
    font-size: 13px;
  }
  .compact .head {
    font-size: 12px;
  }
  .kind {
    flex-shrink: 0;
    padding: 1px 6px;
    border-radius: 6px;
    background: #e3ecdd;
    color: #40674a;
    font-size: 11px;
  }
  .title {
    /* 长标题要能断行：把按钮挤出卡片比截断标题更糟。 */
    overflow-wrap: anywhere;
    color: #303b35;
  }
  .when {
    margin: 4px 0 0;
    font-size: 12px;
    line-height: 1.5;
    color: #4a544d;
    /* 绝对时间一位都不能省，横向滚比看不全强。 */
    overflow-wrap: anywhere;
  }
  .compact .when {
    font-size: 11px;
  }
  .outcome {
    margin: 6px 0 0;
    font-size: 12px;
    color: #40674a;
  }
  .card.done {
    background: #f2f6f0;
  }
  .acts,
  .ask {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
  }
  .yes {
    padding: 5px 12px;
    border: none;
    border-radius: 8px;
    background: var(--accent);
    color: #fff;
    font-size: 12px;
    cursor: pointer;
  }
  .ghost {
    padding: 5px 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: #fff;
    color: #4a544d;
    font-size: 12px;
    cursor: pointer;
  }
  .yes:disabled,
  .ghost:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .yes:focus-visible,
  .ghost:focus-visible,
  input:focus-visible {
    outline: 2px solid #688858;
    outline-offset: 2px;
  }
  .ask input {
    flex: 1;
    min-width: 0;
    padding: 5px 8px;
    border: 1px solid var(--line);
    border-radius: 8px;
    font-size: 12px;
  }
  .err {
    margin: 6px 0 0;
    font-size: 12px;
    color: #8a3b2f;
  }
</style>
