import { ClientError } from '../../packages/contracts/src/errors.ts';
import type {
  CalendarEvent,
  CalendarPage,
  CommandContext,
  DomainKind,
  NotePage,
  ProviderUnavailableReason,
  Snapshot,
} from '../../packages/contracts/src/index.ts';
import { DOMAIN_LABELS } from '../../packages/contracts/src/provider.ts';

/**
 * 宠物上方摘要条的模型（ADR-018）。
 *
 * 摘要条只有一件正经事：**把今天有什么说清楚，并且说清楚它凭什么这么说**。
 * 因此每一条都带三样东西：本体状态版本号、取回时刻、以及数据是哪来的。
 *
 * 四种缺席必须分开说（ADR-016）：没安装、装了没运行、没授权、版本对不上，
 * 用户该做的事完全不同 —— 前者要去装，后者去看进程。D05 的完成标准里
 * 「装了没运行时不拿旧缓存冒充今天」就是这条：取不到就说取不到，
 * 不用上一次的结果假装今天没事。
 *
 * 这一层是纯模型：不 import 壳、不 import 运行时，视图只负责画。
 */

export type DomainStatus =
  | 'ready'
  | 'not-installed'
  | 'not-running'
  | 'not-authorized'
  | 'version-conflict'
  /** 本体没接上：不是插件的问题，别让用户去重装插件。 */
  | 'offline';

export interface DomainLine {
  kind: DomainKind;
  status: DomainStatus;
  /** 一句话，用户据此决定下一步。 */
  message: string;
  /** 没安装时的引导：0.2 的装法就是把寻址键写进 ONE_INSTALLED。 */
  hint?: string;
  /** 自带页面的插件，按钮才可点。 */
  pageProvider?: string;
}

export interface DomainReading<T> {
  line: DomainLine;
  /** 取不到时是 undefined —— 界面据此不画列表，而不是画一个空的。 */
  data?: T;
  /** 取回时刻。界面上要写出来：一份摘要不告诉你什么时候拿的，就没法判断它新不新。 */
  fetchedAt: Date;
}

/** 没安装是唯一一种「用户得动手去装」的缺席，因此只有它带引导。 */
const INSTALL_HINT =
  '把 local.calendar / local.notes 写进环境变量 ONE_INSTALLED，然后重启 ONE';

/**
 * 四种缺席各有一句话，模板只作兜底：本体自己会说得更具体
 * （「缺少授权：calendar.read、calendar.write」），摘要条直接把那句话端出来。
 * 没端到才用这里的模板 —— 模板不带细节，细节只在本体那边。
 */
const STATUS_MESSAGE: Record<
  ProviderUnavailableReason,
  (kind: DomainKind) => string
> = {
  'not-installed': (kind) => `还没有接${DOMAIN_LABELS[kind]}源`,
  'not-running': (kind) => `${DOMAIN_LABELS[kind]}源没有连上`,
  'not-authorized': (kind) => `${DOMAIN_LABELS[kind]}源缺少授权`,
  'version-conflict': (kind) => `${DOMAIN_LABELS[kind]}源版本对不上`,
};

const REASONS: readonly ProviderUnavailableReason[] = [
  'not-installed',
  'not-running',
  'not-authorized',
  'version-conflict',
];

/** Untrusted input: a reason we don't know is not a reason we may guess at. */
function reasonOf(cause: unknown): ProviderUnavailableReason | null {
  if (!(cause instanceof ClientError)) return null;
  const problem = cause.details?.providerProblem as
    { kind?: DomainKind; reason?: string } | undefined;
  const reason = problem?.reason;
  return typeof reason === 'string' &&
    REASONS.includes(reason as ProviderUnavailableReason)
    ? (reason as ProviderUnavailableReason)
    : null;
}

/**
 * 一次领域调用失败之后，摘要条该怎么说。
 *
 * 本体没连上与提供方不在场是两件事：前者是自己的问题（"ONE 本体未连接"），
 * 后者才是插件的问题。混成一句话，用户会以为要重装插件。
 */
export function describeDomainFailure(
  kind: DomainKind,
  cause: unknown,
): DomainLine {
  const reason = reasonOf(cause);
  if (!reason) {
    return {
      kind,
      status: 'offline',
      message:
        cause instanceof Error && cause.message
          ? `ONE 本体没接上：${cause.message}`
          : 'ONE 本体没接上',
    };
  }
  const said = cause instanceof ClientError ? cause.message.trim() : '';
  return {
    kind,
    status: reason,
    message: said || STATUS_MESSAGE[reason](kind),
    ...(reason === 'not-installed' ? { hint: INSTALL_HINT } : {}),
  };
}

