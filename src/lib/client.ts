import type { OneClient } from '../../packages/contracts/src';
import { createMockClient } from '../../packages/mock-runtime/src';
import { createHostClient } from './host';
import { createProxyClient } from './proxy-client';
import type { ServiceState } from './proxy-client';
import {
  currentWindowLabel,
  missingShellCommands,
  nullTransport,
  tauriTransport,
} from './tauri';

/**
 * The composition root is the only UI-side import of the mock implementation.
 * Exactly one window owns the client: main (or a browser preview) hosts it, and
 * pet/bubble windows proxy to it. Never give each window its own mock client —
 * that would look synced while actually holding separate conversations.
 */
const label = currentWindowLabel();
const isHost = label === null || label === 'main';
const host = isHost
  ? createHostClient(createMockClient(), tauriTransport)
  : null;
const proxy = host
  ? null
  : createProxyClient(isHost ? nullTransport : tauriTransport);

export const client: OneClient = (host ?? proxy)!.client;

/** 'unavailable' means the authoritative host did not answer; never fake data. */
export const serviceState = (): ServiceState => proxy?.state() ?? 'ready';
export const windowLabel = label;

export const disposeClient = () => (host ?? proxy)?.dispose();
if (import.meta.hot) import.meta.hot.dispose(() => disposeClient());

if (import.meta.env.DEV) {
  void missingShellCommands().then((missing) => {
    if (missing.length)
      console.error(
        `[ONE] 壳未实现这些命令，相关按钮会静默失效：${missing.join(', ')}`,
      );
  });
}
