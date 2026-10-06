import type { CoreClient } from './core-link';

/**
 * 一个客户端能被别人调用什么，由它自己实现、由它自己声明（ADR-013）。
 *
 * 声明在壳里（Rust 的 capabilities 列表，随 hello 发给本体），实现在这里。
 * 两边一旦漂移，本体就会把调用转给一个没人接的能力——界面必须自己发现，
 * 而不是等用户点了没反应。
 */
export type CapabilityHandler = (args: unknown) => unknown | Promise<unknown>;

export function installCapabilities(
  link: CoreClient,
  declared: string[],
  handlers: Record<string, CapabilityHandler>,
): void {
  const missing = declared.filter((name) => !(name in handlers));
  const extra = Object.keys(handlers).filter(
    (name) => !declared.includes(name),
  );
  for (const name of declared) {
    const handler = handlers[name];
    if (handler) link.expose(name, handler);
  }
  if (import.meta.env?.DEV && (missing.length || extra.length)) {
    if (missing.length) {
      console.error(
        `[ONE] 壳声明了这些能力但界面没有实现，别的客户端调用它们会失败：${missing.join(', ')}`,
      );
    }
    if (extra.length) {
      console.error(
        `[ONE] 界面实现了这些能力但壳没有声明，别人根本调不到：${extra.join(', ')}`,
      );
    }
  }
}
