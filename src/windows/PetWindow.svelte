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
  /** State is shown as text as well as shape: colour alone is not enough. */
  const mood = $derived(
    running ? 'working' : failed ? 'error' : hovering ? 'hover' : 'idle',
  );
  const caption = $derived(captions[mood]);

  onMount(() =>
    client.subscribe(() => {
      snapshot = client.getSnapshot();
    }),
  );
</script>

<div
  class="pet"
  class:working={mood === 'working'}
  class:error={mood === 'error'}
>
  <button
    class="figure"
    aria-label="打开 ONE 小聊天框"
    onclick={() => void shell.openBubble()}
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
    class="handle"
    aria-label="拖动移动宠物"
    title="拖动移动"
    onmousedown={() => void shell.startDrag()}
  ></button>
</div>

<style>
  :global(body) {
    background: transparent;
  }
  .pet {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    width: 100%;
    height: 100%;
    padding-bottom: 6px;
  }
  .figure {
    position: relative;
    width: 96px;
    height: 96px;
    border: none;
    background: transparent;
    padding: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
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
    background: rgba(247, 247, 242, 0.92);
    border-radius: 8px;
    padding: 1px 6px;
  }
  .working .body {
    background: #e7efe0;
  }
  .error .body {
    border-color: #a3452f;
    background: #f7e6e2;
  }
  .error .caption {
    color: #8a3b2f;
  }
  .handle {
    width: 64px;
    height: 14px;
    margin-top: 2px;
    border: none;
    border-radius: 8px;
    background: repeating-linear-gradient(
      90deg,
      rgba(64, 103, 71, 0.35) 0 6px,
      transparent 6px 12px
    );
    cursor: grab;
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
