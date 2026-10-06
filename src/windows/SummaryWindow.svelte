<script lang="ts">
  import { onMount } from 'svelte';
  import { identity, link } from '../lib/client';
  import { shell } from '../lib/tauri';
  import {
    emptySummary,
    footerOf,
    headlineOf,
    invalidated,
    pageProviderFor,
    readDomain,
    rosterSignature,
    rowsOf,
    shouldRefetch,
    summaryCommandContext,
    todayRange,
  } from '../lib/summary';
  import type { Summary } from '../lib/summary';
  import type { DomainKind } from '../../packages/contracts/src/index.ts';

  /**
   * 宠物上方的摘要条（ADR-018）。
   *
   * 收起时是一句话加一行凭据，展开后是两块：日历与笔记。这一块是**宿主**画的
   * ——插件自带页面是插件的事，这里说「今天有什么」是宿主对用户的承诺，所以由宿主
   * 负责：说清楚数据从哪一版本体状态来、什么时候取的、以及取不到时为什么取不到。
   *
   * 取数经本体转发（ADR-016），界面不直接碰提供方，也不自己判断提供方在不在场。
   */

  let summary = $state<Summary>(emptySummary());
  // 展开与否由窗口高度决定，壳说了算。界面不自己记一份 —— 两份状态迟早走偏，
  // 而症状是「壳撑高了窗口，界面还画着收起的样子」，看起来像展开坏了。
  let expanded = $state(identity?.summaryExpanded ?? false);
  let busy = $state(false);
  let coreState = $state(link.state());
  let problem = $state(link.problem());

  const now = $derived(new Date());
  const rows = $derived(rowsOf(summary, now));
  const headline = $derived(headlineOf(summary, now));
  const footer = $derived(footerOf(summary, now));

  /** 本体没接上时那一句：由它派生，四处别各写一份。 */
  const offlineMessage = $derived(
    coreState === 'rejected'
      ? `ONE 本体拒绝了这个客户端：${link.refusal()}`
      : problem || 'ONE 本体没接上，摘要取不到数。',
  );
  const offCore = $derived(coreState === 'ready' ? '' : offlineMessage);

  /**
   * 取一次。日历与笔记各要各的：一边失败不该把另一边也抹掉。
   * 两次都换进 summary 时**整体替换**上一次的结果 —— 取不到就是取不到，
   * 不拿上一次的数据冒充今天（summary.withReading 的语义）。
   *
   * 页面入口取自**此刻的名册**，而不是上次取数的结果：插件刚掉线时按钮该跟着
   * 变灰，而不是继续指着一个开不起来的窗口。
   */
  async function refresh() {
    // 正在取的时候又来一次请求，**不能静默丢掉**。丢掉的话那次触发（比如插件
    // 刚掉线）就没了，界面上留着上一轮的数据配一句新消息 —— 看着像"今天还有
    // 日程，但源没连上"，那正是这条最不许出现的样子。改成记下来，取完再跑一次。
    if (busy) {
      queued = true;
      return;
    }
    const when = new Date();
    if (coreState !== 'ready') {
      summary = {
        ...emptySummary(when),
        revision: link.revision(),
        calendar: offlineReading('calendar', when),
        notes: offlineReading('notes', when),
      };
      return;
    }
    busy = true;
    const connected = link.roster().connected;
    const [calendar, notes] = await Promise.all([
      readDomain(
        'calendar',
        () =>
          link.domains.calendar.list(summaryCommandContext(link.snapshot()), {
            ...todayRange(when),
            limit: 20,
          }),
        { pageProvider: pageProviderFor(connected, 'calendar')?.provider },
      ),
      readDomain(
        'notes',
        () =>
          link.domains.notes.list(summaryCommandContext(link.snapshot()), {
            limit: 20,
          }),
        { pageProvider: pageProviderFor(connected, 'notes')?.provider },
      ),
    ]);
    busy = false;
    const base = {
      revision: link.revision(),
      fetchedAt: when,
    };
    summary = { ...base, calendar, notes };
    // 刚才被挡下的那一次不能白等：接着跑，用户看到的就是最新的一次结果。
    if (queued) {
      queued = false;
      await refresh();
    }
  }

  /** 取数途中又有人要取：记下来，取完接着跑，而不是丢掉这次意图。 */
  let queued = false;

  function offlineReading(kind: DomainKind, when: Date) {
    return {
      line: { kind, status: 'offline' as const, message: offlineMessage },
      fetchedAt: when,
    };
  }

  /**
   * 正在取的那一小会儿什么都不说 —— 语义与措辞都归 summary.ts，那里有测试钉住。
   */

  function toggle() {
    expanded = !expanded;
    void shell.resizeSummary(expanded).catch(() => {
      // 窗口没变高也是一种失败：面板会看不见，用户只会以为点坏了。
      expanded = !expanded;
    });
  }

  async function openPage(provider: string | undefined) {
    if (!provider) return;
    try {
      await shell.openPluginPage(provider);
    } catch {
      // 入口开着却开不出来要说出来，不能安静地什么都不发生。
      problem = `${provider} 的页面打不开`;
    }
  }

  /**
   * 什么时候该重新取数，取决于两件事：本体接上了没有、名册变没变。
   *
   * 两条都要**跟着订阅走**而不是在挂载时拍一次快照。窗口往往比本体连上更早建起来
   * （实机踩到：摘要条一直写着「ONE 本体没接上」，而本体明明是通的 —— 与
   * PluginWindow 当初那个坑同源）；名册里的插件起来了或掉了，那句话同样立刻过时。
   * 判据本身在 summary.ts，由那里的测试钉住。
   */
  onMount(() => {
    let fetched = false;
    let wasReady = link.state() === 'ready';
    const stop = link.subscribe(() => {
      const ready = link.state() === 'ready';
      const signature = rosterSignature(link.roster());
      if (
        shouldRefetch({
          fetched,
          wasReady,
          ready,
          lastSignature: stampOf,
          signature,
        })
      ) {
        // 名册变了 = 上一次取到的数已经不算数了。**先作废再重取**：留着它等新的
        // 回来，中间那几百毫秒里界面上是「插件没连上」配着上一轮的日程明细 ——
        // 那正是「拿旧缓存冒充今天」（实机抓到的就是这个样子）。
        if (stampOf !== null && signature !== stampOf) {
          summary = invalidated(summary);
        }
        fetched = true;
        void refresh();
      }
      wasReady = ready;
      coreState = link.state();
      problem = link.problem();
      stampOf = signature;
    });
    fetched = true;
    void refresh();
    stampOf = rosterSignature(link.roster());
    return stop;
  });

  /** 上一次取数时看到的名册。变了就该重取。 */
  let stampOf: string | null = null;
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      void shell.hideSummary();
    }
  }}