/**
 * 取一次并记账。失败不吞，也不返回空列表 —— 空列表会被读成"今天没有日程"，
 * 而真相是"没取到"。调用方拿到的是 line.status='offline' 与一份 undefined 数据。
 */
export async function readDomain<T>(
  kind: DomainKind,
  read: () => Promise<T>,
  options: { pageProvider?: string; now?: Date } = {},
): Promise<DomainReading<T>> {
  const now = options.now ?? new Date();
  const pageProvider = options.pageProvider;
  try {
    const data = await read();
    return {
      line: {
        kind,
        status: 'ready',
        message: '',
        ...(pageProvider ? { pageProvider } : {}),
      },
      data,
      fetchedAt: now,
    };
  } catch (cause) {
    const line = describeDomainFailure(kind, cause);
    return {
      // 取数失败时仍带上 pageProvider：插件刚才还在名册里，窗口可能已经开着，
      // 用户回去看一眼比重新装一个有用。
      line: pageProvider ? { ...line, pageProvider } : line,
      fetchedAt: now,
    };
  }
}

/** 今天这一天的边界，按本地时区算：摘要说的是"今天"，不是 UTC 的今天。 */
export function todayRange(now: Date): {
  rangeStart: string;
  rangeEnd: string;
  timeZone: string;
} {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    rangeStart: withOffset(start),
    rangeEnd: withOffset(end),
    timeZone: timeZoneOf(now),
  };
}

/**
 * 本地时间转带偏移的 RFC3339：带偏移才不会被误读成 UTC 的那一刻。
 *
 * 必须取**本地时钟**的年月日时分秒再拼偏移，不能拿 `toISOString()` 顶替 ——
 * 那是 UTC 的钟面：东八区 10:00 会被写成 `02:00+08:00`，于是「今天」的
 * 整段边界凭空挪了 8 小时，查出来是凌晨的日程（实机写测试时抓到的）。
 */
export function withOffset(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const pad = (value: number) => String(Math.abs(value)).padStart(2, '0');
  // 先把时间戳平移到本地时区，再取它的 ISO 分量：分量这时就是本地钟面。
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return `${local.toISOString().slice(0, 19)}${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`;
}

export function timeZoneOf(now: Date): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

/**
 * 钟点。刻意不用 toLocaleTimeString：那一串随运行环境的 ICU 数据变，
 * 摘要条上的时间必须是「这台机器本地时间」这一个确定答案。
 */
