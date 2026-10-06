<script lang="ts">
  import { onMount } from 'svelte';
  import { client } from '../lib/client';
  import { shell } from '../lib/tauri';

  let snapshot = $state(client.getSnapshot());
  let hovering = $state(false);

  const running = $derived(
    snapshot.runs.some((run) => run.status === 'running'),
  );
  const failed = $derived(snapshot.runs.some((run) => run.status === 'failed'));
  const captions = {
    working: '回复中',
    error: '需要重试',
    hover: 'ONE 在这里',
    idle: 'ONE',
  } as const;
  /** A failed shell call must be visible; a dead button looks like a broken app. */
  let failure = $state('');
  const mood = $derived(
    failure
      ? 'failure'
      : running
        ? 'working'
        : failed
          ? 'error'
          : hovering
            ? 'hover'
            : 'idle',
  );
  const caption = $derived(
    failure || captions[mood === 'failure' ? 'idle' : mood],
  );

  async function open() {
    failure = '';
    try {
      await shell.openBubble();
    } catch {
      failure = '小聊天框打不开';
    }
  }

  onMount(() =>
    client.subscribe(() => {
      snapshot = client.getSnapshot();
    }),
  );

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
    class:error={mood === 'error' || mood === 'failure'}
    aria-label="打开 ONE 小聊天框"
    title="单击打开小聊天框"
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
    gap: 4px;
    width: 100%;
    height: 100%;
  }
  /* A strip under the figure: dragging never overlaps the clickable circle. */
  .pad {
    width: 84px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 9px;
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
  .figure {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    width: 96px;
    height: 94px;
    padding: 0;
    border: none;
    background: transparent;
    cursor: pointer;
  }
  .body {
    width: 56px;
    height: 56px;
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
  .face {
    display: flex;
    gap: 10px;
    margin-top: -34px;
  }
  .eye {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #303b35;
  }
  .caption {
    font-size: 12px;
    color: #303b35;
    text-shadow:
      0 1px 2px rgba(247, 247, 242, 0.9),
      0 0 4px rgba(247, 247, 242, 0.8);
  }
  .figure.error .caption {
    color: #8a3b2f;
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
