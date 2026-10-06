import type {
  ClientKind,
  ClientMessage,
  CoreMessage,
} from '../../packages/contracts/src/wire.ts';
import {
  MAX_FRAME_BYTES,
  isClientKind,
  parseCoreMessage,
} from '../../packages/contracts/src/wire.ts';

/**
 * 本体 → 客户端这一侧的护栏（ADR-013）。
 *
 * 壳把本体的原始行原样转过来，所以"这一行是本体说的"只是一句声明。界面在
 * 解释任何一帧之前都必须先过这里，坏帧丢掉而不是猜。
 */

/** 超长行说明这一侧出了问题：宁可当没收到，也不让它进内存。 */
export function parseCoreFrame(line: string): CoreMessage | null {
  if (line.length > MAX_FRAME_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return parseCoreMessage(value);
}

export function isClientKindValue(value: unknown): value is ClientKind {
  return isClientKind(value);
}

/** 每个请求都要有自己的 id，本体按 id 把回执送回来。 */
export function newRequestId(): string {
  return crypto.randomUUID();
}

export interface ClientHello {
  t: 'hello';
  v: number;
  client: { kind: ClientKind; label: string; capabilities: string[] };
}

export function isClientHello(value: unknown): value is ClientMessage {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as { t?: unknown };
  return frame.t === 'hello';
}
