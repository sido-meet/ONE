// 准备本体的可分发产物（路线 R02，ADR-021）。
//
// 本体是 TypeScript 源码，靠 Node 22 的 strip-only 直接跑。好消息是它**零第三方
// 依赖** —— 只 import `node:` 内置模块，所以这里不需要 bundler，只要把 Node 运行时
// 本身和源码一起放到发布目录里。
//
// 产物的形状刻意保持朴素：`dist-runtime/` 下是 node.exe 加一份 core 源码，清单写明
// 两者各是什么。壳启动它时不需要猜，也不需要在运行时探测。
//
// 为什么不下载官方 zip：开发机上本来就有一个装好的 node，把它复制过来即可。版本
// 记进清单，用户能看见自己跑的是哪个 Node；真正分发时再用官方 zip 替换同一个位置
// 即可，脚本的其余部分不用动。

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const outDir = path.join(repoRoot, 'dist-runtime');
const coreDir = path.join(repoRoot, 'core');
const packagesDir = path.join(repoRoot, 'packages');

/** 本体运行时会读源码的目录。少一个就起不来，因此清单里逐个记下来。 */
const NEEDED = [
  { from: coreDir, to: 'core' },
  // contracts 与 mock-runtime 是本体 import 的（相对路径），不带走就找不到类型与端口。
  { from: path.join(packagesDir, 'contracts'), to: 'packages/contracts' },
  { from: path.join(packagesDir, 'mock-runtime'), to: 'packages/mock-runtime' },
  // hostpaths 是本体与本地提供方共用的路径解析。少了它本体连启动都做不到 ——
  // 它在 import 图上，离了这份清单就是一个第一次启动就报 ERR_MODULE_NOT_FOUND 的包。
  { from: path.join(packagesDir, 'hostpaths'), to: 'packages/hostpaths' },
  // conversation 是**唯一**的会话状态机（ADR-028）。本体用它，测试与开发用它，
  // 模拟运行时只是往里塞一个 Agent —— 少了它，本体第一次起对话就找不到模块。
  { from: path.join(packagesDir, 'conversation'), to: 'packages/conversation' },
  // sqlite 是本体与本地提供方共用的 pragma 与事务助手（ADR-028）。两个库的配置必须
  // 一致，分开写迟早漂；它在 import 图上，少了它本体第一次开库就找不到模块。
  { from: path.join(packagesDir, 'sqlite'), to: 'packages/sqlite' },
  // provider-local 随包走（ADR-030）。不带走它，发布出去的本体起得来、日历与笔记
  // 却永远不接上，用户只看到「装了没运行」；而它要跑起来就**不能**再回头去找系统
  // node —— 本体拉子进程用的是自己那个随包 node.exe（ADR-021），所以这份源码必须
  // 就在产物里。它的 import 只有 contracts / hostpaths / sqlite 与 node: 内置模块，
  // 上头四条已经齐了。
  {
    from: path.join(packagesDir, 'provider-local'),
    to: 'packages/provider-local',
  },
];

/** 测试文件不带：发布产物里不需要 vitest，也省得让人以为本体依赖它。 */
const EXCLUDE = /(\.test\.ts$)|(node_modules)|(^\.git)/;

function copyTree(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(from, source);
      return relative === '' || !EXCLUDE.test(relative);
    },
  });
}

mkdirSync(outDir, { recursive: true });

const nodeExe = process.execPath;
try {
  cpSync(nodeExe, path.join(outDir, 'node.exe'));
} catch (cause) {
  // 上一轮起着的本体正锁着这个文件。这是这里唯一会真的失败的常见原因，
  // 而原始报错是一坨 ENOENT/EIO 栈，用户看不出该做什么（ADR-021 同一条纪律）。
  if (
    cause?.code === 'EPERM' ||
    cause?.code === 'EACCES' ||
    cause?.code === 'EIO'
  ) {
    process.stderr.write(
      '打包失败：dist-runtime\\node.exe 正被占用 —— 上一轮起着的 ONE 本体还在跑。\n' +
        '先关掉宠物窗口（或执行 Stop-Process -Name one-desktop -Force），再重新打包。\n',
    );
    process.exit(1);
  }
  throw cause;
}

for (const { from, to } of NEEDED) {
  copyTree(from, path.join(outDir, to));
}

/**
 * 清单是壳的**唯一**依据：它据此判断「这是不是一个可用的本体产物」。
 * 记下 node 的版本与校验和，是为了让用户能回答「我跑的是哪个 Node」。
 */
const manifest = {
  version: JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    .version,
  node: process.version,
  nodeExe: 'node.exe',
  /** 本体入口，相对产物根。壳据此拼出完整路径。 */
  entry: 'core/src/index.ts',
  nodeSha256: createHash('sha256').update(readFileSync(nodeExe)).digest('hex'),
  builtAt: new Date().toISOString(),
};
writeFileSync(
  path.join(outDir, 'core-runtime.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

// 输出走 stdout 时中文会被 PowerShell 按 GBK 解释，所以只报数字。
process.stdout.write(
  `core runtime packaged: node ${manifest.node}, entry ${manifest.entry}\n`,
);

/**
 * 顺手装到 exe 旁边。**这一步以前是一条人记的命令，而它记错了。**
 *
 * 原来是 `Copy-Item dist-runtime src-tauri\target\release\dist-runtime -Recurse -Force`。
 * 目标目录已存在时，PowerShell 的行为是**把源套进去**（变成
 * `dist-runtime\dist-runtime\…`），而不是合并 —— 于是真正给 exe 用的那份一直停在
 * 旧版本，而 `Test-Path` 说它存在，exe 照跑不误。
 *
 * **这个错法比跑不起来糟得多**：程序正常启动、界面正常显示，只是跑的是旧代码。
 * 实机验收会「验证」一份根本不是刚才改的那份产物，而且看不出任何异常。
 * （真要找出来：改完本体后壳的日志里没有新加的那行，而手跑仓库源码有。）
 *
 * 所以这一步收进脚本：少一条命令就少一个能记错的地方。
 */
const installDir = process.argv[2]
  ? path.resolve(repoRoot, process.argv[2])
  : null;
if (installDir) {
  // 整目录换掉而不是覆盖合并：覆盖合并会把**已删掉**的文件留在产物里，而那正是
  // 「源码里没有、产物里还在」这类幽灵的来处。
  const parked = `${installDir}.old`;
  try {
    renameSync(installDir, parked);
  } catch {
    // 上一轮起着的 ONE 正锁着里面的 node.exe。parked 动不了就退而覆盖合并，
    // 并把这件事说出来 —— 静默降级等于把上面那个坑原样留下。
    process.stderr.write(
      `装到 ${installDir} 失败（多半是 ONE 还在跑），改为就地覆盖。\n`,
    );
  }
  cpSync(outDir, installDir, { recursive: true, force: true });
  if (existsSync(parked)) rmSync(parked, { recursive: true, force: true });
  process.stdout.write(`core runtime installed to ${installDir}\n`);
}
