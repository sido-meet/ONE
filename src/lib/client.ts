import type { ConversationRuntime } from '../../packages/contracts/src/index.ts';
import { createMockClient } from '../../packages/mock-runtime/src/index';
import { createCore } from '../../core/src/core';
import { createCoreClient, EMPTY_SNAPSHOT } from './core-link';
import type { CoreChannel, CoreClient } from './core-link';
import { installCapabilities } from './host';
import type { CapabilityHandler } from './host';
import {
  clientIdentity,
  inTauri,
  missingShellCommands,
  shell,
  tauriCoreChannel,
} from './tauri';
import type { ClientIdentity } from './tauri';
import { createMemoryCoreChannel } from './transport';
import { WIRE_VERSION } from '../../packages/contracts/src/wire';

/**
 * 唯一的装配点（ADR-013）。
 *
 * 界面从不自己造运行时：它拿到的 `client` 只是本体的一张视图。这里决定的是
 * 本体住在哪儿——桌面上是独立进程，浏览器预览里就在同一个进程——但对界面来说
 * 是同一件事：所有状态都从本体来，本地不留一份。
 */

/** 由 startClient 在任何视图挂载之前写入；视图只读这两个绑定。 */
export let client: ConversationRuntime = placeholderClient();
export let link: CoreClient = placeholderLink();
export let identity: ClientIdentity | null = null;

/**
 * 占位实现。领域能力（日历、笔记）**不在这里**：它们经本体调用提供方端口，
 * 不经过前端持有的会话运行时（ADR-016）。
 */
function placeholderClient(): ConversationRuntime {
  const unavailable = () => {
    throw new Error('客户端还没接上 ONE 本体');
  };
  return {
    getSnapshot: () => EMPTY_SNAPSHOT,
    subscribe: () => () => undefined,
    createConversation: unavailable,
    changeAgent: async () => undefined,
    sendMessage: unavailable,
    cancelRun: async () => undefined,
    dispose: () => undefined,
  };
}

function placeholderLink(): CoreClient {
  const noLink = () => {
    throw new Error('客户端还没接上 ONE 本体');
  };
  return {
    client: placeholderClient(),
    // 领域调用在本体没接上时同样要拒绝，不能返回空列表冒充「今天没有日程」。
    domains: {
      calendar: {
        list: noLink,
        create: noLink,
        update: noLink,
        remove: noLink,
      },
      notes: {
        list: noLink,
        create: noLink,
        update: noLink,
        remove: noLink,
      },
    },
    state: () => 'connecting',
    connection: () => null,
    subscribe: () => () => undefined,
    roster: () => ({ installed: [], connected: [] }),
    snapshot: () => EMPTY_SNAPSHOT,
    refusal: () => '',
    problem: () => '客户端还没接上 ONE 本体',
    listClients: noLink,
    launch: noLink,
    callCapability: noLink,
    expose: () => undefined,
    dispose: () => undefined,
  };
}

/** 这个客户端能被别的客户端调用的东西。名字必须和壳里声明的完全一致。 */
function capabilityHandlers(
  self: ClientIdentity,
): Record<string, CapabilityHandler> {
  const all = allCapabilityHandlers(self);
  // 只实现壳给这个窗口声明过的能力。对话条是宠物的另一块屏幕，它要状态不要
  // 能力：同一进程里两个窗口抢着回答同一个调用，胜负只取决于谁先回。
  return Object.fromEntries(
    Object.entries(all).filter(([name]) => self.capabilities.includes(name)),
  );
}

function allCapabilityHandlers(
  self: ClientIdentity,
): Record<string, CapabilityHandler> {
  const summary = () => {
    const snapshot = link.snapshot();
    return {
      window: self.window,
      kind: self.kind,
      conversations: snapshot.conversations.length,
      runningRuns: snapshot.runs.filter((run) => run.status === 'running')
        .length,
      coreVersion: link.connection()?.coreVersion ?? null,
    };
  };
  if (self.kind === 'pet') {
    return {
      'pet.state': summary,
      'pet.bubble.open': () => shell.openBubble(),
      'pet.show': () => shell.showPet(),
      'pet.hide': () => shell.hidePet(),
    };
  }
  return {
    'desktop.state': summary,
    'desktop.window.show': () => shell.openMain(),
    'desktop.window.hide': () => shell.hideMain(),
    'desktop.launch.pet': async () => {
      const { askClient, launchClient } = await import('./proxy-client');
      const running = link
        .roster()
        .connected.some((client) => client.kind === 'pet');
      return running
        ? askClient(link, 'pet', 'pet.show')
        : launchClient(link, 'pet');
    },
  };
}

function channelFor(self: ClientIdentity): CoreChannel {
  if (inTauri()) return tauriCoreChannel();
  // 浏览器预览：本体就在这个进程里，因此预览不会"看起来同步但其实各说各话"。
  return createMemoryCoreChannel({
    core: createCore(createMockClient(), {
      version: '浏览器预览',
      installed: ['pet', 'desktop'],
    }),
    hello: {
      t: 'hello',
      v: WIRE_VERSION,
      client: {
        kind: self.kind === 'pet' ? 'pet' : 'desktop',
        label: self.label,
        capabilities: self.capabilities,
      },
    },
    connection: {
      kind: self.kind,
      label: self.label,
      capabilities: self.capabilities,
      wireVersion: WIRE_VERSION,
      coreVersion: '浏览器预览',
    },
  });
}

/** Views must never mount before this resolves: `link` is the only state path. */
export async function startClient(): Promise<ClientIdentity> {
  const self = await clientIdentity();
  const started = createCoreClient(channelFor(self), {
    t: 'hello',
    v: WIRE_VERSION,
    client: {
      kind: self.kind === 'pet' ? 'pet' : 'desktop',
      label: self.label,
      capabilities: self.capabilities,
    },
  });
  identity = self;
  link = started;
  client = started.client;
  installCapabilities(started, self.capabilities, capabilityHandlers(self));
  if (import.meta.env.DEV) {
    void missingShellCommands().then((missing) => {
      if (missing.length)
        console.error(
          `[ONE] 壳未实现这些命令，相关按钮会静默失效：${missing.join(', ')}`,
        );
    });
  }
  if (import.meta.hot) {
    import.meta.hot.dispose(() => started.dispose());
  }
  return self;
}