/>

<div class="strip">
  <div class="card">
    <p class="head" aria-live="polite">
      <span class="text">{offCore || headline}</span>
      <button
        type="button"
        class="toggle"
        aria-expanded={expanded}
        aria-label={expanded ? '收起摘要' : '展开摘要'}
        title={expanded ? '收起' : '展开'}
        onclick={toggle}
      >
        {expanded ? '▾' : '▸'}
      </button>
      <button
        type="button"
        class="close"
        aria-label="关闭摘要"
        title="关闭（Esc）"
        onclick={() => void shell.hideSummary()}
      >
        ✕
      </button>
    </p>

    {#if expanded}
      <div class="panel">
        {#if offCore}
          <p class="absent" role="alert">{offCore}</p>
        {/if}
        {#each rows as row (row.kind)}
          <section class="row" class:absent={row.status !== 'ready'}>
            <p class="row-head">
              <span class="label">{row.label}</span>
              <span class="message" class:warn={row.status !== 'ready'}
                >{row.message}</span
              >
            </p>
            {#if row.hint}
              <p class="hint">{row.hint}</p>
            {/if}
            {#if row.items.length}
              <ul class="items">
                {#each row.items as item (item)}
                  <li>{item}</li>
                {/each}
              </ul>
              {#if row.more > 0}
                <p class="more">还有 {row.more} 条</p>
              {/if}
            {/if}
            <button
              type="button"
              class="page"
              disabled={!row.pageProvider}
              onclick={() => void openPage(row.pageProvider)}
            >
              {row.pageProvider
                ? `打开${row.label}页面`
                : `${row.label}页面现在开不了`}
            </button>
          </section>
        {/each}
      </div>
    {/if}

    <p class="foot">
      <button
        type="button"
        class="refresh"
        disabled={busy}
        onclick={() => void refresh()}
      >
        {busy ? '取数中' : '刷新'}
      </button>
      <span class="cred">{footer}</span>
    </p>
  </div>
  <button
    type="button"
    class="grip"
    aria-label="移动摘要条：拖动，或用方向键移动"
    title="拖动移动"
    onmousedown={() => void shell.startDrag()}
  ></button>
</div>

<style>
  :global(html:root),
  :global(body) {
    background: transparent;
    overflow: hidden;
  }
  .strip {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    padding: 8px 10px 6px;
  }
  .card {
    display: flex;
    flex-direction: column;
    padding: 8px 10px;
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: 0 6px 18px rgba(48, 59, 53, 0.12);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: 13px;
    line-height: 1.4;
  }
  .text {
    flex: 1;
    min-width: 0;
    /* 摘要是浮条不是列表页：长了截断，别把窗口撑得比宠物还宽。 */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #3a453d;
  }
  .toggle,
  .close {
    flex-shrink: 0;
    padding: 0 4px;
    border: none;
    background: transparent;
    color: var(--muted);
    font-size: 12px;
    line-height: 1;
  }
  .panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--line);
  }
  .absent {
    margin: 0;
    font-size: 12px;
    line-height: 1.6;
    color: #8a3b2f;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .row-head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin: 0;
    font-size: 12px;
  }
  .label {
    flex-shrink: 0;
    color: var(--accent);
    font-weight: 600;
  }
  .message {
    min-width: 0;
    color: #4a544d;
    overflow-wrap: anywhere;
  }
  .message.warn {
    color: #8a3b2f;
  }
  .hint {
    margin: 0;
    font-size: 11px;
    line-height: 1.5;
    color: var(--muted);
  }
  .items {
    margin: 2px 0 0;
    padding-left: 16px;
    font-size: 12px;
    line-height: 1.7;
    color: #4a544d;
  }
  .items li {
    overflow-wrap: anywhere;
  }
  .more {
    margin: 0;
    font-size: 11px;
    color: var(--muted);
  }
  .page {
    align-self: flex-start;
    margin-top: 3px;
    padding: 3px 9px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 11px;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 0 0;
    font-size: 10px;
    color: var(--muted);
  }
  .refresh {
    padding: 2px 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 10px;
  }
  .cred {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .grip {
    align-self: center;
    width: 40px;
    height: 8px;
    padding: 0;
    border: none;
    border-radius: 4px;
    cursor: grab;
    background: repeating-linear-gradient(
      90deg,
      rgba(64, 103, 71, 0.35) 0 4px,
      transparent 4px 8px
    );
  }
</style>
