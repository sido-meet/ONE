import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import type { ClientMessage } from '../../packages/contracts/src/wire.ts';
import type { CoreChannel, CoreConnection } from './core-link';

/**
 * WebView 与壳之间唯一的边界（ADR-013）。
 *
 * 渲染进程拿不到套接字，也起不了进程：所有窗口动作和通往本体的路都在这里，
 * 由壳决定允许什么。改名或漏掉的命令会静默失败，所以启动时还要向壳核对一次
 * 自己用到的命令清单。
 */

/** 壳在退出前请界面先停掉正在跑的 Run。 */
export const BEFORE_QUIT = 'one:before-quit';

export interface ClientIdentity {
  kind: string;
  label: string;
  window: string;
  capabilities: string[];
  wireVersion: number;
}

export function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Window actions go through the trusted shell instead of the JS window API, so
 * the shell decides what a window may do instead of trusting the renderer.
 */
export const shell = {
  openMain: () => invoke('open_main'),
  openBubble: () => invoke('open_bubble'),
  hideBubble: () => invoke('hide_bubble'),
  hideMain: () => invoke('hide_main'),
  hidePet: () => invoke('hide_pet'),
  showPet: () => invoke('show_pet'),
  popupPetMenu: () => invoke('popup_pet_menu'),
  startDrag: () => invoke('start_drag'),
  /** Keyboard equivalent of dragging, in logical pixels. */
  moveWindow: (dx: number, dy: number) => invoke('move_window', { dx, dy }),
  quit: () => invoke('quit_app'),
  /** Called by the shell after the view stopped what was running. */
  forceQuit: () => invoke('force_quit'),
};

type ShellCommand = (...args: never[]) => Promise<unknown>;
const SHELL_COMMANDS: Record<string, ShellCommand> = shell;

/**
 * A renamed or missing shell command fails silently inside `void shell.x()`,
 * which is how a click did nothing at all. Ask the shell what it implements and
 * warn about any gap instead of shipping a dead button.
 */
export async function missingShellCommands(): Promise<string[]> {
  if (!inTauri()) return [];
  try {
    const known = await invoke<string[]>('shell_commands');
    return Object.keys(SHELL_COMMANDS).filter((name) => !known.includes(name));
  } catch {
    return [];
  }
}

function toConnection(value: unknown): CoreConnection {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    connected: record.connected === true,
    kind: typeof record.kind === 'string' ? record.kind : 'unknown',
    label: typeof record.label === 'string' ? record.label : '未知客户端',
    capabilities: Array.isArray(record.capabilities)
      ? record.capabilities.filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
    wireVersion:
      typeof record.wireVersion === 'number' ? record.wireVersion : 0,
    coreVersion:
      typeof record.coreVersion === 'string' ? record.coreVersion : null,
  };
}

/**
 * 壳是管道与 WebView 之间唯一的桥：它把本体的每一行原样转过来，也把界面
 * 的每一帧原样送过去。界面看不到套接字。
 */
export function tauriCoreChannel(): CoreChannel {
  return {
    async connection() {
      return toConnection(await invoke('core_status'));
    },
    async send(frame: ClientMessage) {
      await invoke('core_send', { frame });
    },
    onFrame(handler) {
      let cancel: (() => void) | undefined;
      let cancelled = false;
      void listen<string>('core:message', (event) =>
        handler(event.payload),
      ).then((unlisten) => {
        if (cancelled) unlisten();
        else cancel = unlisten;
      });
      return () => {
        cancelled = true;
        cancel?.();
      };
    },
    onStatus(handler) {
      let cancel: (() => void) | undefined;
      let cancelled = false;
      void listen<unknown>('core:status', (event) =>
        handler(toConnection(event.payload)),
      ).then((unlisten) => {
        if (cancelled) unlisten();
        else cancel = unlisten;
      });
      return () => {
        cancelled = true;
        cancel?.();
      };
    },
  };
}

export async function clientIdentity(): Promise<ClientIdentity> {
  if (!inTauri()) {
    // 浏览器预览没有壳：用查询串挑一个视图，并如实说明它不是真客户端。
    const kind = new URLSearchParams(location.search).get('client');
    const pet = kind === 'pet';
    return {
      kind: pet ? 'pet' : 'desktop',
      label: pet ? 'ONE 宠物（浏览器预览）' : 'ONE 桌面端（浏览器预览）',
      window: pet ? 'pet' : 'main',
      capabilities: pet
        ? ['pet.state', 'pet.bubble.open', 'pet.show', 'pet.hide']
        : [
            'desktop.state',
            'desktop.window.show',
            'desktop.window.hide',
            'desktop.launch.pet',
          ],
      wireVersion: 0,
    };
  }
  const value = await invoke<unknown>('client_identity');
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    kind: typeof record.kind === 'string' ? record.kind : 'unknown',
    label: typeof record.label === 'string' ? record.label : '未知客户端',
    window: typeof record.window === 'string' ? record.window : 'main',
    capabilities: Array.isArray(record.capabilities)
      ? record.capabilities.filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
    wireVersion:
      typeof record.wireVersion === 'number' ? record.wireVersion : 0,
  };
}

/** 退出前先请界面停掉正在跑的 Run，壳另有一个 3 秒兜底，不会卡住。 */
export async function listenBeforeQuit(
  handler: () => void,
): Promise<() => void> {
  const unlisten = await listen(BEFORE_QUIT, () => handler());
  return unlisten;
}
