import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type net from 'node:net';
import path from 'node:path';
import { createMockClient } from '../../packages/mock-runtime/src/index.ts';
import { isClientKind } from '../../packages/contracts/src/wire.ts';
import type { ClientKind } from '../../packages/contracts/src/index.ts';
import { createCore } from './core.ts';
import { PIPE_PATH, serveOnPipe } from './pipe.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const version = '0.2.0-dev';

/**
 * 0.1 还没有安装器，因此用环境变量代替：默认只装了宠物，写成
 * ONE_INSTALLED=pet,desktop 就表示桌面端也装了。
 */
function readInstalled(): ClientKind[] {
  const raw = process.env.ONE_INSTALLED;
  if (!raw) return ['pet'];
  const kinds = raw
    .split(',')
    .map((item) => item.trim())
    .filter(isClientKind);
  return kinds.length ? kinds : ['pet'];
}

/**
 * 启动器由宿主注入：core 只知道"要启动一个 pet / desktop 客户端"，不关心它是
 * pnpm 脚本、打包后的 exe 还是别的什么。0.1 用脚本代替安装器。
 */
async function launchClient(kind: ClientKind) {
  const script = kind === 'desktop' ? 'client:desktop' : 'client:pet';
  const child = spawn('pnpm', [script], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    shell: true,
  });
  child.on('error', (error) => {
    process.stderr.write(
      `ONE 本体：拉起 ${kind} 客户端失败：${error.message}\n`,
    );
  });
  child.unref();
}

const installed = readInstalled();
const client = createMockClient();
const core = createCore(client, {
  version,
  installed,
  launchClient,
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
