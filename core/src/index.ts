import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type net from 'node:net';
import path from 'node:path';
import { createMockClient } from '../../packages/mock-runtime/src/index.ts';
import { isProviderId } from '../../packages/contracts/src/wire.ts';
import type { ProviderId } from '../../packages/contracts/src/index.ts';
import { createCore } from './core.ts';
import type { DomainPorts } from './core.ts';
import { PIPE_PATH, serveOnPipe } from './pipe.ts';
import { createProviderRegistry } from './providers/registry.ts';
import type { ProviderDeclaration } from './providers/registry.ts';
import { readInstalled, writeInstalled } from './installed.ts';
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
 * 启动器由宿主注入：core 只知道"要启动一个寻址键"，不关心它是 pnpm 脚本、
 * 打包后的 exe 还是别的什么。
 *
 * 客户端和提供方走的是**同一条**路，core 不知道自己在启动谁 —— 日历提供方不
 * 需要本体为它写任何特判（ADR-016/017）。寻址键到脚本名的映射是宿主的事。
 */
const LAUNCH_SCRIPTS: Record<string, string> = {
  'local.calendar': 'provider:local',
  'local.notes': 'provider:local',
};

/**
 * 拉起一个后台脚本。
 *
 * **`windowsHide: true` 是这里唯一要紧的一行。** 少了它，Windows 会给每个子
 * 进程开一个控制台窗口：用户双击 ONE 之后，桌面上凭空闪出一个黑框，写着
 * `node packages/provider-local/src/main.ts` 然后杵在那里不消失 —— 插件成了
 * 主角，用户成了看客。「后台启动」在 Windows 上不是 `detached` 就够了，
 * 还得明确说「别给我开窗」。
 *
 * `stdio: 'ignore'` 同理：提供方的标准输出不进本体，用户要排障时看本体日志就够
 * 了，几条提供方的输出混进来只会把真正那条错误淹掉。
 */
async function launchScript(script: string) {
  const child = spawn('pnpm', [script], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    shell: true,
    windowsHide: true,
  });
  child.on('error', (error) => {
    process.stderr.write(`ONE 本体：拉起 ${script} 失败：${error.message}\n`);
  });
  child.unref();
}

const launchClient = (provider: ProviderId) =>
  launchScript(LAUNCH_SCRIPTS[provider] ?? `client:${provider}`);

const installed = readInstalled(dataDir());
const runtime = createMockClient();

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
const core = createCore(runtime, {
  version,
  installed,
  launchClient,
  domains: ports,
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

/**
 * 拉起安装清单里的提供方。
 *
 * 按**脚本**去重，不是按寻址键：日历与笔记由同一个进程提供，拉两次就会有两个
 * 进程各报一次身份，名册里凭空多出四个参与者，调用时还会挑中先来的那个。
 * 一个寻址键只能有一个参与者在跑 —— 这是协议的前提（ADR-017）。
 */
const providerScripts = new Set(
  installedProviders.map(
    (item) => LAUNCH_SCRIPTS[item.id] ?? `client:${item.id}`,
  ),
);
for (const script of providerScripts) {
  // 拉不起来的由提供方自己报错退出：本体不能因为一个插件缺失就不启动。
  // 但**拉不起来这件事本身必须说得出口** —— spawn 的错误是异步的，上面那个
  // try/catch 抓不到，只会走到 launchScript 里的 error 监听器，那一句是写给
  // 终端看的。用户看到的是「装了没运行」，却不知道为什么。
  process.stderr.write(`ONE 本体：正在拉起 ${script}\n`);
  try {
    await launchScript(script);
  } catch (error) {
    process.stderr.write(`ONE 本体：拉起 ${script} 失败：${String(error)}\n`);
  }
}

let server: net.Server;
try {
  server = await serveOnPipe(core);
} catch (cause) {
  // 管道被占说明已经有一个本体在跑：这不是故障，别把栈打到用户脸上。
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EADDRINUSE') {
    process.stdout.write('ONE 本体已经在运行，本次启动作废。\n');
    process.exit(0);
  }
  throw cause;
}
process.stdout.write(
  `ONE core ${version} 已启动：命名管道 ${PIPE_PATH}，已安装客户端 ${installed.join('、')}\n`,
);

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
const launchOneself = process.env['ONE_LAUNCH_CLIENT']?.trim();
if (launchOneself && isProviderId(launchOneself)) {
  if (installed.includes(launchOneself)) {
    if (core.roster().some((entry) => entry.provider === launchOneself))
      process.stderr.write(
        `ONE 本体：${launchOneself} 已经在了，不再重复拉起\n`,
      );
    else {
      process.stderr.write(`ONE 本体：正在拉起客户端 ${launchOneself}\n`);
      try {
        await launchClient(launchOneself);
      } catch (error) {
        process.stderr.write(
          `ONE 本体：拉起客户端 ${launchOneself} 失败：${String(error)}\n`,
        );
      }
    }
  } else {
    // 说要拉起的那个没装 —— 说清楚是哪一种没装，别让人以为是自己没点对。
    process.stderr.write(
      `ONE 本体：${launchOneself} 没有安装，先 core install ${launchOneself}\n`,
    );
  }
}

const shutdown = () => {
  core.unsubscribe();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
