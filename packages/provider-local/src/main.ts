import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { ClientError, portableDetails } from '../../contracts/src/index.ts';
import type { CommandContext } from '../../contracts/src/index.ts';
import { CALENDAR_ACTIONS, NOTES_ACTIONS } from '../../contracts/src/index.ts';
import { PAGE_READ_CAPABILITY } from '../../contracts/src/page.ts';
import { WIRE_VERSION } from '../../contracts/src/wire.ts';
import type { ClientMessage, CoreMessage } from '../../contracts/src/wire.ts';
import { PAGE_ENTRY, pageRoot, readPageResource } from './pages.ts';
import {
  BACKUP_ACTIONS,
  BACKUP_EXPORT_CAPABILITY,
  BACKUP_IMPORT_CAPABILITY,
  BACKUP_SCHEMA_VERSION,
} from '../../contracts/src/backup.ts';
import { openDatabase } from './db.ts';
import { createRepository } from './repository.ts';
import { createLocalProvider } from './provider.ts';
import { dataDir as resolveDataDir } from '../../hostpaths/src/index.ts';

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

/**
 * 数据目录：与本体**同一处**（`packages/hostpaths`，两边共用一份）。
 *
 * 以前这里按「自己所在的仓库」算，本体按「自己所在的位置」算，两边分家 ——
 * 同一个应用的日历在一个目录、安装清单在另一个，而从开始菜单双击启动的那个
 * 本体哪个都读不到。共用一份解析是唯一的解法：少写一份，就少漂移一次。
 */
const dataDir = resolveDataDir();

const KINDS = [
  { id: 'local.calendar', kind: 'calendar' as const },
  { id: 'local.notes', kind: 'notes' as const },
];

/**
 * 能力名跟着**域**走，不是一张共用的表。
 *
 * 共用会让笔记多一条 `get` 时日历也跟着被要求那一条，于是本体核对申报发现日历
 * 缺能力，把整个日历判成「没授权」（这条判据本身是对的：宁可报没授权，也不要把
 * 残缺的提供方当完整的用）。日历不需要 `get` —— 它的列表返回的就是完整实体。
 */
const ACTIONS_OF: Record<string, readonly string[]> = {
  calendar: CALENDAR_ACTIONS,
  notes: NOTES_ACTIONS,
};

/**
 * 库只开一次，日历与笔记两个身份共用（R01）。
 *
 * 以前是两个 JSON 文件、两份内存副本。现在共用一份库文件既是为了迁移只跑一次，
 * 也是因为「同一个进程里两个身份各写一份」曾经造成过名册上两个日历 —— 数据库层面
 * 共用一份，重复的参与者就是唯一那个了。
 *
 * 旧文件按身份列出来：它们的内容会被导进同一个库，导完改名成 `.migrated`。
 */
const database = openDatabase(
  path.join(dataDir, 'local.db'),
  KINDS.map((item) => path.join(dataDir, `${item.id}.json`)),
);
const repository = createRepository(database.db);

