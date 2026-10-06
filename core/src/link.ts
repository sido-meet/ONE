import net from 'node:net';
import type {
  ClientMessage,
  CoreMessage,
  ParticipantRole,
  ProviderId,
} from '../../packages/contracts/src/wire.ts';

export const DEFAULT_PIPE = '\\\\.\\pipe\\one-core';

export interface ClientLink {
  send(message: ClientMessage): void;
  close(): void;
  /** Resolves once the core accepts the handshake. */
  ready: Promise<void>;
}

/**
 * 客户端侧管道连接：只负责收发帧，不理解业务。宠物、桌面端和命令行都用它，
 * 因此"换个呈现形式"不需要重写协议代码。
 */
export function connectToCore(options: {
  role: ParticipantRole;
  provider: ProviderId;
  label: string;
  capabilities: string[];
  version: number;
  pipe?: string;
  onMessage: (message: CoreMessage) => void;
}): ClientLink {
  const socket = net.createConnection(options.pipe ?? DEFAULT_PIPE);
  socket.setEncoding('utf8');

  let buffer = '';
  let welcomed = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    welcomed = resolve;
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({
          t: 'hello',
          v: options.version,
          client: {
            role: options.role,
            provider: options.provider,
            label: options.label,
            capabilities: options.capabilities,
          },
        })}\n`,
      );
    });
  });

  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as CoreMessage;
          if (message.t === 'welcome') welcomed();
          options.onMessage(message);
        } catch {
          // 无法解析的帧直接丢弃；core 收到坏输入会自行断开。
        }
      }
      newline = buffer.indexOf('\n');
    }
  });

  return {
    ready,
    send: (message) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
    },
    close: () => socket.destroy(),
  };
}
