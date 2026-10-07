import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type net from 'node:net';
import path from 'node:path';
import {
  createMemoryRuntime,
  createMockAgents,
} from '../../packages/mock-runtime/src/index.ts';
import { isProviderId } from '../../packages/contracts/src/wire.ts';
import type { ProviderId } from '../../packages/contracts/src/index.ts';
import { createCore } from './core.ts';
import type { DomainPorts } from './core.ts';
import { createConversationRuntime } from '../../packages/conversation/src/runtime.ts';
import { createBackupService } from './backup.ts';
import type { BackupService } from './backup.ts';
import {
  createSqliteConversationStore,
  openConversationDatabase,
} from '../../packages/conversation/src/store-sqlite.ts';
import { PIPE_PATH, serveOnPipe } from './pipe.ts';
import { createProviderRegistry } from './providers/registry.ts';
import type { ProviderDeclaration } from './providers/registry.ts';
import { readInstalled, writeInstalled } from './installed.ts';
import { becomeTheCore, providerEntriesOf } from './startup.ts';
import { dataDir as resolveDataDir } from '../../packages/hostpaths/src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const version = '0.2.0-dev';

/**
 * 本地数据目录。与本地提供方**同一处**（`packages/hostpaths`，两边共用一份）。
 *
 * 曾经两边各按自己的位置算「根」：本体从 `dist-runtime/` 跑，就把安装清单写进
 * 产物目录；提供方从仓库跑，就把日历写进仓库目录。于是同一个应用有两处数据，
 * 而从开始菜单双击启动的本体读不到那份清单 —— 用户得先开一个终端敲一遍
 * `ONE_INSTALLED` 才看得到日历。那不是慢了一步，是产品要求用户替自己做安装。
 */
export function dataDir(): string {
  return resolveDataDir();
}

/**
 * 已安装的领域提供方。这是一份**声明**，不是实现：本体据它决定"装没装"，
 * 具体数据在各自的进程里。删掉一条就等于没装那个源，命令会报 not-installed。
 */
const declarations: ProviderDeclaration[] = [
  { id: 'local.calendar', kind: 'calendar' },
  { id: 'local.notes', kind: 'notes' },
];

/**
 * 启动器由宿主注入：core 只知道"要启动一个寻址键"，不关心它是哪个文件。
 *
 * 客户端和提供方走的是**同一条**路，core 不知道自己在启动谁 —— 日历提供方不
 * 需要本体为它写任何特判（ADR-016/017）。寻址键到入口的映射是宿主的事。
 *
 * 值是**相对 repoRoot 的入口路径**，不是 pnpm 脚本名（ADR-030）。开发环境的根是
 * 仓库、产物环境的根是 `dist-runtime/`，而打包搬过去的是同一批相对路径，所以同一
 * 张表在两边都成立 —— 按环境分叉等于把这个坑复制成两份。
 */
const LAUNCH_ENTRIES: Record<string, string> = {
  'local.calendar': 'packages/provider-local/src/main.ts',
  'local.notes': 'packages/provider-local/src/main.ts',
};

/**
 * 可视客户端的入口（ADR-030 第 5 点）。
 *
 * 只有 `ONE_LAUNCH_CLIENT` 会走这条路，而壳从不设那个变量 —— 它是开发与验收时让
 * 本体当入口用的。发布包里也**没有** `scripts/`：exe 自己就是客户端，不需要本体再拉
 * 一个 `node scripts/client.mjs`。所以这张表在发布环境里必然指向不存在的文件，
 * `launchEntry` 会把这件事说清楚，而不是让它报一句笼统的「拉不起来」。
 */
const CLIENT_ENTRIES: Record<string, string> = {
  pet: 'scripts/client.mjs',
  desktop: 'scripts/client.mjs',
};

/**
 * 拉起一个后台进程。
 *
 * **用 `process.execPath` 而不是 `pnpm`。** 本体进程自己就是那个随包携带的
 * `node.exe`（ADR-021），指向它的路径就够跑提供方了。曾经这里绕道
 * `spawn('pnpm', ['provider:local'], { shell: true })` —— 于是发布出去的东西要求目标
 * 机器先装好 pnpm 和 node，而本体起得来、日历与笔记永远不接上，用户只看到一句
 * 「装了没运行」（ADR-030）。
 *
 * **`windowsHide: true` 仍然是这里唯一要紧的一行。** 少了它，Windows 会给每个子
 * 进程开一个控制台窗口：用户双击 ONE 之后，桌面上凭空闪出一个黑框，写着
 * `node packages/provider-local/src/main.ts` 然后杵在那里不消失 —— 插件成了
 * 主角，用户成了看客。「后台启动」在 Windows 上不是 `detached` 就够了，
 * 还得明确说「别给我开窗」。
 *
 * `stdio: 'ignore'` 同理：提供方的标准输出不进本体，用户要排障时看本体日志就够
 * 了，几条提供方的输出混进来只会把真正那条错误淹掉。也正因为它被丢掉，**入口文件
 * 存不存在必须在这里自己查**：`spawn` 只在可执行文件找不到时才报错，而入口缺失
 * 的话子进程会起来又立刻退出，那句 `MODULE_NOT_FOUND` 我们一个字都读不到。
 */
