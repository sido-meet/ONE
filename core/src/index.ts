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

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const version = '0.2.0-dev';

/**
 * 已安装的领域提供方。这是一份**声明**，不是实现：本体据它决定"装没装"，
 * 具体数据在各自的进程里。删掉一条就等于没装那个源，命令会报 not-installed。
 */
const declarations: ProviderDeclaration[] = [
  { id: 'local.calendar', kind: 'calendar' },
  { id: 'local.notes', kind: 'notes' },
];

/**
 * 0.1 还没有安装器，因此用环境变量代替：默认只装了宠物，写成
 * ONE_INSTALLED=pet,local.calendar 就表示日历源也装了。
 */
function readInstalled(): ProviderId[] {
  const raw = process.env.ONE_INSTALLED;
  if (!raw) return ['pet'];
  const providers = raw
    .split(',')
    .map((item) => item.trim())
    .filter(isProviderId);
  return providers.length ? providers : ['pet'];
}

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

async function launchScript(script: string) {
  const child = spawn('pnpm', [script], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    shell: true,
  });
  child.on('error', (error) => {
    process.stderr.write(`ONE 本体：拉起 ${script} 失败：${error.message}\n`);
  });
  child.unref();
}

const launchClient = (provider: ProviderId) =>
  launchScript(LAUNCH_SCRIPTS[provider] ?? `client:${provider}`);

const installed = readInstalled();
const runtime = createMockClient();

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

const shutdown = () => {
  core.unsubscribe();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
