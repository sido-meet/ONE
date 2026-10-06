/**
 * 插件自带页面的契约（ADR-018）。
 *
 * 插件是两件货：一份能被本体调用的数据接口，和一份自带 HTML 视图。这一层描述
 * 的只是**两边怎么说话**：页面怎么向宿主要数据、宿主怎么把页面要的能力交给本体。
 *
 * 三条约束决定了这里的形状：
 *
 * 1. 页面跑在不透明来源里（iframe 只给 `allow-scripts`，没有 `allow-same-origin`），
 *    所以 `event.origin` 是 `null`，路由只能靠 iframe 自己的句柄，不能靠页面自报
 *    的身份。页面因此**没有** provider 字段可填 —— 它说了也不算数。
 * 2. 页面拿不到套接字、文件与网络。它唯一的出口是 `postMessage`，宿主收到后转给
 *    本体，由本体裁决完才回数据。
 * 3. 页面要数据时用**能力名**（`calendar.list`）而不是本体命令名。能力名只说做什
 *    么、不带实现前缀（ADR-017），插件因此不必知道 ONE 内部把 remove 叫成 delete。
 */

/** 宿主与页面之间的消息协议标记。两侧都要对得上，否则当成不是自己人的消息丢掉。 */
export const PAGE_PROTOCOL = 'one.plugin.v1';

/**
 * 提供方用它交出自己的页面资源。能力名同样不带实现前缀：宿主按寻址键找提供方，
 * 不按"哪个进程会写这个能力"。
 */
export const PAGE_READ_CAPABILITY = 'page.read';

/** 一个页面入口的相对地址，如 `index.html` 或 `views/day.html`。 */
export interface PluginView {
  entry: string;
}

/** 页面资源是文本，一次上限按此算；超了就是提供方的问题，不是宿主的。 */
export const MAX_PAGE_BYTES = 512 * 1024;
const MAX_ENTRY_LENGTH = 128;

/**
 * 页面路径只允许「相对、无 `..`、无反斜杠」。这条守卫挡的是目录穿越：`one-plugin`
 * 的资源由提供方给，而提供方给的路径如果允许 `..`，一个坏插件就能读到它进程能读
 * 的任何文件，再通过页面显示出来。
 */
const SAFE_PATH = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;

export function isPagePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!value || value.length > MAX_ENTRY_LENGTH) return false;
  if (value.includes('..') || value.includes('\\')) return false;
  if (value.startsWith('/') || value.endsWith('/')) return false;
  return SAFE_PATH.test(value);
}

/** Untrusted input: a malformed entry is rejected, not repaired. */
export function parsePluginView(value: unknown): PluginView | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const entry = (value as Record<string, unknown>).entry;
  return isPagePath(entry) ? { entry } : null;
}

/** 提供方交回来的一个页面资源。`content` 是文本，界面资源不进 0.2。 */
export interface PageResource {
  mime: string;
  content: string;
}

/**
 * 页面要调用能力时，宿主把它换成本体命令。**不是**把能力名直接丢给本体转发 ——
 * 领域输入必须在本体边界校验一次（ADR-016），而能力转发那条路不做解析。
 *
 * 映射写死在这里而不是拼字符串：`calendar.remove` 对应的命令是 `calendarDelete`，
 * 靠改写字符串得到的是另一个不存在的命令。
 */
export const PAGE_DOMAIN_COMMANDS = {
  'calendar.list': 'calendarList',
  'calendar.create': 'calendarCreate',
  'calendar.update': 'calendarUpdate',
  'calendar.remove': 'calendarDelete',
  'notes.list': 'notesList',
  'notes.create': 'notesCreate',
  'notes.update': 'notesUpdate',
  'notes.remove': 'notesDelete',
} as const;

export type PageCapability = keyof typeof PAGE_DOMAIN_COMMANDS;

export function isPageCapability(value: unknown): value is PageCapability {
  return typeof value === 'string' && value in PAGE_DOMAIN_COMMANDS;
}

/** 页面 → 宿主。id 由页面自己生成，宿主原样带回，不解释也不合并。 */
export interface PageRequest {
  protocol: typeof PAGE_PROTOCOL;
  id: string;
  capability: PageCapability;
  args: unknown;
}

export type PageResponse =
  | {
      protocol: typeof PAGE_PROTOCOL;
      id: string;
      ok: true;
      value: unknown;
    }
  | { protocol: typeof PAGE_PROTOCOL; id: string; ok: false; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 消息来自一个不透明的第三方页面，因此**一律当不可信输入解析**：协议标记不对、
 * 能力名不在白名单、id 不是字符串，都直接丢，不做尽力而为的修补。
 */
export function parsePageRequest(value: unknown): PageRequest | null {
  if (!isRecord(value)) return null;
  if (value.protocol !== PAGE_PROTOCOL) return null;
  if (typeof value.id !== 'string' || !value.id) return null;
  if (!isPageCapability(value.capability)) return null;
  return {
    protocol: PAGE_PROTOCOL,
    id: value.id,
    capability: value.capability,
    args: value.args,
  };
}

export function parsePageResponse(value: unknown): PageResponse | null {
  if (!isRecord(value)) return null;
  if (value.protocol !== PAGE_PROTOCOL) return null;
  if (typeof value.id !== 'string' || !value.id) return null;
  if (typeof value.ok !== 'boolean') return null;
  if (value.ok) {
    return {
      protocol: PAGE_PROTOCOL,
      id: value.id,
      ok: true,
      value: value.value,
    };
  }
  if (typeof value.message !== 'string') return null;
  return {
    protocol: PAGE_PROTOCOL,
    id: value.id,
    ok: false,
    message: value.message.slice(0, 200),
  };
}

/**
 * 插件页面的地址前缀，由壳按平台给出。
 *
 * Windows 上 WebView2 不认非标准协议，wry 的做法是拦截 `http://one-plugin.` 开头的
 * 请求，把它还原成 `one-plugin://localhost/...` 再交给协议处理器（见 wry 的
 * `custom_protocol_workaround`）。**必须直接写改写后的形式**：iframe 里的
 * `one-plugin://` 原地址走的是资源请求，匹配不上那个前缀，于是压根到不了处理器 ——
 * 实机表现是窗口开着、标题正确、内容一片空白。
 *
 * 所以这个前缀不是页面的事，是宿主的事：壳知道自己在哪个平台上。
 */
export const PLUGIN_SCHEME = 'one-plugin';

export function pluginPageUrl(
  base: string,
  provider: string,
  entry: string,
): string {
  return `${base}/${provider}/${entry}`;
}
