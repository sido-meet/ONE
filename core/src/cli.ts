import { connectToCore } from './link.ts';
import type { CoreMessage } from '../../packages/contracts/src/wire.ts';
import { WIRE_VERSION } from '../../packages/contracts/src/wire.ts';

/** 动作 → 本体白名单命令的后缀。两层命名不同：命令是本体 API，能力是提供方 API。 */
const ACTION_SUFFIX: Record<string, string> = {
  list: 'List',
  get: 'Get',
  create: 'Create',
  update: 'Update',
  remove: 'Delete',
  delete: 'Delete',
};

/**
 * 命令行客户端：ONE 本体不依赖任何图形界面就能使用。
 * 同时也是客户端协议的最小参考实现——宠物和桌面端走的是同一条路径。
 */
/**
 * 等本体回话的上限。
 *
 * **这个数必须容得下一次真的网络往返。** 原本是 8 秒，那是「本体只是读本地 SQLite」
 * 时代的数。接上真模型之后，一次 `send` 要等适配器发完请求、拿到响应头 —— 实测经
 * 本机代理到 Anthropic，光是连上并被拒（编造的 key，401）就要 **8.4 秒**。
 *
 * 8 秒的话 CLI 会给出一句「核心没有回应该请求」，而本体那边其实**正在正常地报 401**。
 * 这句话把一个「密钥不对」说成了「本体没反应」，用户会去查管道和本体进程 —— 而两者
 * 都没毛病。
 *
 * 宁可等久一点：等到了就能看到对面真正说的话（401 还是 529 还是超时），
 * 等不到也只是慢，不会说错。
 */
const ANSWER_TIMEOUT_MS = 60_000;

export async function runCli(argv: string[], pipe?: string) {
  const messages: CoreMessage[] = [];
  const pending = new Map<string, (message: CoreMessage) => void>();
  let firstState: Extract<CoreMessage, { t: 'state' }> | undefined;

  const link = connectToCore({
    role: 'cli',
    provider: 'cli',
    label: 'ONE 命令行',
    capabilities: [],
    version: WIRE_VERSION,
    ...(pipe ? { pipe } : {}),
    onMessage: (message) => {
      messages.push(message);
      if (message.t === 'state') firstState ??= message;
      const key =
        message.t === 'result'
          ? message.id
          : message.t === 'rejected'
            ? 'rejected'
            : null;
      if (key) {
        pending.get(key)?.(message);
        pending.delete(key);
      }
    },
  });

  await link.ready;

  /** Never hang: a missing answer is a failure the caller should see. */
  const ask = (build: (id: string) => unknown) => {
    const id = crypto.randomUUID();
    return new Promise<CoreMessage>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({
          t: 'rejected',
          message: '核心没有回应该请求',
        });
      }, ANSWER_TIMEOUT_MS);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      link.send(build(id) as never);
    });
  };

  const [first, second] = argv;

  if (first === 'send') {
    const conversationId = second ?? 'welcome';
    const text = argv.slice(2).join(' ');
    const reply = await ask((id) => ({
      t: 'call',
      id,
      cmd: 'sendMessage',
      args: [conversationId, text],
    }));
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  } else if (first === 'list') {
    const reply = await ask((id) => ({ t: 'clients.list', id }));
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  } else if (first === 'call') {
    const reply = await ask((id) => ({
      t: 'capability.call',
      id,
      // `call <target> <capability>`，例如 `call pet bubble.open`。
      // 能力名不再自带 "pet." 前缀，所以两个参数必须分开给。
      target: second ?? 'pet',
      capability: argv[2] ?? '',
    }));
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  } else if (first === 'calendar' || first === 'notes') {
    // 本体不依赖图形界面就该能用：领域命令也必须能命令行驱动，否则"宠物坏了
    // 就什么都做不了"。输入是 JSON，由本体在边界校验（ADR-016 第 4 点）。
    const action = second ?? 'list';
    const input = argv[2] ?? '{}';
    const context = {
      requestId: `cli-${Date.now()}`,
      workspaceId: 'personal',
      source: 'ui' as const,
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          ok: false,
          message: `输入不是合法 JSON：${(error as Error).message}`,
        })}\n`,
      );
      return;
    }
    const reply = await ask((id) => ({
      t: 'call',
      id,
      cmd: `${first}${ACTION_SUFFIX[action] ?? ''}`,
      args: [context, parsed],
    }));
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  } else if (first === 'proposal') {
    // 提议也要能命令行处理。宠物窗口可能正被别的东西盖住、拿不到焦点，
    // 而「本体不依赖图形界面就能用」是这条命令行存在的理由 —— 只在界面上
    // 能点的按钮，等于给卡住的时候留了一条死路。
    const action = second ?? 'list';
    const reply =
      action === 'list'
        ? await ask((id) => ({ t: 'call', id, cmd: 'listProposals', args: [] }))
        : await ask((id) => ({
            t: 'call',
            id,
            cmd: 'proposalResolve',
            args: [
              action === 'confirm'
                ? { proposalId: argv[2] ?? '', decision: 'confirm' }
                : {
                    proposalId: argv[2] ?? '',
                    decision: 'reject',
                    reason: argv.slice(3).join(' '),
                  },
            ],
          }));
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  } else if (first === 'conversation') {
    // 读回来说过的话。宠物窗口被别的程序盖住、或那个无边框置顶窗口拿不到键盘
    // 焦点时，「ONE 到底回了我什么」只剩下这一条不靠鼠标的路 —— 没有它，无头
    // 验收就只能看日志猜。
    const reply = await ask((id) => ({
      t: 'call',
      id,
      cmd: 'conversationHistory',
      args: [second ?? 'welcome'],
    }));
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  } else if (first === 'install' || first === 'uninstall') {
    // 0.1 的「安装器」。装一次之后，双击 ONE 就会自己把提供方拉起来 ——
    // 不再要求用户先开一个终端把 ONE_INSTALLED 敲进去才看得到日历。
    const reply = await ask((id) => ({
      t: 'call',
      id,
      cmd: first === 'install' ? 'installProviders' : 'uninstallProviders',
      args: [argv.slice(1)],
    }));
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  } else if (first === 'export' || first === 'import') {
    // 备份（ADR-029）。路径必须给完整路径 —— 相对路径的分歧不该由本体替用户决定。
    const reply = await ask((id) => ({
      t: 'call',
      id,
      cmd: first === 'export' ? 'dataExport' : 'dataImport',
      args: [argv[1] ?? ''],
    }));
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  } else if (first === 'forget') {
    // 彻底删除一段对话：物理删除，连事件一起（ADR-028）。
    const reply = await ask((id) => ({
      t: 'call',
      id,
      cmd: 'dataForgetConversation',
      args: [second ?? ''],
    }));
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  } else if (first === 'exportdir') {
    const reply = await ask((id) => ({
      t: 'call',
      id,
      cmd: 'dataExportDir',
      args: [],
    }));
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  } else if (first === 'installed') {
    const reply = await ask((id) => ({ t: 'clients.list', id }));
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  } else if (first === 'launch') {
    const reply = await ask((id) => ({
      t: 'clients.launch',
      id,
      provider: second ?? 'pet',
    }));
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  } else {
    // 默认动作：等待第一份快照再报告本体持有的状态。
    if (!firstState) await new Promise((resolve) => setTimeout(resolve, 300));
    process.stdout.write(
      `${JSON.stringify({
        conversations:
          firstState?.snapshot.conversations.map((item) => item.title) ?? [],
        events: firstState?.snapshot.events.length ?? 0,
      })}\n`,
    );
  }

  link.close();
}
