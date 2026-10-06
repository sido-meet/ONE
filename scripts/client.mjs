import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * 启动一个 ONE 客户端。宠物和桌面端是同一个可执行文件的两种启动方式，
 * 所以这里只有两件事要决定：用已构建的二进制（两个客户端可以同时跑），
 * 还是用 tauri dev（能热更新，但一次只能占一个 1420 端口）。
 *
 * 用法：node scripts/client.mjs <pet|desktop> [--dev]
 */

const PIPE = '\\\\.\\pipe\\one-core';
const CORE_ENTRY = 'core/src/index.ts';
const DEV_URL = 'http://127.0.0.1:1420';
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const builtExe = path.join(
  repoRoot,
  'src-tauri',
  'target',
  'release',
  'one-desktop.exe',
);
// 直接跑 tauri 可执行文件：经过 pnpm 时那个 `--` 会被 pnpm 自己吃掉，
// 客户端的启动参数就传不到进程里了。
const tauriBin = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tauri.cmd' : 'tauri',
);

const KINDS = new Set(['pet', 'desktop']);
const args = process.argv.slice(2);
const kind = args.find((item) => !item.startsWith('--'));
const dev = args.includes('--dev');

if (!kind || !KINDS.has(kind)) {
  console.error(
    `用法：node scripts/client.mjs <pet|desktop> [--dev]\n收到：${args.join(' ') || '(空)'}`,
  );
  process.exit(2);
}

const label = kind === 'pet' ? 'ONE 宠物' : 'ONE 桌面端';

/** 本体是不是已经在跑：命名管道连得上就算。 */
function coreIsUp() {
  return new Promise((resolve) => {
    const socket = net.createConnection(PIPE);
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), 1500);
  });
}

async function ensureCore() {
  if (await coreIsUp()) return true;
  if (!existsSync(path.join(repoRoot, CORE_ENTRY))) {
    console.error(`找不到本体入口 ${CORE_ENTRY}，请在仓库根目录运行。`);
    return false;
  }
  const child = spawn(process.execPath, [path.join(repoRoot, CORE_ENTRY)], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await coreIsUp()) return true;
  }
  console.error('本体没有起来，请单独运行 pnpm core 看报错。');
  return false;
}

function portInUse(url) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: hostname, port: Number(port) });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), 1500);
  });
}

async function main() {
  if (!(await ensureCore())) process.exit(1);

  if (dev) {
    if (await portInUse(DEV_URL)) {
      console.error(
        `${DEV_URL} 已被占用，tauri dev 会起不来。\n` +
          '同时开发两个客户端请用已构建的版本：pnpm desktop:build 之后直接 pnpm client:pet / pnpm client:desktop。',
      );
      process.exit(1);
    }
    console.log(`[ONE] 以 tauri dev 启动${label}（热更新）`);
    // 客户端种类走环境变量：Tauri CLI 会把 `--` 之后的参数错位给 cargo。
    run(tauriBin, ['dev'], repoRoot, true, { ONE_CLIENT: kind });
    return;
  }

  if (!existsSync(builtExe)) {
    console.error(
      `还没构建客户端：${path.relative(repoRoot, builtExe)} 不存在。\n` +
        '先运行 pnpm desktop:build，或者用 pnpm ' +
        (kind === 'pet' ? 'pet:dev' : 'desktop:dev') +
        ' 直接以热更新方式启动。',
    );
    process.exit(1);
  }
  console.log(`[ONE] 启动${label}：${path.relative(repoRoot, builtExe)}`);
  run(builtExe, [`--client=${kind}`], repoRoot, false, { ONE_CLIENT: kind });
}

/** pnpm 在 Windows 上是 .cmd，必须走 shell；直接跑二进制则不需要。 */
function run(command, args, cwd, viaShell, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: viaShell,
    env: { ...process.env, ...env },
  });
  if (result.error) {
    console.error(`[ONE] 启动失败：${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

main();
