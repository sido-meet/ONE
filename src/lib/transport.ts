import type { ClientMessage } from '../../packages/contracts/src/wire.ts';
import type { Core } from '../../core/src/core.ts';
import type { CoreChannel, CoreConnection } from './core-link';

/**
 * 进程内的通道：真的建一个本体，把它的帧原样转给界面。
 *
 * 浏览器预览和测试都用它。预览因此不是"假数据模式"，而是本体跑在同一个进程
 * 里——和桌面上唯一的区别是传输层，不该有第二套语义。
 */
export function createMemoryCoreChannel(options: {
  core: Core;
  hello: ClientMessage;
  connection: Omit<CoreConnection, 'connected'>;
}): CoreChannel {
  const frameHandlers = new Set<(line: string) => void>();
  const statusHandlers = new Set<(status: CoreConnection) => void>();
  let session: ReturnType<Core['connect']> = null;
  let connected = true;

  const status = (): CoreConnection => ({ ...options.connection, connected });

  const publish = () => {
    const current = status();
    statusHandlers.forEach((handler) => handler(current));
  };

  const deliver = (message: unknown) => {
    const line = JSON.stringify(message);
    frameHandlers.forEach((handler) => handler(line));
  };

  return {
    async connection() {
      return status();
    },
    async send(frame: ClientMessage) {
      if (!connected) throw new Error('ONE 本体没有连接');
      if (!session) {
        // 第一帧建立会话，之后每一帧都是命令，和真实管道完全一致。
        session = options.core.connect(
          { send: deliver, close: () => undefined },
          frame,
        );
        if (!session) return;
        publish();
        return;
      }
      options.core.handleMessage(session, frame);
    },
    onFrame(handler) {
      frameHandlers.add(handler);
      return () => frameHandlers.delete(handler);
    },
    onStatus(handler) {
      statusHandlers.add(handler);
      handler(status());
      return () => statusHandlers.delete(handler);
    },
  };
}
