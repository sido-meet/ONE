import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isProviderId } from '../../packages/contracts/src/wire.ts';
import type { ProviderId } from '../../packages/contracts/src/index.ts';

/**
 * 本体持有的**安装清单**（ADR-016 第 2 条：「本体持有安装清单，负责启动、停止与
 * 重连」）。
 *
 * 0.1 还没有安装器，最早用环境变量 `ONE_INSTALLED` 顶替。问题出在双击启动上：
 * 从开始菜单或资源管理器打开时根本没有环境变量，于是清单只剩 `pet`，日历与笔记
 * **压根没被装上** —— 用户得先开一个终端、把三个 id 敲进去，才能看见日历。
 * 那不是「启动慢了一步」，是产品在要求用户替自己做安装。
 *
 * 所以清单落成一份**文件**，放在本地提供方自己的数据目录里 —— ONE 的本地数据
 * 都在那一个地方（`.one/data`，可用 `ONE_DATA_DIR` 改）。环境变量不再是清单的
 * 载体，只是给验收脚本与临时覆盖用的最高优先级。
 *
 * 优先级从高到低：
 *
 * 1. `ONE_INSTALLED` —— 显式覆盖。空字符串不算「设了」，否则清空变量反而装不上东西。
 * 2. `<dataDir>/installed.json`
 * 3. 都没有 → 只装宠物。这是「干净机器第一次打开」的样子，也保住了 D03 要验的
 *    「未安装」这一态。
 *
 * 清单是磁盘上的输入，按**敌意**读：坏 JSON、写成对象而不是数组、夹着不认识的
 * id —— 一律当作没写，而不是把整个本体带崩。没写的文件也不是错，那叫「还没装」。
 */

export const INSTALLED_FILE = 'installed.json';

/**
 * 清单里出现的提供方必须都是认识的；不认识的那条丢掉，其余照用。
 *
 * **`pet` 先无条件放进去。** 宠物不是插件，是本体自己的脸 —— 写一份 `[]` 或者
 * 一份形状不对的 JSON，都不该把界面弄没。形状不对就当「没写」，与文件不存在
 * 同一条路。
 */
function sanitize(raw: unknown): ProviderId[] {
  const seen = new Set<ProviderId>(['pet']);
  if (Array.isArray(raw))
    for (const item of raw)
      if (typeof item === 'string' && isProviderId(item)) seen.add(item);
  // 顺序固定下来，日志与名册每次都一样，便于比对两次启动的差异。
  return [...seen].sort();
}

export function readInstalled(
  dataDir: string,
  env: string | undefined = process.env.ONE_INSTALLED,
  fallback: ProviderId[] = ['pet'],
): ProviderId[] {
  const raw = env?.trim();
  if (raw) return sanitize(raw.split(',').map((item) => item.trim()));
  const file = path.join(dataDir, INSTALLED_FILE);
  try {
    return sanitize(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    // 文件不存在是「还没装过」，读坏了是「这份清单不能用」。都按没装处理，
    // 但两者不该说成同一句话 —— 调用方分得清就分清。
    return fallback;
  }
}

/** 写清单。改名是原子的：读者要么看到旧的完整内容，要么看到新的完整内容。 */
export function writeInstalled(
  dataDir: string,
  ids: ProviderId[],
): ProviderId[] {
  const next = sanitize(ids);
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, INSTALLED_FILE);
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
  return next;
}

/** 装上。已经在装的不报错 —— 重复安装是幂等的，不是冲突。 */
export function addInstalled(dataDir: string, ids: ProviderId[]): ProviderId[] {
  const current = readInstalled(dataDir, undefined, ['pet']);
  return writeInstalled(dataDir, [...current, ...ids]);
}

/** 卸掉。`pet` 卸不掉 —— 它不是插件，是本体自己的脸。 */
export function removeInstalled(
  dataDir: string,
  ids: ProviderId[],
): ProviderId[] {
  const drop = new Set(ids);
  drop.delete('pet');
  const current = readInstalled(dataDir, undefined, ['pet']);
  return writeInstalled(
    dataDir,
    current.filter((item) => !drop.has(item)),
  );
}
