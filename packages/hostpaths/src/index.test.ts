import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dataDir, installedFile } from './index.ts';

/**
 * 本体与提供方**必须算出同一个目录**。
 *
 * 这一组钉的就是那件事。曾经两边各按自己的位置算根：本体从 `dist-runtime/` 跑，
 * 本体把安装清单写进产物目录；提供方从仓库跑，把日历写进仓库目录。同一份日历和
 * 同一份清单因此分了两处 —— 而从开始菜单双击启动的本体哪个都读不到，用户只能先
 * 开终端敲一遍环境变量。
 */

const env = (extra: Record<string, string | undefined>) =>
  extra as NodeJS.ProcessEnv;

describe('本地数据目录', () => {
  it('显式覆盖优先', () => {
    expect(dataDir(env({ ONE_DATA_DIR: 'D:/somewhere/data' }))).toBe(
      path.resolve('D:/somewhere/data'),
    );
  });

  it('默认落在用户数据目录下，不落在程序目录', () => {
    // 装到 Program Files 之后那里根本不让写 —— 落在程序目录等于「装完就用不了」。
    const dir = dataDir(env({}));
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir).toContain(path.join('ONE', 'data'));
    expect(dir.startsWith(os.homedir()) || dir.includes('AppData')).toBe(true);
  });

  it('没有覆盖时，本体与提供方算出的是同一个', () => {
    // 这条是整件事的理由：两边都调这一个函数，同一份环境自然同一处。
    expect(dataDir(env({}))).toBe(dataDir(env({})));
  });

  it('空覆盖当作没设 —— 清空变量是为了回到默认', () => {
    expect(dataDir(env({ ONE_DATA_DIR: '   ' }))).toBe(dataDir(env({})));
  });

  it('清单路径从同一个目录拼出来', () => {
    const over = env({ ONE_DATA_DIR: 'D:/x' });
    expect(installedFile(over)).toBe(
      path.join(path.resolve('D:/x'), 'installed.json'),
    );
    expect(path.dirname(installedFile(env({})))).toBe(dataDir(env({})));
  });
});
