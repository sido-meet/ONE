/**
 * Injectable event channel. The Tauri implementation lives in `tauri.ts`; tests
 * use an in-memory pair, so the window protocol can be verified without a
 * desktop build.
 */
export interface Transport {
  send(event: string, payload: unknown): void;
  /** Returns a synchronous cancel function even though registration is async. */
  listen(event: string, handler: (payload: unknown) => void): () => void;
}

/**
 * Two transports wired to one queue. `host` delivers to whatever `window` ends
 * listen for, and `window` delivers to whatever `host` ends listen for.
 */
export function createMemoryTransportPair(): {
  host: Transport;
  window: Transport;
} {
  const toHost = new Map<string, Set<(payload: unknown) => void>>();
  const toWindow = new Map<string, Set<(payload: unknown) => void>>();
  const register = (
    target: Map<string, Set<(payload: unknown) => void>>,
    event: string,
    handler: (payload: unknown) => void,
  ) => {
    const handlers = target.get(event) ?? new Set();
    handlers.add(handler);
    target.set(event, handlers);
    return () => handlers.delete(handler);
  };
  return {
    host: {
      send: (event, payload) =>
        toWindow.get(event)?.forEach((handler) => handler(payload)),
      listen: (event, handler) => register(toHost, event, handler),
    },
    window: {
      send: (event, payload) =>
        toHost.get(event)?.forEach((handler) => handler(payload)),
      listen: (event, handler) => register(toWindow, event, handler),
    },
  };
}