/** 一个提供方进程同时提供日历与笔记，但各连一根管道 —— 寻址键必须唯一。 */
function connectAs(pipe: string, identity: { id: string; kind: string }) {
  const capabilities = [
    ...ACTIONS_OF[identity.kind]!.map((action) => `${identity.kind}.${action}`),
    // 页面也是这个进程的一部分：它声明 page.read，本体才会把宿主的取页请求转过来。
    PAGE_READ_CAPABILITY,
    // 备份是**跨域**能力：一个提供方的整份数据，不是某一个域的一次操作（ADR-029）。
    // 两个身份各交自己那一份 —— 它们的表不同，混成一份会丢掉「谁拥有哪条数据」。
    ...BACKUP_ACTIONS.map((action) =>
      action === 'export' ? BACKUP_EXPORT_CAPABILITY : BACKUP_IMPORT_CAPABILITY,
    ),
  ];
  // 资源根按身份分目录：一个身份读不到另一个身份的页面（实机抓到的串页）。
  const pages = pageRoot(identity.kind);
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
          // 自带页面（ADR-018）：本体据此知道这个寻址键能开页面，宿主据此决定
          // 能不能开窗。页面目录按身份分开，两个身份不会串页。
          view: { entry: PAGE_ENTRY },
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
    repository,
    identity.kind as 'calendar' | 'notes',
  );

  const ask = (message: ClientMessage) =>
    new Promise<CoreMessage>((resolve) => {
      socket.write(`${JSON.stringify(message)}\n`);
      if ('id' in message) pending.set(message.id, resolve);
    });

  /** 本体叫我们做事。答不回就等于让人干等，所以任何失败都必须回一句话。 */
  async function handleInvoke(message: Extract<CoreMessage, { t: 'invoke' }>) {
    try {
      if (message.capability === PAGE_READ_CAPABILITY) {
        const asked = message.args as { path?: unknown } | undefined;
        await ask({
          t: 'capability.result',
          id: message.id,
          ok: true,
          value: readPageResource(pages, asked?.path),
        });
        return;
      }
      // 备份能力不带域前缀，所以走不到下面那段 `identity.kind.` 的分派里 ——
      // 放到那里会被算成空 action，报「没有实现 data.export」。
      if (
        message.capability === BACKUP_EXPORT_CAPABILITY ||
        message.capability === BACKUP_IMPORT_CAPABILITY
      ) {
        const asked = (message.args ?? {}) as {
          context?: CommandContext;
          data?: unknown;
        };
        const workspaceId = asked.context?.workspaceId ?? 'personal';
        const value =
          message.capability === BACKUP_EXPORT_CAPABILITY
            ? {
                schemaVersion: BACKUP_SCHEMA_VERSION,
                kind: identity.kind,
                data: repository.exportSlice(
                  identity.kind as 'calendar' | 'notes',
                  workspaceId,
                ),
              }
            : (() => {
                repository.replaceWorkspace(
                  identity.kind as 'calendar' | 'notes',
                  workspaceId,
                  asked.data,
                );
                return { ok: true };
              })();
        await ask({ t: 'capability.result', id: message.id, ok: true, value });
        return;
      }
      // 能力名必须属于**本身份**。只取后半段的话，笔记身份会照办日历身份收到的
      // `notes.list` —— 同一个进程里两份数据，于是日历窗口读得到笔记内容。
      const action = message.capability.startsWith(`${identity.kind}.`)
        ? message.capability.slice(identity.kind.length + 1)
        : '';
      const payload = message.args as {
        context: Parameters<typeof provider.list>[0];
        input: unknown;
      };
      const method = provider[action as 'list'];
      if (!method)
        throw new ClientError('NOT_FOUND', `没有实现 ${message.capability}`);
      const value = await method.call(provider, payload.context, payload.input);
      await ask({ t: 'capability.result', id: message.id, ok: true, value });
    } catch (error) {
      // 码要一起发出去：本体与壳靠它把「没有这个文件」「没有授权」「里面坏了」
      // 分开说，只发一句话的话，上游只能一律当成内部错误（ADR-016）。
      //
      // `details` 同样要带：冲突时「对方现在是第几版」就在里面，少了它界面只能说
      // 「被改过了」而给不出版本，用户没法决定是放弃自己那份还是再看一眼对方那份。
      const details = portableDetails(
        error instanceof ClientError ? error.details : undefined,
      );
      await ask({
        t: 'capability.result',
        id: message.id,
        ok: false,
        code: error instanceof ClientError ? error.code : 'INTERNAL',
        message: error instanceof Error ? error.message : '提供方处理失败',
        ...(details ? { details } : {}),
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
  `ONE 本地提供方已接入：${KINDS.map((item) => item.id).join('、')}（数据目录 ${dataDir}，库 ${database.file}${database.backup ? `，迁移前备份 ${database.backup}` : ''}）\n`,
);

const shutdown = () => {
  for (const link of links) link.close();
  // 库要显式关。不关的话进程退出时 WAL 可能来不及并回主文件 —— 那不是丢数据
  // （重开时会自己恢复），但会让「用户刚删掉的东西还在」这件事在文件层面成立。
  database.close();
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
