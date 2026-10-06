import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { CAPABILITY } from '../../packages/contracts/src/wire.ts';
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

/**
 * 浏览器预览下各视图申报的能力。名字必须与 contracts 的 CAPABILITY 一致，
 * 也必须与壳（Rust）声明的一致，否则别的参与者调用时会静默失败。
 */
const PET_CAPABILITIES = [
  CAPABILITY.stateSummary,
  CAPABILITY.bubbleOpen,
  CAPABILITY.windowShow,
  CAPABILITY.windowHide,
];
const DESKTOP_CAPABILITIES = [
  CAPABILITY.stateSummary,
  CAPABILITY.windowShow,
  CAPABILITY.windowHide,
  CAPABILITY.clientLaunch,
];

export interface ClientIdentity {
  /** 呈现角色，纯标签（ADR-017）：pet / desktop。 */
  role: string;
  /** 寻址键，界面向本体要数据时用它被找到。 */
  provider: string;
  label: string;
  window: string;
  capabilities: string[];
  wireVersion: number;
  /**
   * 这个窗口是不是这个客户端的主窗口。一根管道只有一次握手（ADR-013），
   * 只有主窗口握手；只读窗口向壳要重放，否则它会永远停在「正在连接」。
   */
  windowRole: 'primary' | 'view';
  /**
   * 这个窗口承载的是哪个插件的页面（ADR-018）。由壳的绑定表给出 —— 窗口与提供方
   * 一一绑定，页面自己说了不算，也没法说。
   */
  pluginProvider: string | null;
  /**
   * 插件页面在 iframe 里要写的前缀，由壳按平台给出。Windows 上必须用 wry 改写
   * 后的 `http://one-plugin.localhost`：iframe 的资源请求匹配不上原地址，
   * 页面会安静地什么都不显示（ADR-018）。
   */
  pluginPageBase: string;
  /**
   * 摘要条现在是展开还是收起。**由窗口高度决定**，界面照着它初始化 ——
   * 高度是壳唯一说了算的东西，界面不再自己记一份（实机踩到：壳把窗口撑高了，
   * 界面却还画着收起的样子，看起来就像「展开失效了」）。
   */
  summaryExpanded: boolean;
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
  /** 插件页面窗口与提供方一一绑定，这里交出去的是寻址键，不是页面给的地址。 */
  openPluginPage: (provider: string) =>
    invoke('open_plugin_page', { provider }),
  closePluginWindow: () => invoke('close_plugin_window'),
  /** 展开/收起摘要面板。窗口高度只有壳知道怎么改，界面只说意图。 */
  resizeSummary: (expanded: boolean) => invoke('resize_summary', { expanded }),
  hideSummary: () => invoke('hide_summary'),
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
    role: typeof record.role === 'string' ? record.role : 'unknown',
    provider: typeof record.provider === 'string' ? record.provider : 'unknown',
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
 *
 * **监听必须先注册上，再去问状态**。`listen` 是异步的，而窗口可能在本体早就连上
 * 之后才创建（对话条、插件页面窗口）：先问状态会立刻拿到"已连接"，握手随之
 * 发出去，回执却比监听注册得更快，于是那一次 welcome 被漏掉，界面永远停在
 * "正在连接"。顺序反过来就没有这个窗口（实机踩到：插件页面窗口永远显示
 * 「本体未连接」，而本体明明是通的）。
 */
export function tauriCoreChannel(): CoreChannel {
  const frameListeners = new Set<(line: string) => void>();
  const statusListeners = new Set<(status: CoreConnection) => void>();

  const framesReady = listen<string>('core:message', (event) => {
    for (const listener of frameListeners) listener(event.payload);
  });
  const statusReady = listen<unknown>('core:status', (event) => {
    const status = toConnection(event.payload);
    for (const listener of statusListeners) listener(status);
  });

  return {
    async connection() {
      // 先等监听到位，再问状态：这一刻之后进来的帧一个都不会漏。
      await framesReady;
      await statusReady;
      return toConnection(await invoke('core_status'));
    },
    async send(frame: ClientMessage) {
      await invoke('core_send', { frame });
    },
    /** 只读窗口没有自己的握手，靠壳把本体最近几帧重放给自己。 */
    async replay() {
      await invoke('core_replay');
    },
    onFrame(handler) {
      frameListeners.add(handler);
      return () => {
        frameListeners.delete(handler);
      };
    },
    onStatus(handler) {
      statusListeners.add(handler);
      return () => {
        statusListeners.delete(handler);
      };
    },
  };
}

export async function clientIdentity(): Promise<ClientIdentity> {
  if (!inTauri()) {
    // 浏览器预览没有壳：用查询串挑一个视图，并如实说明它不是真客户端。
    const requested = new URLSearchParams(location.search).get('client');
    const pet = requested === 'pet';
    return {
      role: pet ? 'pet' : 'desktop',
      provider: pet ? 'pet' : 'desktop',
      label: pet ? 'ONE 宠物（浏览器预览）' : 'ONE 桌面端（浏览器预览）',
      window: pet ? 'pet' : 'main',
      capabilities: pet ? PET_CAPABILITIES : DESKTOP_CAPABILITIES,
      wireVersion: 0,
      // 浏览器预览里每个窗口各有一套本体，握手不受管道限制。
      windowRole: 'primary',
      // 浏览器预览里没有插件协议的宿主方，插件页面在预览里打不开，如实说没有。
      pluginProvider: null,
      pluginPageBase: 'one-plugin://localhost',
      summaryExpanded: false,
    };
  }
  const value = await invoke<unknown>('client_identity');
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    role: typeof record.role === 'string' ? record.role : 'unknown',
    provider: typeof record.provider === 'string' ? record.provider : 'unknown',
    label: typeof record.label === 'string' ? record.label : '未知客户端',
    window: typeof record.window === 'string' ? record.window : 'main',
    capabilities: Array.isArray(record.capabilities)
      ? record.capabilities.filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
    wireVersion:
      typeof record.wireVersion === 'number' ? record.wireVersion : 0,
    windowRole: record.windowRole === 'view' ? 'view' : 'primary',
    pluginProvider:
      typeof record.pluginProvider === 'string' ? record.pluginProvider : null,
    pluginPageBase:
      typeof record.pluginPageBase === 'string'
        ? record.pluginPageBase
        : 'one-plugin://localhost',
    summaryExpanded: record.summaryExpanded === true,
  };
}

/** 退出前先请界面停掉正在跑的 Run，壳另有一个 3 秒兜底，不会卡住。 */
export async function listenBeforeQuit(
  handler: () => void,
): Promise<() => void> {
  const unlisten = await listen(BEFORE_QUIT, () => handler());
  return unlisten;
}
