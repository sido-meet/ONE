import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { ClientError } from '../../contracts/src/index.ts';
import { WIRE_VERSION } from '../../contracts/src/wire.ts';
import type { ClientMessage, CoreMessage } from '../../contracts/src/wire.ts';
import { createLocalProvider } from './provider.ts';

/**
 * 本地日历/笔记提供方的进程入口（ADR-016）。
 *
 * 它以**参与者**的身份连本体：role = provider，provider = local.calendar /
 * local.notes，申报自己实现的能力（ADR-017）。之后本体把日历命令转成能力调用
 * 打过来，它照做并回执。
 *
 * 它刻意**不认识**宠物、桌面端、命令行：提供方不需要知道谁在用它，这是
 * 「本体是唯一调用方」换来的自由（ADR-016 第 1 点）。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const DEFAULT_PIPE = '\\\\.\\pipe\\one-core';

/** 数据目录：默认在用户数据下，不污染仓库。 */
const dataDir = process.env.ONE_DATA_DIR ?? path.join(repoRoot, '.one', 'data');

const KINDS = [
  { id: 'local.calendar', kind: 'calendar' as const },
  { id: 'local.notes', kind: 'notes' as const },
];

const ACTIONS = ['list', 'create', 'update', 'remove'] as const;

/** 一个提供方进程同时提供日历与笔记，但各连一根管道 —— 寻址键必须唯一。 */
function connectAs(pipe: string, identity: { id: string; kind: string }) {
  const capabilities = ACTIONS.map((action) => `${identity.kind}.${action}`);
  const pending = new Map<string, (message: CoreMessage) => void>();
  let welcomed = false;

  const closeHandlers: (() => void)[] = [];
  const socket = net.createConnection(pipe);
  socket.setEncoding('utf8');
  socket.on('close', () => {
    for (const handler of closeHandlers) handler();
  });
  socket.on('error', () => {
    for (const handler of closeHandlers) handler();
  });

  const ready = new Promise<void>((resolve, reject) => {
    let buffer = '';
    let greeted = () => {};
    const done = new Promise<void>((inner) => {
      greeted = inner;
    });
    socket.once('error', reject);
    socket.once('connect', () => {
      const hello: ClientMessage = {
        t: 'hello',
        v: WIRE_VERSION,
        client: {
          role: 'provider',
          provider: identity.id,
          label: `本地${identity.kind === 'calendar' ? '日历' : '笔记'}`,
          capabilities,
        },
      };
      socket.write(`${JSON.stringify(hello)}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line) {
          const message = JSON.parse(line) as CoreMessage;
          if (message.t === 'welcome') greeted();
          if (message.t === 'result') pending.get(message.id)?.(message);
          if (message.t === 'invoke') void handleInvoke(message);
          if (message.t === 'rejected') {
            reject(new Error(message.message));
            greeted();
          }
        }
        index = buffer.indexOf('\n');
      }
    });
    void done.then(() => {
      if (!welcomed) {
        welcomed = true;
        resolve();
      }
    });
  });

  const provider = createLocalProvider(
    path.join(dataDir, `${identity.id}.json`),
    identity.kind as 'calendar' | 'notes',
  );

  const ask = (message: ClientMessage) =>
    new Promise<CoreMessage>((resolve) => {
      socket.write(`${JSON.stringify(message)}\n`);
      if ('id' in message) pending.set(message.id, resolve);
    });

  /** 本体叫我们做事。答不回就等于让人干等，所以任何失败都必须回一句话。 */
  async function handleInvoke(message: Extract<CoreMessage, { t: 'invoke' }>) {
    const action = message.capability.split('.')[1] ?? '';
    try {
      const payload = message.args as {
        context: Parameters<typeof provider.list>[0];
        input: unknown;
      };
      const method = provider[action as 'list'];
      if (!method) throw new ClientError('NOT_FOUND', `没有实现 ${action}`);
      const value = await method.call(provider, payload.context, payload.input);
      await ask({ t: 'capability.result', id: message.id, ok: true, value });
    } catch (error) {
      const message_ =
        error instanceof ClientError
          ? error.message
          : error instanceof Error
            ? error.message
            : '提供方处理失败';
      await ask({
        t: 'capability.result',
        id: message.id,
        ok: false,
        message: message_,
      });
    }
  }

  return {
    ready,
    close: () => socket.end(),
    onClose: (handler: () => void) => closeHandlers.push(handler),
  };
}

const pipe = process.env.ONE_PIPE ?? DEFAULT_PIPE;
const links = KINDS.map((identity) => connectAs(pipe, identity));

await Promise.all(links.map((link) => link.ready));

process.stdout.write(
  `ONE 本地提供方已接入：${KINDS.map((item) => item.id).join('、')}（数据目录 ${dataDir}）\n`,
);

const shutdown = () => {
  for (const link of links) link.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 本体管道断了就退出：本体那边会显示「装了没运行」，而赖着不走只会让名册
// 一直挂着一个连不上的提供方。这里的判断是「**所有**身份都断了」，
// 因为日历与笔记各连一根管道，任何一根断了都该重连而不是退出。
let live = KINDS.length;
const dropped = new Promise<void>((resolve) => {
  for (const link of links) {
    link.onClose(() => {
      live -= 1;
      if (live <= 0) resolve();
    });
  }
});
void dropped.then(() => {
  process.stderr.write('ONE 本地提供方：与本体的连接断开，退出等待重启\n');
  process.exit(0);
});
