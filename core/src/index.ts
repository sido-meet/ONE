import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type net from 'node:net';
import path from 'node:path';
import {
  createMemoryProviders,
  createMockClient,
} from '../../packages/mock-runtime/src/index.ts';
import { PROVIDER_CONTRACT_VERSION } from '../../packages/contracts/src/index.ts';
import { isProviderId } from '../../packages/contracts/src/wire.ts';
import type { ProviderId } from '../../packages/contracts/src/index.ts';
import { createCore } from './core.ts';
import { PIPE_PATH, serveOnPipe } from './pipe.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const version = '0.2.0-dev';

/**
 * 0.1 还没有安装器，因此用环境变量代替：默认只装了宠物，写成
 * ONE_INSTALLED=pet,desktop 就表示桌面端也装了。
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
 * 打包后的 exe 还是别的什么。0.1 用脚本代替安装器。
 *
 * 注意 core 不为 provider 写特判 —— 它连 pet 和 desktop 的区别都不知道，
 * 只把寻址键交给宿主。日历提供方将来也走同一条路（ADR-016/017）。
 */
async function launchClient(provider: ProviderId) {
  const child = spawn('pnpm', [`client:${provider}`], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    shell: true,
  });
  child.on('error', (error) => {
    process.stderr.write(`ONE 本体：拉起 ${provider} 失败：${error.message}\n`);
  });
  child.unref();
}

const installed = readInstalled();
const runtime = createMockClient();

/**
 * 领域端口的**进程内**实现，用来验证端口契约本身（ADR-016 允许实现先在进程内）。
 *
 * 它不是插件进程：数据不落盘、本体崩溃即丢失、页面还没有。真正的外部提供方是
 * D03 的事。所以这里只能说"接口通了"，不能说"日历可用了"。
 */
const memory = createMemoryProviders();
const core = createCore(runtime, {
  version,
  installed,
  launchClient,
  domains: {
    calendar: {
      id: 'local.calendar',
      kind: 'calendar',
      status: 'ready',
      providerVersion: PROVIDER_CONTRACT_VERSION,
      provider: memory.calendar,
    },
    notes: {
      id: 'local.notes',
      kind: 'notes',
      status: 'ready',
      providerVersion: PROVIDER_CONTRACT_VERSION,
      provider: memory.notes,
    },
  },
});

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
