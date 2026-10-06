<script lang="ts">
  import { identity, link } from '../lib/client';
  import { attachPluginPage } from '../lib/page-bridge';
  import { shell } from '../lib/tauri';
  import { pluginPageUrl } from '../../packages/contracts/src/page';

  /**
   * 一个插件页面 = 一个窗口（ADR-018）。这个窗口是谁的由壳决定（`pluginProvider`），
   * 页面自己说了不算，也没法说 —— 它跑在不透明来源里，连自己从哪儿加载的都读不到。
   *
   * 宿主的活儿只有三件：把页面放进沙箱 iframe、把它的请求转给本体、以及在插件
   * 不在场时**说清楚**而不是留一块空白。界面长什么样归插件。
   */
  let frameElement = $state<HTMLIFrameElement | null>(null);
  /** 换一次 key 就重建 iframe 与桥：插件刚才掉线又回来时，这是唯一的重试办法。 */
  let attempt = $state(0);
  // 状态要**跟着订阅**走，不能只在挂载那一刻拍一张快照：窗口往往比本体连上更早
  // 建起来，拍快照的话这个窗口会一辈子停在「本体未连接」，页面永远不加载
  // （实机踩到：窗口开着，iframe 从来没加载过）。
  let coreState = $state(link.state());
  let roster = $state(link.roster());
  let problem = $state(link.problem());
  $effect(() =>
    link.subscribe(() => {
      coreState = link.state();
      roster = link.roster();
      problem = link.problem();
    }),
  );

  const provider = identity?.pluginProvider ?? null;
  const found = $derived(
    provider
      ? roster.connected.find((item) => item.provider === provider)
      : undefined,
  );
  /** 见过的名字要留着：插件掉线后名册里就没有它了，报错时总得叫得出是谁。 */
  let seenLabel = $state<string | null>(null);
  $effect(() => {
    if (found?.label) seenLabel = found.label;
  });

  const entry = $derived(found?.view?.entry ?? null);
  const label = $derived(found?.label ?? seenLabel ?? provider ?? '插件');

  /**
   * 三种缺席要说三句不同的话。没连接、连着但没有页面、根本没在名册里，是三件事，
   * 而界面上看起来都像"这个窗口是空的"。
   */
  const absence = $derived.by(() => {
    if (!provider) return '这个窗口没有绑定任何插件。';
    if (coreState === 'rejected')
      return `ONE 本体拒绝了这个客户端：${link.refusal()}`;
    if (coreState !== 'ready')
      return problem || 'ONE 本体未连接，插件页面打不开。';
    if (!roster.connected.some((item) => item.provider === provider))
      return `${label}没有连上，它的页面现在读不出来。`;
    if (!entry) return `${label}没有自带页面。`;
    return '';
  });

  $effect(() => {
    const element = frameElement;
    if (!element) return;
    // 桥认的是 iframe 这一个句柄：别的窗口发来的消息它一律不理。
    const bridge = attachPluginPage({
      link,
      provider: provider ?? '',
      frame: element,
    });
    return () => bridge.dispose();
  });

  const retry = () => {
    attempt += 1;
  };
</script>

<div class="host">
  <header>
    <span class="title">{label}页面</span>
    <span class="spacer"></span>
    <button type="button" onclick={retry}>重试</button>
    <button
      type="button"
      class="close"
      onclick={() => void shell.closePluginWindow()}
    >
      关闭
    </button>
  </header>

  {#if absence}
    <p class="absent" role="alert">{absence}</p>
  {:else if provider && entry}
    <!--
      沙箱只给脚本。**不给** same-origin：给了，页面就与宿主同源，能读父页面、
      能拿到宿主上下文，那道隔离等于没做（ADR-018）。窗口与提供方的绑定在壳那边，
      页面既不需要知道，也无法知道。
    -->
    {#key attempt}
      <iframe
        bind:this={frameElement}
        title="{label}页面"
        src={pluginPageUrl(identity?.pluginPageBase ?? '', provider, entry)}
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
      ></iframe>
    {/key}
  {/if}
</div>

<style>
  .host {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--bg, #fff);
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px 6px 12px;
    border-bottom: 1px solid var(--line, #e2e6e2);
  }
  .title {
    font-size: 12px;
    font-weight: 600;
  }
  .spacer {
    flex: 1;
  }
  button {
    padding: 3px 10px;
    border: 1px solid var(--line, #e2e6e2);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  button:hover {
    background: rgba(64, 103, 71, 0.08);
  }
  iframe {
    flex: 1;
    width: 100%;
    border: 0;
  }
  .absent {
    margin: 0;
    padding: 16px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--muted, #5c665f);
  }
</style>
