import os from 'node:os';
import path from 'node:path';

/**
 * **宿主侧**的文件位置。本体与本地提供方共用这一份。
 *
 * 它刻意不住在 `packages/contracts` 里：那份会被前端打包进浏览器，而这里的每
 * 一行都要 `node:os`。同一个应用有两处数据目录是实打实的坑 —— 用户清空一处
 * 发现东西还在，或者「重装」之后旧数据莫名其妙又回来了。跟 `localtime.ts` 收成
 * 一份是同一个理由，只是这次收的是路径。
 *
 * 为什么默认落在用户数据目录而不是程序目录：本体在开发时从仓库跑、发布后从
 * `dist-runtime/` 里跑，两边按自己的位置算出来的「根」不一样。曾经本体因此把
 * 安装清单写进产物目录、提供方把日历写进仓库目录 —— 于是双击启动读不到清单，
 * 用户得先开终端敲一遍环境变量才看得到日历。装到 Program Files 之后更糟：那里
 * 根本不让写。
 *
 * 解析顺序：`ONE_DATA_DIR` 显式覆盖 → 平台用户数据目录。**不猜程序目录** ——
 * 猜出来的位置随启动方式漂移，而漂移是查不出来的那种错。
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ONE_DATA_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(userDataHome(env), 'ONE', 'data');
}

/** 安装清单的完整路径。名字收在这里，免得两处各拼一次。 */
export function installedFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataDir(env), 'installed.json');
}

/**
 * 平台的用户数据根。`APPDATA` 只在 Windows 上有意义；别的平台用 XDG 那一套，
 * 顺手尊重 `XDG_DATA_HOME`，那是 Linux 用户会真的去设的变量。
 */
function userDataHome(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32')
    return env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming');
  return (
    env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share')
  );
}
