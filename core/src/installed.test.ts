import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INSTALLED_FILE, readInstalled, writeInstalled } from './installed.ts';

/**
 * 安装清单是本体**持有**的东西（ADR-016 第 2 条）。
 *
 * 这组用例钉的是它为什么存在：清单曾经只由环境变量携带，于是从开始菜单或资源
 * 管理器双击启动时清单里什么都不剩，用户得先开一个终端敲一遍 `ONE_INSTALLED`
 * 才看得到日历。那不是慢了一步，是产品要求用户替自己做安装。
 *
 * 所以最重要的一条是：**没有环境变量时，也要能读出装了什么。**
 */

const scratch = () => mkdtempSync(path.join(tmpdir(), 'one-installed-'));

describe('本体持有的安装清单', () => {
  it('没有环境变量时也从文件里读得出装了什么', () => {
    const dir = scratch();
    writeInstalled(dir, ['pet', 'local.calendar', 'local.notes']);
    expect(readInstalled(dir, undefined)).toEqual([
      'local.calendar',
      'local.notes',
      'pet',
    ]);
  });

  it('环境变量优先于文件 —— 它是给验收脚本用的显式覆盖', () => {
    const dir = scratch();
    writeInstalled(dir, ['pet', 'local.notes']);
    expect(readInstalled(dir, 'pet,local.calendar')).toEqual([
      'local.calendar',
      'pet',
    ]);
  });

  it('空环境变量不算「设了」', () => {
    // 清空变量是为了回到默认，不是为了「什么都不装」——后者会把界面也弄没。
    const dir = scratch();
    writeInstalled(dir, ['pet', 'local.notes']);
    expect(readInstalled(dir, '   ')).toEqual(['local.notes', 'pet']);
  });

  it('两样都没有时只装宠物，这是干净机器第一次打开的样子', () => {
    // 也保住了 D03 要验的「未安装」这一态：删掉文件就回到它。
    expect(readInstalled(scratch(), undefined)).toEqual(['pet']);
  });

  it('清单是磁盘上的输入，坏内容不能把本体带崩', () => {
    const dir = scratch();
    for (const bad of ['{ 这不是 JSON', '{"installed":[]}', '42', 'null']) {
      writeFileSync(path.join(dir, INSTALLED_FILE), bad, 'utf8');
      expect(readInstalled(dir, undefined)).toEqual(['pet']);
    }
  });

  it('不认识的寻址键丢掉，其余照用', () => {
    const dir = scratch();
    writeFileSync(
      path.join(dir, INSTALLED_FILE),
      JSON.stringify(['pet', 'local.calendar', ' Outlook.Calendar', 42]),
      'utf8',
    );
    expect(readInstalled(dir, undefined)).toEqual(['local.calendar', 'pet']);
  });

  it('`pet` 卸不掉 —— 它是本体自己的脸，不是插件', () => {
    const dir = scratch();
    writeInstalled(dir, ['pet', 'local.notes']);
    expect(writeInstalled(dir, ['local.notes'])).toContain('pet');
  });

  it('写完立刻能读回来，顺序固定', () => {
    const dir = scratch();
    const written = writeInstalled(dir, ['local.notes', 'pet']);
    expect(readInstalled(dir, undefined)).toEqual(written);
    // 两次写法不同也要读出同一份，否则名册与日志每次启动都不一样。
    writeInstalled(dir, ['pet', 'local.notes']);
    expect(readInstalled(dir, undefined)).toEqual(written);
    expect(readFileSync(path.join(dir, INSTALLED_FILE), 'utf8')).toContain(
      '\n',
    );
  });

  it('目录不存在就现建 —— 数据目录第一次用时本来就没有', () => {
    const dir = path.join(scratch(), 'nested', 'data');
    writeInstalled(dir, ['pet', 'local.calendar']);
    expect(readInstalled(dir, undefined)).toEqual(['local.calendar', 'pet']);
  });
});