function launchEntry(entry: string, args: readonly string[] = []) {
  const full = path.join(repoRoot, entry);
  if (!existsSync(full)) {
    return Promise.reject(
      new Error(
        `入口不存在：${full}\n` +
          (entry.startsWith('scripts/')
            ? 'scripts/ 只在仓库里有，发布产物里不带 —— 发布包里的可视客户端由 exe 自己起，不需要本体再拉一次。'
            : '执行 pnpm core:package 让它进产物。'),
      ),
    );
  }
  const child = spawn(process.execPath, [full, ...args], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (error) => {
    process.stderr.write(`ONE 本体：拉起 ${entry} 失败：${error.message}\n`);
  });
  child.unref();
  return Promise.resolve();
}

const launchClient = (provider: ProviderId) => {
  const entry = CLIENT_ENTRIES[provider];
  if (!entry)
    return Promise.reject(
      new Error(`${provider} 没有客户端入口，不知道该拉起哪个文件`),
    );
  return launchEntry(entry, [provider]);
};

const installed = readInstalled(dataDir());

/**
 * 会话运行时：**对话归本体**（ADR-028）。
 *
 * Store 是 SQLite（`core.db`），Agent 是模拟的（`packages/mock-runtime`）。状态机只有
 * 一份 —— 换成真模型时换的是 Agent 那一行，不是这里。`core.db` 与提供方的 `local.db`
 * 是两个文件：所有者不同，合成一个就意味着本体要写提供方的 schema。
 *
 * 库开在**本体这一侧**，所以本体崩了重启回来，对话还在；而上次崩在半路的 Run 会
 * 落成 `interrupted`，不会永远转圈。
 */
const conversationDatabase = openConversationDatabase(
  path.join(dataDir(), 'core.db'),
);
const conversationStore = createSqliteConversationStore(conversationDatabase);
const runtime = createConversationRuntime(
  conversationStore,
  createMockAgents(),
);
process.stderr.write(`ONE 本体：会话库 ${conversationDatabase.file}\n`);

/**
 * 装了什么、准备拉起什么，写一行日志。
 *
 * 「自动启动」这件事一旦不出错就没人在意，一旦出错就是用户对着一个空日历发呆 ——
 * 而他自己并不知道刚才系统打算拉起什么。降级也要看得见（ADR-021 同一条纪律）。
 */
process.stderr.write(
  `ONE 本体：已安装 ${installed.join('、')}；清单来自 ${
    process.env.ONE_INSTALLED?.trim() ? '环境变量' : '安装清单文件'
  }\n`,
);

/**
 * 领域提供方是本体外的独立进程（ADR-016）。本体只持有它们的端口，不持有任何
 * 日历或笔记实体 —— 下面这两条端口都是转发，实体在提供方那边。
 *
 * domains 传的是**同一个可变对象**：core 启动时还没有 registry（registry 需要
 * core 才能读名册），所以这里先把端口挂空，等 core 建好再填进去。core 的命令
 * 白名单每次调用都现读 ports，因此填晚一点没关系，但对象必须是同一个。
 */
/**
 * 只有**真的装了**的提供方才进注册表。这是「没安装」与「装了没运行」的分界：
 * 前者根本没进列表，调用方拿到的是"还没有接日历源"以及怎么装的引导；后者在
 * 列表里但离线，调用方拿到的是"日历源没连上"。两者混成一句话，用户就既不知道
 * 该去装还是该去看进程（ADR-016 的错误表）。
 */
const installedProviders = declarations.filter((item) =>
  installed.includes(item.id),
);
const ports: DomainPorts = {};
/**
 * 备份服务（ADR-029）与 `ports` 同一个套路：**后填的同一个可变位置**。
 *
 * 它要拿 core 自己的 `invoke` 去问参与者，而 core 此刻还没建好。命令每次调用现读
 * `options.backup?.()`，所以装配顺序不影响它能不能用。
 */
let backupService: BackupService | undefined;
const core = createCore(runtime, {
  version,
  installed,
  launchClient,
  domains: ports,
  backup: () => backupService,
  // 清单变了由宿主落盘：本体持有「装了什么」这个决定，「记在哪」是它不关心的事。
  onInstalledChange: (ids) => {
    try {
      writeInstalled(dataDir(), ids);
    } catch (error) {
      process.stderr.write(`ONE 本体：写安装清单失败：${String(error)}\n`);
    }
  },
});
const registry = createProviderRegistry(core, installedProviders);
ports.calendar = registry.calendar;
ports.notes = registry.notes;

