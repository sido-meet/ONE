import { describe, expect, it, vi } from 'vitest';

/**
 * 壳桥的接线顺序（ADR-013）。
 *
 * `listen` 是异步的，窗口又可能比本体晚创建。监听没注册就问状态，会漏掉那一次
 * welcome，界面永远停在"正在连接" —— 而本体明明是通的。实机踩到过：插件页面
 * 窗口永远显示「ONE 本体未连接」。
 */

const handlers = new Map<string, (event: { payload: unknown }) => void>();
const calls: string[] = [];

vi.mock('@tauri-apps/api/event', () => ({
  // 比 invoke 慢一拍：真实 Tauri 的监听注册要过一次异步通道。
  listen: (name: string, handler: (event: { payload: unknown }) => void) =>
    new Promise<void>((resolve) => {
      setTimeout(() => {
        handlers.set(name, handler);
        calls.push(`listen:${name}`);
        resolve();
      }, 0);
    }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (name: string) => {
    calls.push(`invoke:${name}`);
    return Promise.resolve({
      connected: true,
      role: 'pet',
      provider: 'pet',
      label: 'ONE 宠物',
      capabilities: [],
      wireVersion: 3,
      coreVersion: 'test',
    });
  },
}));

const { tauriCoreChannel } = await import('./tauri');

describe('壳桥的注册顺序', () => {
  it('先把监听到位，再去问状态', async () => {
    handlers.clear();
    calls.length = 0;
    const channel = tauriCoreChannel();
    const lines: string[] = [];
    channel.onFrame((line) => lines.push(line));

    const status = await channel.connection();

    expect(status.connected).toBe(true);
    // 顺序：两个监听都在问状态之前注册好了。
    expect(calls.indexOf('listen:core:message')).toBeLessThan(
      calls.indexOf('invoke:core_status'),
    );
    expect(calls.indexOf('listen:core:status')).toBeLessThan(
      calls.indexOf('invoke:core_status'),
    );
    // 于是此刻进来的帧不会被漏掉：welcome 正是靠它把界面从"正在连接"带走。
    handlers.get('core:message')?.({ payload: '{"t":"welcome"}' });
    expect(lines).toEqual(['{"t":"welcome"}']);
  });

  it('退订之后不再收到帧', async () => {
    handlers.clear();
    const channel = tauriCoreChannel();
    const lines: string[] = [];
    const stop = channel.onFrame((line) => lines.push(line));
    await channel.connection();

    stop();
    handlers.get('core:message')?.({ payload: '{"t":"welcome"}' });
    expect(lines).toEqual([]);
  });
});