export function clockOf(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 收窄成一条能放进摘要条的话。收窄在这里做，视图只负责画：
 * 排版规则混进视图里，展开面板与摘要条就会各写一份，然后慢慢走偏。
 */
export function oneLineOf(page: CalendarPage, now: Date): string {
  const items = page.items ?? [];
  if (!items.length) return '今天没有日程';
  const nowMs = now.getTime();
  const next = items.find(
    (item: CalendarEvent) => new Date(item.startsAt).getTime() >= nowMs,
  );
  // 接下来的一件；全都过去了就退回最早的那一件 —— 摘要条不能空着。
  const head = next ?? items[0]!;
  const rest = items.length - 1;
  return `${clockOf(new Date(head.startsAt))} ${head.title}${
    rest > 0 ? ` 等 ${items.length} 件` : ''
  }`;
}

export function notesOneLine(page: NotePage): string {
  const count = page.items?.length ?? 0;
  if (!count) return '没有笔记';
  const first = page.items?.[0]?.title ?? '';
  return count === 1 ? `1 条笔记：${first}` : `${count} 条笔记，最近：${first}`;
}

/** 摘要的完整一次取数。两个领域各一份 reading，加上一份共同的元信息。 */
export interface Summary {
  /** 本体状态版本号。-1 表示还没收到过一帧状态，那就不写版本号，别写 0。 */
  revision: number;
  /** 这一次取回的完成时刻。 */
  fetchedAt: Date;
  calendar: DomainReading<CalendarPage>;
  notes: DomainReading<NotePage>;
}

/** 还没取过时摘要长什么样：一个空列表的假数据是不能画的。 */
export function emptySummary(now: Date = new Date()): Summary {
  const pending = (kind: DomainKind): DomainReading<never> => ({
    line: { kind, status: 'offline', message: '还没取过' },
    fetchedAt: now,
  });
  return {
    revision: -1,
    fetchedAt: now,
    calendar: pending('calendar'),
    notes: pending('notes'),
  };
}

/**
 * 换进一次新取数，**整体替换**而不是合并。
 *
 * 这一条就是「装了没运行时不拿旧缓存冒充今天」的实现：上一次取到的
 * 日程不会因为这次失败而留在界面上。数据是取来的，不是攒出来的。
 */
export function withReading<T extends DomainReading<unknown>>(
  summary: Summary,
  reading: T,
): Summary {
  const base = {
    revision: summary.revision,
    fetchedAt: summary.fetchedAt,
  };
  return reading.line.kind === 'calendar'
    ? {
        ...base,
        calendar: reading as DomainReading<CalendarPage>,
        notes: summary.notes,
      }
    : {
        ...base,
        calendar: summary.calendar,
        notes: reading as DomainReading<NotePage>,
      };
}

/**
 * 名册变了、正要重取的那一小会儿该显示什么。答案是**什么都不说**。
 *
 * 说「今天没有日程」是撒谎（还没取），说上一轮的内容是拿旧数据冒充今天 ——
 * 界面上会同时出现「插件没连上」和上一轮的日程明细，那正是 D05 明令禁止的样子
 * （实机抓到的就是它）。所以名册一变就先作废，等新的回来再画。
 */
export function invalidated(summary: Summary, now: Date = new Date()): Summary {
  const pending = (kind: DomainKind) => ({
    line: { kind, status: 'offline' as const, message: PENDING_MESSAGE },
    fetchedAt: now,
  });
  return {
    revision: summary.revision,
    fetchedAt: now,
    calendar: pending('calendar'),
    notes: pending('notes'),
  };
}

/** 正在取。它是个中间态，不是「今天什么都没有」。 */
export const PENDING_MESSAGE = '正在取…';

/**
 * 缺席的严重程度：数字越小越先说。
 *
 * 排的是「链路断在哪一环」：本体没接上，后面所有判断都不作数；没安装说明这个
 * 领域压根没接，别的领域的故障也解释不了它；版本对不上最危险 —— 插件**在跑**，
 * 却给着一份用不了的接口，不说出来就会被当成"日历是空的"。
 */
const SEVERITY: Record<DomainStatus, number> = {
  offline: 0,
  'not-installed': 1,
  'version-conflict': 2,
  'not-authorized': 3,
  'not-running': 4,
  ready: 5,
};

export interface SummaryRow {
  kind: DomainKind;
  label: string;
  status: DomainStatus;
  message: string;
  hint?: string;
  /** 自带页面且在场时才有值：按钮能不能点由它说了算。 */
  pageProvider?: string;
  /** 展开面板里的明细。没有数据时是空数组，不是"今天没有"。 */
  items: string[];
  /** 明细被截断时还剩多少条：面板要写出来，不能让用户以为就这些。 */
  more: number;
  fetchedAt: Date;
}

/** 面板最多列这么多条，再多就只给个数。理由写在下面。 */
export const PANEL_ITEM_LIMIT = 6;

function rowOf(
  kind: DomainKind,
  reading: DomainReading<unknown>,
  now: Date,
): SummaryRow {
  const message =
    reading.line.status === 'ready'
      ? kind === 'calendar'
        ? oneLineOf(reading.data as CalendarPage, now)
        : notesOneLine(reading.data as NotePage)
      : reading.line.message;
  const all =
    reading.line.status !== 'ready' || !reading.data
      ? []
      : kind === 'calendar'
        ? (reading.data as CalendarPage).items.map(
            (item) => `${clockOf(new Date(item.startsAt))} ${item.title}`,
          )
        : (reading.data as NotePage).items.map((item) => item.title);
  return {
    kind,
    label: DOMAIN_LABELS[kind],
    status: reading.line.status,
    message,
    ...(reading.line.hint ? { hint: reading.line.hint } : {}),
    ...(reading.line.pageProvider
      ? { pageProvider: reading.line.pageProvider }
      : {}),
    // 一天排满的日程可能有十条，笔记可能有上百条。面板是浮条不是列表页，
    // 截断到 6 条，剩下的用一个数说清楚 —— 悄悄少画几条最容易被读成"就这些"。
    items: all.slice(0, PANEL_ITEM_LIMIT),
    more: Math.max(0, all.length - PANEL_ITEM_LIMIT),
    fetchedAt: reading.fetchedAt,
  };
}

/** 展开面板里的两行。取不到的那一行 items 为空，但**行还在**。 */
export function rowsOf(summary: Summary, now: Date = new Date()): SummaryRow[] {
  return [
    rowOf('calendar', summary.calendar, now),
    rowOf('notes', summary.notes, now),
  ];
}

/**
 * 收起时那一行字。
 *
 * 有缺席就先说缺席，且按严重程度挑最要紧的那一条 —— 一条摘要条放不下两句
 * 故障，而"本体没接上"优先于"日历源没连上"，后者很可能只是前者的结果。
 * 都在场时两句拼成一句。
 */
export function headlineOf(summary: Summary, now: Date = new Date()): string {
  const rows = rowsOf(summary, now);
  const absent = rows
    .filter((row) => row.status !== 'ready')
    .sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status])[0];
  if (absent) return `${absent.label}：${absent.message}`;
  return rows.map((row) => row.message).join(' · ');
}

