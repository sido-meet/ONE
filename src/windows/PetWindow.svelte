<script lang="ts">
  import { onMount } from 'svelte';
  import { client, link } from '../lib/client';
  import { shell } from '../lib/tauri';

  let snapshot = $state(client.getSnapshot());
  let hovering = $state(false);
  /** 任何一次壳调用失败都要说出口：点了没反应看起来就像坏了。 */
  let failure = $state('');
  let coreState = $state(link.state());

  type Mood = 'idle' | 'hover' | 'working' | 'error' | 'offline';
  const running = $derived(
    snapshot.runs.some((run) => run.status === 'running'),
  );
  const failed = $derived(snapshot.runs.some((run) => run.status === 'failed'));
  const mood = $derived<Mood>(
    failure
      ? 'error'
      : coreState === 'ready'
        ? running
          ? 'working'
          : failed
            ? 'error'
            : hovering
              ? 'hover'
              : 'idle'
        : 'offline',
  );
  /** 128 宽的窗口只放得下一行，句子要短。 */
  const caption = $derived(
    failure ||
      (mood === 'offline'
        ? link.problem() || '本体未连接'
        : mood === 'working'
          ? '正在思考'
          : mood === 'error'
            ? '需要重试'
            : mood === 'hover'
              ? 'ONE 在这里'
              : 'ONE'),
  );
  /** 128 宽的窗口只放得下一行，句子要短。 */
  const label = $derived(
    mood === 'offline' ? 'ONE 本体没有连接，点击重试' : '打开 ONE 对话条',
  );

  async function open() {
    failure = '';
    if (coreState !== 'ready') {
      // 没有本体就没有对话可显示，弹一条空壳只会让人以为坏了。
      failure = 'ONE 本体未连接';
      return;
    }
    try {
      await shell.openBubble();
    } catch {
      failure = '小聊天框打不开';
    }
  }

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

  /** Arrow keys move the window so the pet is reachable without a mouse. */
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

<!-- The strip drags the window; the figure is a separate click target, never overlapped. -->
<div class="pet">
  <button
    class="figure"
    class:working={mood === 'working'}
    class:error={mood === 'error'}
    class:offline={mood === 'offline'}
    aria-label={label}
    title={label}
    onclick={() => void open()}
    oncontextmenu={(event) => {
      event.preventDefault();
      void shell.popupPetMenu();
    }}
    onpointerenter={() => (hovering = true)}
    onpointerleave={() => (hovering = false)}
  >
    <span class="body" class:active={mood === 'hover' || mood === 'working'}
    ></span>
    <span class="face" aria-hidden="true"
      ><span class="eye"></span><span class="eye"></span></span
    >
    <span class="caption">{caption}</span>
  </button>
  <button
    class="pad"
    aria-label="移动宠物：拖动这条，或用方向键移动（按住 Shift 微调）"
    title="拖动移动"
    onmousedown={() => void shell.startDrag()}
    onkeydown={move}
  ></button>
</div>

<style>
  /* app.css paints :root, so a transparent window needs matching specificity. */
  :global(html:root),
  :global(body) {
    background: transparent;
  }
  .pet {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    width: 100%;
    height: 100%;
  }
  /* A strip under the figure: dragging never overlaps the clickable circle. */
  .pad {
    width: 84px;
    height: 16px;
    padding: 0;
    border: none;
    border-radius: 8px;
    cursor: grab;
    background: repeating-linear-gradient(
      90deg,
      rgba(64, 103, 71, 0.45) 0 6px,
      transparent 6px 12px
    );
  }
  .pad:active {
    cursor: grabbing;
  }
  .pad:focus-visible {
    outline: 2px solid #688858;
    outline-offset: 2px;
  }
  .figure {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    width: 104px;
    height: 78px;
    padding: 0;
    border: none;
    background: transparent;
    cursor: pointer;
  }
  .figure:focus-visible {
    outline: 2px solid #688858;
    outline-offset: -2px;
    border-radius: 14px;
  }
  .body {
    width: 48px;
    height: 48px;
    border-radius: 50% 50% 46% 46%;
    background: #dfe6d6;
    border: 2px solid #416747;
    transition: transform 120ms ease;
  }
  .body.active {
    animation: breathe 1.6s ease-in-out infinite;
  }
  .figure.working .body {
    background: #e7efe0;
  }
  .figure.error .body {
    border-color: #a3452f;
    background: #f7e6e2;
  }
  /* 本体没接上时要一眼看得出来，而不是一只看起来很闲的宠物。 */
  .figure.offline .body {
    border-color: #8b918a;
    border-style: dashed;
    background: #eceee9;
  }
  .face {
    display: flex;
    gap: 9px;
    margin-top: -30px;
  }
  .figure.offline .eye {
    background: #7c837c;
  }
  .eye {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #303b35;
  }
  .caption {
    max-width: 104px;
    font-size: 11px;
    line-height: 1.3;
    text-align: center;
    color: #303b35;
    text-shadow:
      0 1px 2px rgba(247, 247, 242, 0.9),
      0 0 4px rgba(247, 247, 242, 0.8);
  }
  .figure.error .caption {
    color: #8a3b2f;
  }
  .figure.offline .caption {
    color: #5d645d;
  }
  @keyframes breathe {
    0%,
    100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.06);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .body.active {
      animation: none;
    }
  }
</style>
