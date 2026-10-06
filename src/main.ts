import { mount } from 'svelte';
import MainWindow from './windows/MainWindow.svelte';
import PetWindow from './windows/PetWindow.svelte';
import BubbleWindow from './windows/BubbleWindow.svelte';
import { startClient } from './lib/client';
import './app.css';

/**
 * One bundle, every client. Which view mounts is decided by the shell, not by
 * the URL: the pet and the desktop load the very same page. Nothing mounts
 * before `startClient` resolves, because `link` is the only path to any state.
 *
 * 启动失败必须看得见。一个什么都没有的白窗口会让人以为是"ONE 坏了"，
 * 而不是"这一步没走通"，而 128 宽的窗口里一行字就够定位了。
 */
const fail = (cause: unknown) => {
  const target = document.getElementById('app');
  if (!target) return;
  const message = cause instanceof Error ? cause.message : String(cause);
  target.textContent = `ONE 启动失败：${message}`;
  target.setAttribute('role', 'alert');
};

window.addEventListener('error', (event) => fail(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => fail(event.reason));

void startClient()
  .then((self) => {
    const View =
      self.window === 'pet'
        ? PetWindow
        : self.window === 'bubble'
          ? BubbleWindow
          : MainWindow;
    const target = document.getElementById('app');
    if (!target) throw new Error('Missing app root');
    mount(View, { target });
  })
  .catch(fail);
