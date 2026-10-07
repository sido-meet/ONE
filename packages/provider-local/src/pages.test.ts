import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { ClientError } from '../../contracts/src/index.ts';
import { PAGE_DOMAIN_COMMANDS } from '../../contracts/src/page.ts';
import { PAGE_ENTRY, pageRoot, readPageResource } from './pages.ts';

/**
 * 提供方交出页面资源这一段（ADR-018）。
 *
 * 这里的守卫是"页面能读到什么"的最后一道：路径由提供方自己给，但先要过守卫，
 * 否则一个坏插件就能借 one-plugin:// 把进程够得着的文件端出去。
 */

function withPages(files: Record<string, string>, run: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-pages-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), content, 'utf8');
  }
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 把页面里的纯函数抠出来在 Node 里跑。
 *
 * 页面必须自包含（单文件、无外链，CSP `default-src 'none'`），这几个换算函数没法
 * import 进来，只能从 HTML 里求值。抠的是**行为**不是文本：函数体怎么改都照跑，
 * 抠不出来时这里直接抛，测试不会变成一句悄悄跳过的空话。
 */
function loadPageFunction(kind: 'calendar' | 'notes', name: string) {
  const html = readPageResource(pageRoot(kind), PAGE_ENTRY).content;
  const source = (target: string): string => {
    const start = html.indexOf(`function ${target}(`);
    if (start < 0) throw new Error(`页面里找不到 ${target}`);
    let depth = 0;
    let at = html.indexOf('{', start);
    for (; at < html.length; at += 1) {
      if (html[at] === '{') depth += 1;
      else if (html[at] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    return html.slice(start, at + 1);
  };
  // toInstant 调 wallClock，一起带上，免得求值时 ReferenceError 变成看不懂的失败。
  const prelude = html.includes('function wallClock(')
    ? source('wallClock')
    : '';
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${prelude}\n${source(name)}\nreturn ${name};`)() as (
    value: string,
  ) => string;
}

describe('日历页的时间换算', () => {
  const toInstant = loadPageFunction('calendar', 'toInstant');
  const toLocalInput = loadPageFunction('calendar', 'toLocalInput');

  it('填进去的时刻就是存下来的时刻，不差一个时区', () => {
    // datetime-local 填的是本地钟面，接口要的是带偏移的 RFC3339，两者指同一瞬间。
    // 实机抓到过的错：拿 toISOString()（UTC 钟面）配上本地偏移，填 18:01 存成
    // 10:01+08:00，事件落到 8 小时前，列表里根本看不见。这里比的是**瞬间**而不是
    // 字符串，免得测试跟着机器时区走。
    for (const local of [
      '2026-10-07T18:01',
      '2026-03-30T01:30',
      '2026-07-01T09:00',
    ]) {
      expect(new Date(toInstant(local)).getTime()).toBe(
        new Date(local).getTime(),
      );
    }
  });

  it('接口给的时刻能原样填回输入框，再存回去还是那一刻', () => {
    for (const instant of [
      '2026-10-07T17:42:00+08:00',
      '2026-10-07T09:42:00Z',
      '2026-12-31T23:59:00+08:00',
    ]) {
      const round = toInstant(toLocalInput(instant));
      expect(new Date(round).getTime()).toBe(new Date(instant).getTime());
    }
  });

  it('认不出时间的就说认不出，不给一个假时刻', () => {
    // 默认参数在这里是个陷阱：空值会一路走进 Date 变成 Invalid Date，
    // 静默存进去一个坏时刻比报错难查得多。
    expect(() => toInstant('')).toThrow(/时间格式/);
    expect(() => toInstant('不是时间')).toThrow(/时间格式/);
  });
});

describe('提供方的页面资源', () => {
  it('按类型读回文本，并带上正确的 mime', () => {
    withPages({ 'index.html': '<h1>你好</h1>' }, (root) => {
      const resource = readPageResource(root, 'index.html');
      expect(resource).toEqual({
        mime: 'text/html; charset=utf-8',
        content: '<h1>你好</h1>',
      });
    });
  });

  it('挡住目录穿越、绝对路径与反斜杠', () => {
    withPages({ 'index.html': 'x', 'secrets.txt': '不该被读到' }, (root) => {
      for (const bad of [
        '../secrets.txt',
        'a/../../secrets.txt',
        '..\\secrets.txt',
        'C:/secrets.txt',
        '/etc/passwd',
        '',
      ]) {
        expect(() => readPageResource(root, bad)).toThrow(ClientError);
      }
      // 读不到的文件说的是"没这个文件"，不是"路径不合法" —— 前者能补，后者不能。
      expect(() => readPageResource(root, 'missing.html')).toThrow(/没有/);
    });
  });

  it('不接受清单以外的资源类型', () => {
    withPages({ 'index.html': 'x', 'data.json': '{}' }, (root) => {
      expect(() => readPageResource(root, 'data.json')).toThrow(/不接受/);
    });
  });

  it('一个身份读不到另一个身份的页面', () => {
    // 实机抓到的串页：两个身份共用一个 pages 根时，向 local.notes 要
    // calendar.html 会把日历的页面原样端出来，而本体与宿主都看不出来。
    expect(readPageResource(pageRoot('notes'), PAGE_ENTRY).content).toContain(
      '本地笔记',
    );
    expect(() => readPageResource(pageRoot('notes'), 'calendar.html')).toThrow(
      /没有/,
    );
    expect(() => readPageResource(pageRoot('calendar'), 'notes.html')).toThrow(
      /没有/,
    );
  });

  it('随包发布的两个页面都真的存在，而且不引用外部资源', () => {
    for (const kind of ['calendar', 'notes']) {
      const resource = readPageResource(pageRoot(kind), PAGE_ENTRY);
      expect(resource.content).toContain('<!doctype html>');
      // 页面必须自包含：外部资源在 default-src 'none' 下一律加载不到，
      // 留一个引用只会让人以为它能用。
      expect(resource.content).not.toMatch(/<link[^>]+href=/);
      expect(resource.content).not.toMatch(/<script[^>]+src=/);
      expect(resource.content).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it('页面用满本域能力，且不越界调用别的域', () => {
    // 0.1 验收要求日历能查看、改期、删除，而契约里那三条能力一直都在 ——
    // 页面上没有入口，能力就等于不存在。这条断言把那三个入口变成机器查得到的，
    // 免得「改期」在某次改页面时被人顺手删掉而没人发现。
    const asked = (kind: 'calendar' | 'notes') =>
      [
        // 同一个能力可能出现在多处（保存与覆盖各一次），比的是「有没有」不是「几次」
        ...new Set(
          [
            ...readPageResource(pageRoot(kind), PAGE_ENTRY).content.matchAll(
              /ask\('([a-z]+\.[a-z]+)'/g,
            ),
          ].map((match) => match[1]),
        ),
      ].sort();

    for (const kind of ['calendar', 'notes'] as const) {
      const mine = Object.keys(PAGE_DOMAIN_COMMANDS)
        .filter((capability) => capability.startsWith(`${kind}.`))
        .sort();
      // 完全相等同时管住两头：少一个就是「验收脚本要的入口没了」，多一个就是
      // 「这个页面在动别的域的能力」—— 本体不会拦，那等于让日历页穿透日历的授权。
      expect(asked(kind)).toEqual(mine);
    }
  });

  it('页面里没有表单：沙箱会静默挡掉提交', () => {
    // 实机抓到的：页面跑在 `sandbox="allow-scripts"` 的 iframe 里，没给 `allow-forms`，
    // 浏览器会在触发 `submit` 事件**之前**就把表单提交挡掉 —— 按钮点下去毫无反应，
    // 控制台也不报错。于是「加入日程」「记下来」两个入口看着是好的，实际从来没成功过。
    //
    // 这条钉的是**为什么不能用 form**：页面唯一的出口是 postMessage，导航语义它既没有
    // 也不该有，所以提交必须走显式按钮（ADR-018）。谁哪天把 `<form>` 加回来，
    // 这里会红。
    for (const kind of ['calendar', 'notes'] as const) {
      const html = readPageResource(pageRoot(kind), PAGE_ENTRY).content;
      // 先剥注释：页面里正写着「这里刻意不是 `<form>`」，连注释一起断言就是自己告自己。
      const markup = html.replace(/<!--[\s\S]*?-->/g, '');
      expect(markup).not.toMatch(/<form[\s>]/i);
      expect(markup).not.toMatch(/type\s*=\s*["']?submit/i);
      // 提交按钮还在，只是换成了显式点击 —— 别把这条当成「顺手删掉新建功能」。
      expect(markup).toMatch(/id="create"/);
    }
  });

  it('改期与删除都带着版本号，不是无条件覆盖', () => {
    // 无条件覆盖会让别人的改动在用户看不见的地方消失。要挡住的是那条路，
    // 所以断言的是「每一处改动都带着 expectedVersion」。
    for (const kind of ['calendar', 'notes'] as const) {
      const html = readPageResource(pageRoot(kind), PAGE_ENTRY).content;
      const writes = [
        ...html.matchAll(/ask\('(?:calendar|notes)\.(?:update|remove)'/g),
      ];
      expect(writes.length).toBeGreaterThan(0);
      // update 出现两次（保存与覆盖）、remove 一次，三处都要带版本号。
      expect((html.match(/expectedVersion:/g) ?? []).length).toBe(
        writes.length,
      );
    }
  });
});
