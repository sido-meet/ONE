import { emit, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { Transport } from './transport';

export const tauriTransport: Transport = {
  send(event, payload) {
    void emit(event, payload);
  },
  listen(event, handler) {
    let cancel: (() => void) | undefined;
    let cancelled = false;
    void listen(event, (received) => handler(received.payload)).then(
      (unlisten) => {
        if (cancelled) unlisten();
        else cancel = unlisten;
      },
    );
    return () => {
      cancelled = true;
      cancel?.();
    };
  },
};

/** Browser preview has no Tauri internals; the preview runs the host in-process. */
export const nullTransport: Transport = {
  send() {},
  listen: () => () => {},
};

export function currentWindowLabel(): string | null {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return null;
  }
}

/**
 * Window actions go through the trusted shell instead of the JS window API, so
 * the shell decides what a window may do instead of trusting the renderer.
 */
export const shell = {
  openMain: () => invoke('open_main'),
  openBubble: () => invoke('open_bubble'),
  hideBubble: () => invoke('hide_bubble'),
  hidePet: () => invoke('hide_pet'),
  showPet: () => invoke('show_pet'),
  popupPetMenu: () => invoke('popup_pet_menu'),
  startDrag: () => invoke('start_drag'),
  /** Keyboard equivalent of dragging, in logical pixels. */
  moveWindow: (dx: number, dy: number) => invoke('move_window', { dx, dy }),
  quit: () => invoke('quit_app'),
  /** Called by the host after it stopped what was running. */
  forceQuit: () => invoke('force_quit'),
};

/**
 * A renamed or missing shell command fails silently inside `void shell.x()`,
 * which is how a click did nothing at all. Ask the shell what it implements and
 * warn about any gap instead of shipping a dead button.
 */
export async function missingShellCommands(): Promise<string[]> {
  if (!('__TAURI_INTERNALS__' in window)) return [];
  try {
    const known = await invoke<string[]>('shell_commands');
    return Object.keys(shell).filter((name) => !known.includes(name));
  } catch {
    return [];
  }
}