/** 摘要条底下那行小字：本体第几版、什么时候取的。 */
export function footerOf(summary: Summary, now: Date = new Date()): string {
  const revision =
    summary.revision < 0 ? '本体状态未知' : `本体状态 #${summary.revision}`;
  return `${revision} · ${clockOf(summary.fetchedAt)} 取回`;
}

/**
 * 摘要经本体取数，因此它自己**不发领域帧**，而是像插件页面那样把命令交给本体
 * 转发（ADR-016）。上下文与页面共用同一个规则：工作区取快照里的第一个，快照还
 * 没到就退回 `personal` —— 与命令行、插件页面是同一个键，否则同一条日程在
 * 三处会各存一份。
 */
export function summaryCommandContext(snapshot: Snapshot): CommandContext {
  return {
    requestId: `summary-${crypto.randomUUID()}`,
    workspaceId: snapshot.workspaces[0]?.id ?? 'personal',
    source: 'ui',
  };
}

/** 名册里够格提供某个领域页面的那个。按钮的可点性由它决定，不由上次取数决定。 */
export interface RosterProvider {
  provider: string;
  label: string;
  capabilities: string[];
  view?: { entry: string };
}

/** 名册的形状：摘要只看「谁在场、谁带着页面」。 */
export interface RosterView {
  connected: readonly RosterProvider[];
}

export function pageProviderFor(
  connected: readonly RosterProvider[],
  kind: DomainKind,
): RosterProvider | null {
  return (
    connected.find(
      (entry) =>
        entry.view !== undefined &&
        entry.capabilities.some((name) => name.startsWith(`${kind}.`)),
    ) ?? null
  );
}

/**
 * 名册变了就该重取：插件刚起来、刚掉线，摘要里那句话就过时了。
 *
 * 只看寻址键与页面入口，不看连接时间——后者每次握手都变，拿它做比较会变成
 * 「一收到新名册就重取」的循环。
 */
export function rosterSignature(roster: RosterView): string {
  return roster.connected
    .map((entry) => `${entry.provider}:${entry.view?.entry ?? '-'}`)
    .sort()
    .join(',');
}

/**
 * 该不该重取一次。三个重取理由，缺一不可：
 *
 * 1. **第一次**（`fetched` 还没有过名册）；
 * 2. **本体从没接上走到接上**。窗口常常比本体连上更早建起来，只在挂载时取一次
 *    的话，摘要会永远停在「ONE 本体没接上」而本体明明是通的（实机踩到）；
 * 3. **名册变了**。插件起来了或掉了，那句话立刻过时。
 *
 * 状态没变、名册没变时不重取：每收到一帧就去问本体，用户看到的取回时间会一直
 * 在跳，而数据其实一动没动。
 */
export function shouldRefetch(input: {
  fetched: boolean;
  wasReady: boolean;
  ready: boolean;
  lastSignature: string | null;
  signature: string;
}): boolean {
  if (!input.ready) return false;
  if (!input.fetched) return true;
  if (!input.wasReady) return true;
  return input.lastSignature !== input.signature;
}
