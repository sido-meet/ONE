import net from 'node:net';
import type { ClientMessage } from '../../packages/contracts/src/wire.ts';
import { parseClientMessage } from '../../packages/contracts/src/wire.ts';
import type { Connection, Core } from './core.ts';

/**
 * Windows named pipe transport. 本地回环 TCP 也能通，但命名管道不占端口、
 * 不需要额外鉴权，也不会被同机其他程序连上，适合"只有本机客户端能接入"。
 */
export const PIPE_PATH = '\\\\.\\pipe\\one-core';

const MAX_FRAME_BYTES = 1024 * 1024;

export function serveOnPipe(core: Core, path = PIPE_PATH) {
  // 重复启动时旧实例还占着管道，直接失败比两个本体互相打架好。
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let session: ReturnType<Core['connect']> | null = null;
    // 连接事件走 stderr：本体由客户端拉起，stdout 已经被启动横幅占住了。
    const log = (line: string) => process.stderr.write(`[core] ${line}\n`);
    log('有客户端连上了管道');

    const connection: Connection = {
      send: (message) => {
        if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
      },
      close: () => socket.destroy(),
    };

    const drop = () => {
      if (session) {
        log(`客户端 ${session.info.kind} 断开`);
        core.disconnect(session.info.id);
      }
    };

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_FRAME_BYTES) {
        connection.send({ t: 'rejected', message: '单帧超过上限' });
        connection.close();
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          let parsed: ClientMessage | null = null;
          try {
            parsed = parseClientMessage(JSON.parse(line));
          } catch {
            parsed = null;
          }
          if (!parsed) {
            log(`收到无法解析的帧：${line.slice(0, 120)}`);
            connection.send({ t: 'rejected', message: '无法解析该帧' });
            connection.close();
            return;
          }
          // The first frame creates the session; every later frame is a command.
          session ??= core.connect(connection, parsed);
          if (session) {
            if (parsed.t === 'hello') {
              log(
                `客户端 ${parsed.client.kind} 接入（${
                  parsed.client.capabilities.join('、') || '无能力'
                }）`,
              );
            }
            core.handleMessage(session, parsed);
          }
        }
        newline = buffer.indexOf('\n');
      }
    });

    socket.on('error', drop);
    socket.on('close', drop);
  });

  return new Promise<net.Server>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve(server));
  });
}
