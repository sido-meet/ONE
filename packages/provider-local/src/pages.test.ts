import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { ClientError } from '../../contracts/src/index.ts';
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
});