backupService = createBackupService({
  core,
  store: conversationStore,
  version,
  dataDir: dataDir(),
  contextFor: (requestId: string) => ({
    requestId,
    workspaceId: 'personal',
    // 备份是**用户**发起的（界面按钮或命令行），不是模型代劳，所以标 ui 不标 agent。
    source: 'ui',
  }),
  // 导入或删掉对话之后，运行时的内存副本必须跟着换 —— 否则界面继续显示一份库里
  // 已经不存在的东西，而用户以为没生效（ADR-028：状态只有一份）。
  onConversationsReplaced: () => runtime.rebind(),
});
process.stderr.write(`ONE 本体：备份目录 ${backupService.exportDir()}\n`);

/**
 * 拉起安装清单里的提供方，得到一串**入口路径**。
 *
 * 去重按**入口**而不是寻址键 —— 日历与笔记由同一个进程提供，拉两次就是两个进程各报
 * 一次身份。规矩本身在 startup.ts 里（那里还有另一半：抢管道之前一个都不许拉）。
 */
const providerEntries = providerEntriesOf(
  installedProviders.map((item) => item.id),
  LAUNCH_ENTRIES,
);

let server: net.Server | null = null;

/**
 * 「我是不是那个本体」要在**任何副作用之前**定下来。
 *
 * steps 里那几件事就是副作用：打印启动行、拉起提供方、把可视客户端带出来。第二个本体
 * 在这里就该收手 —— 它要是接着往下走，用户机器上就会多出一整份没人管的提供方，而名册
 * 里每个寻址键从此有两个参与者（ADR-017 的前提被悄悄破坏，调用还会挑中先来的那个）。
 * 详见 startup.ts。
 */
const becameTheCore = await becomeTheCore({
  claim: async () => {
    try {
      server = await serveOnPipe(core);
      return true;
    } catch (cause) {
      // 管道被占说明已经有一个本体在跑：这不是故障，别把栈打到用户脸上。
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      return code === 'EADDRINUSE' ? false : Promise.reject(cause);
    }
  },
  claimFailed: () => {
    process.stdout.write('ONE 本体已经在运行，本次启动作废。\n');
  },
  steps: [
    async () => {
      process.stdout.write(
        `ONE core ${version} 已启动：命名管道 ${PIPE_PATH}，已安装客户端 ${installed.join('、')}\n`,
      );
    },
    // 拉不起来的由提供方自己报错退出：本体不能因为一个插件缺失就不启动。
    // 但**拉不起来这件事本身必须说得出口** —— spawn 的错误是异步的，try/catch 抓不到，
    // 只会走到 launchEntry 里的 error 监听器，那一句是写给终端看的。用户看到的是
    // 「装了没运行」，却不知道为什么。
    ...providerEntries.map((entry) => async () => {
      process.stderr.write(`ONE 本体：正在拉起 ${entry}\n`);
      try {
        await launchEntry(entry);
      } catch (error) {
        process.stderr.write(
          `ONE 本体：拉起 ${entry} 失败：${String(error)}\n`,
        );
      }
    }),
    async () => {
      /**
       * **本体也可以是入口**：起来了就把可视客户端一并带出来。
       *
       * 以前这条路的顺序是反的 —— 要看宠物得先在一个终端里起本体，再在另一个终端里
       * 起客户端。于是「启动 ONE」实际上是「手动开两个进程」，而且必须看得见那个终端。
       * 那个终端一关，本体跟着死，用户面前的宠物就变成一个连不上任何东西的空窗。
       *
       * 由 `ONE_LAUNCH_CLIENT=pet|desktop` 开启：**本体客户端自己不会设这个变量**，
       * 所以不会互相拉起、来回递归。已经在场的同类客户端不重复拉 —— 一个寻址键只能
       * 有一个参与者在跑（ADR-017）。
       */
      const myself = process.env['ONE_LAUNCH_CLIENT']?.trim();
      if (!myself || !isProviderId(myself)) return;
      if (!installed.includes(myself)) {
        // 说要拉起的那个没装 —— 说清楚是哪一种没装，别让人以为是自己没点对。
        process.stderr.write(
          `ONE 本体：${myself} 没有安装，先 core install ${myself}\n`,
        );
        return;
      }
      if (core.roster().some((entry) => entry.provider === myself)) {
        process.stderr.write(`ONE 本体：${myself} 已经在了，不再重复拉起\n`);
        return;
      }
      process.stderr.write(`ONE 本体：正在拉起客户端 ${myself}\n`);
      try {
        await launchClient(myself);
      } catch (error) {
        process.stderr.write(
          `ONE 本体：拉起客户端 ${myself} 失败：${String(error)}\n`,
        );
      }
    },
  ],
});
if (!becameTheCore) process.exit(0);

// TS 看不穿 claim 回调里的赋值，它看到的 `server` 仍然是声明时的 null ——
// 所以这里不假装它是 net.Server，老老实实按可能为空来收尾。抢到管道之后才走到
// 这一行，server 必然有值；万一不是，close 少调一次也只是句柄没关，进程马上就退。
const shutdown = () => {
  core.unsubscribe();
  server?.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
