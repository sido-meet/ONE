import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClientError } from '../../contracts/src/index.ts';
import { isPagePath, MAX_PAGE_BYTES } from '../../contracts/src/page.ts';
import type { PageResource } from '../../contracts/src/page.ts';

/**
 * 提供方自带的页面（ADR-018）。
 *
 * 插件是两件货，数据接口一份、视图一份；这里是视图那一半。资源从插件自己的目录
 * 里读，读到的文本经本体转给宿主，再由宿主塞进沙箱 iframe —— 插件进程之间从不相
 * 遇，彼此也不知道对方存在。
 *
 * 只有文本资源。0.2 的页面是单文件自包含的：宿主给插件页面的 CSP 是
 * `default-src 'none'`，外部样式、脚本、图片与网络一律加载不到，因此哪怕放开扩展名
 * 也没有页面能用 —— 与其留一个永远走不通的口子，不如明确拒绝。
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/**
 * 一个进程同时是日历与笔记两个身份，各有各的页面目录。**分目录不是整理，是边界**：
 * 共用一个 pages 根的话，笔记身份报的入口会把日历的页面端给笔记窗口，而本体与宿主
 * 都看不出来 —— 它们看到的只是「这个寻址键申报了一个合法入口」。
 */
export function pageRoot(kind: string): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'pages',
    kind,
  );
}

/** 页面只发一份单文件：0.2 的页面不引外部资源，多一个入口就多一份要维护的副本。 */
export const PAGE_ENTRY = 'index.html';

export function readPageResource(
  root: string,
  requested: unknown,
): PageResource {
  if (!isPagePath(requested))
    throw new ClientError('VALIDATION', `页面路径不合法：${String(requested)}`);
  const mime = MIME[path.extname(requested).toLowerCase()];
  if (!mime) throw new ClientError('VALIDATION', '这个插件页面不接受这种资源');
  const full = path.join(root, requested);
  // isPagePath 已经挡住 `..`，这里再确认一次：它是那句守卫失效时唯一的兜底，
  // 而它失效的后果是插件能读到进程够得着的任何文件。
  const inside = path.relative(root, full);
  if (inside.startsWith('..') || path.isAbsolute(inside))
    throw new ClientError('PERMISSION_DENIED', '页面路径越界');
  let content: string;
  try {
    content = fs.readFileSync(full, 'utf8');
  } catch {
    throw new ClientError('NOT_FOUND', `这个插件没有 ${requested}`);
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_PAGE_BYTES)
    throw new ClientError('VALIDATION', '页面太大，装不下');
  return { mime, content };
}
