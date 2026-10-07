import { describe, expect, it } from 'vitest';
import { ClientError } from '../../packages/contracts/src/errors.ts';
import {
  providerNotAuthorized,
  providerNotInstalled,
  providerNotRunning,
  providerVersionConflict,
} from '../../packages/contracts/src/provider.ts';
import type {
  CalendarEvent,
  CalendarPage,
  NotePage,
} from '../../packages/contracts/src/index.ts';
import {
  PANEL_ITEM_LIMIT,
  clockOf,
  describeDomainFailure,
  emptySummary,
  footerOf,
  headlineOf,
  invalidated,
  notesOneLine,
  oneLineOf,
  pageProviderFor,
  readDomain,
  rosterSignature,
  rowsOf,
  shouldRefetch,
  summaryCommandContext,
  todayRange,
  withOffset,
  withReading,
} from './summary';
import { pageCommandContext } from './page-bridge';

/**
 * 摘要条的模型（ADR-018）。
 *
 * 这里的断言都落在同一条纪律上：**摘要说的每一句都要对得上它的来路**。
 * 拿不到就说拿不到，缺席分四类说，取数时间与本体版本号必须写在脸上。
 */

const event = (title: string, startsAt: string): CalendarEvent => ({
  id: title,
  workspaceId: 'w1',
  title,
  startsAt,
  endsAt: startsAt,
  timeZone: 'Asia/Shanghai',
  version: 1,
});

const calendarPage = (items: CalendarEvent[]): CalendarPage => ({ items });
const notePage = (titles: string[]): NotePage => ({
  items: titles.map((title, index) => ({
    id: `n${index}`,
    title,
    version: 1,
    updatedAt: '2026-10-07T09:00:00+08:00',
  })),
});

describe('四种缺席分开说（ADR-016）', () => {
  it('没安装、没运行、没授权、版本冲突各有一句话，不能合成一句', () => {
    const cases: [ReturnType<typeof providerNotRunning>, string, string][] = [
      [providerNotInstalled('calendar'), 'not-installed', '还没有接日历源'],
      [
        providerNotRunning('calendar', 'local.calendar'),
        'not-running',
        '日历源没有连上',
      ],
      [
        providerNotAuthorized('calendar', 'local.calendar', ['calendar.read']),
        'not-authorized',
        '日历源缺少授权',
      ],
      [
        providerVersionConflict('calendar', 'local.calendar', 2, 1),
        'version-conflict',
        '日历源版本与 ONE 不一致',
      ],
    ];
    for (const [cause, status, fragment] of cases) {
      const line = describeDomainFailure('calendar', cause);
      expect(line.status).toBe(status);
      expect(line.message).toContain(fragment);
    }
  });

  it('没安装才给安装引导，另外三种不给', () => {
    // 四种缺席里只有一种要用户去装东西，其余三种去装也没用。
    expect(
      describeDomainFailure('calendar', providerNotInstalled('calendar')).hint,
    ).toContain('ONE_INSTALLED');
    expect(
      describeDomainFailure('calendar', providerNotRunning('calendar', 'x'))
        .hint,
    ).toBeUndefined();
  });

  it('本体自己的话比模板详细，摘要条直接端出来', () => {
    // 「缺少哪几项」只有本体知道，模板编不出来。
    const cause = providerNotAuthorized('notes', 'local.notes', [
      'notes.read',
      'notes.write',
    ]);
    expect(describeDomainFailure('notes', cause).message).toContain(
      'notes.read、notes.write',
    );
  });

  it('不认识的理由不当成缺席 —— 那是本体没接上', () => {
    const cause = new ClientError('INTERNAL', '炸了', {
      providerProblem: { kind: 'calendar', reason: 'moon-phase' },
    });
    const line = describeDomainFailure('calendar', cause);
    expect(line.status).toBe('offline');
    expect(line.message).toContain('ONE 本体没接上');
  });
});

describe('取数：失败不吞，也不拿空列表充数', () => {
  it('成功时带回数据与取回时刻', async () => {
    const now = new Date(2026, 9, 7, 10, 30);
    const reading = await readDomain(
      'calendar',
      async () => calendarPage([event('面试', '2026-10-07T14:00:00+08:00')]),
      { now, pageProvider: 'local.calendar' },
    );
    expect(reading.line.status).toBe('ready');
    expect(reading.data?.items).toHaveLength(1);
    expect(reading.fetchedAt).toBe(now);
    expect(reading.line.pageProvider).toBe('local.calendar');
  });

  it('失败时没有数据，绝不是空列表', async () => {
    // 空列表会被读成「今天没有日程」，而真相是「没取到」——这是两条完全不同的信息。
    const reading = await readDomain('calendar', async () => {
      throw providerNotRunning('calendar', 'local.calendar');
    });
    expect(reading.data).toBeUndefined();
    expect(reading.line.status).toBe('not-running');
  });

  it('取数失败也留着页面入口：插件刚才还在名册里', async () => {
    const reading = await readDomain(
      'calendar',
      async () => {
        throw providerNotRunning('calendar', 'local.calendar');
      },
      { pageProvider: 'local.calendar' },
    );
    expect(reading.line.pageProvider).toBe('local.calendar');
  });
});

describe('换了新取数，旧数据不留着', () => {
  it('上一次取到的日程不会在这次失败后继续显示', async () => {
    // D05 的完成标准：装了没运行时不拿旧缓存冒充今天。
    const good = await readDomain('calendar', async () =>
      calendarPage([event('面试', '2026-10-07T14:00:00+08:00')]),
    );
    const summary = withReading(
      withReading(emptySummary(), good),
      await readDomain('notes', async () => notePage([])),
    );
    expect(headlineOf(summary)).toContain('面试');

    const failed = await readDomain('calendar', async () => {
      throw providerNotRunning('calendar', 'local.calendar');
    });
    const after = withReading(summary, failed);
    expect(headlineOf(after)).toBe('日历：日历源没有连上');
    expect(rowsOf(after)[0]?.items).toEqual([]);
  });

  it('换进日历不会动笔记那份', async () => {
    const notes = await readDomain('notes', async () => notePage(['周报']));
    const both = withReading(
      withReading(emptySummary(), notes),
      await readDomain('calendar', async () => calendarPage([])),
    );
    expect(rowsOf(both).map((row) => row.message)).toEqual([
      '今天没有日程',
      '1 条笔记：周报',
    ]);
  });

  it('名册变了就作废旧数据，在新的回来之前什么都不说', async () => {
    // 实机抓到的就是这个：插件掉线后，界面上同时挂着「没连上」与上一轮的日程
    // 明细。作废之后宁可只说「正在取」——说「今天没有日程」是撒谎，
    // 说旧内容是拿缓存冒充今天。
    const ready = withReading(
      withReading(
        emptySummary(),
        await readDomain('notes', async () => notePage([])),
      ),
      await readDomain('calendar', async () =>
        calendarPage([event('面试', '2026-10-07T14:00:00+08:00')]),
      ),
    );
    expect(headlineOf(ready)).toContain('面试');

    const during = invalidated(ready);
    expect(headlineOf(during)).toBe('日历：正在取…');
    expect(rowsOf(during).every((row) => row.items.length === 0)).toBe(true);
    // 本体第几版仍然照实写：作废的是数据，不是凭据。
    expect(footerOf(during)).toContain('本体状态');
  });
});

describe('摘要条那一行字', () => {
  /**
   * 钉住「现在」，与本文件其它用例同一惯例。
   *
   * `oneLineOf` 挑的是**接下来**的一件，判定要用当前时刻。以前这里不传，用的是
   * 跑测试那一刻的真实时间：只要在 14:00–16:00 之间跑，`2026-10-07T14:00:00+08:00`
   * 那条已经过去，于是改挑 16:00 的周会，断言当场翻车 —— 同样一份代码，早上跑过
   * 下午就挂，而报错信息看着像功能坏了。
   */
  const NOW = new Date(2026, 9, 7, 10, 30);

  const ready = async (items: CalendarEvent[]) => {
    const summary = withReading(
      emptySummary(),
      await readDomain('calendar', async () => calendarPage(items)),
    );
    return withReading(
      summary,
      await readDomain('notes', async () => notePage([])),
    );
  };

  it('都在场时两句拼成一句', async () => {
    const summary = await ready([
      event('面试', '2026-10-07T14:00:00+08:00'),
      event('周会', '2026-10-07T16:00:00+08:00'),
    ]);
    expect(headlineOf(summary, NOW)).toBe('14:00 面试 等 2 件 · 没有笔记');
  });

  it('本体没接上优先于插件没连上', async () => {
    // 「本体没接上」很可能就是「插件显示没连上」的原因：插件是本体连的。
    const offline = withReading(
      emptySummary(),
      await readDomain('calendar', async () => {
        throw new Error('管道断了');
      }),
    );
    const summary = withReading(
      offline,
      await readDomain('notes', async () => {
        throw providerNotRunning('notes', 'local.notes');
      }),
    );
    expect(headlineOf(summary)).toBe('日历：ONE 本体没接上：管道断了');
  });

  it('插件在跑但版本对不上，要压过「没连上」', async () => {
    // 版本冲突最危险：它看起来一切正常，只是给着一份用不了的接口。
    const calendar = await readDomain('calendar', async () => {
      throw providerVersionConflict('calendar', 'local.calendar', 2, 1);
    });
    const summary = withReading(
      withReading(emptySummary(), calendar),
      await readDomain('notes', async () => {
        throw providerNotRunning('notes', 'local.notes');
      }),
    );
    expect(headlineOf(summary)).toBe(
      '日历：日历源版本与 ONE 不一致（插件 2，本体 1）',
    );
  });

  it('没取过时说的是「还没取过」，不是「今天没有日程」', () => {
    const summary = emptySummary();
    expect(headlineOf(summary)).toBe('日历：还没取过');
    expect(rowsOf(summary).every((row) => row.items.length === 0)).toBe(true);
  });

  it('过期的那一件不冒充下一件', async () => {
    // 已经过去的事件不该被当成「接下来的一件」。
    const now = new Date(2026, 9, 7, 20, 0);
    const page = calendarPage([
      event('早会', '2026-10-07T09:00:00+08:00'),
      event('晚课', '2026-10-07T21:00:00+08:00'),
    ]);
    expect(oneLineOf(page, now)).toBe('21:00 晚课 等 2 件');
  });
});

describe('摘要条的凭据', () => {
  it('写出本体第几版与取回时刻', async () => {
    const summary = withReading(
      emptySummary(),
      await readDomain('calendar', async () => calendarPage([])),
    );
    const withVersion = {
      ...summary,
      revision: 7,
      fetchedAt: new Date(2026, 9, 7, 10, 30),
    };
    expect(footerOf(withVersion)).toBe('本体状态 #7 · 10:30 取回');
  });

  it('没收到过状态帧就不编版本号', () => {
    // -1 是「还不知道」，写成 #0 会被读成「本体在第 0 版」，两回事。
    expect(footerOf(emptySummary())).toBe(
      `本体状态未知 · ${clockOf(new Date())} 取回`,
    );
  });
});

describe('今天是哪一天', () => {
  it('按本地时区取当天的起止，且带偏移', () => {
    const now = new Date(2026, 9, 7, 10, 30);
    const range = todayRange(now);
    expect(range.rangeStart.slice(0, 10)).toBe('2026-10-07');
    expect(range.rangeEnd.slice(0, 10)).toBe('2026-10-08');
    expect(range.rangeStart).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(range.rangeEnd).toMatch(/[+-]\d{2}:\d{2}$/);
  });

  it('跨月的那一天也算得对', () => {
    const range = todayRange(new Date(2026, 9, 31, 23, 0));
    expect(range.rangeStart.slice(0, 10)).toBe('2026-10-31');
    expect(range.rangeEnd.slice(0, 10)).toBe('2026-11-01');
  });

  it('偏移照着本机时区算，不是硬写 +08:00', () => {
    // 东八区之外也必须对：写死 +08:00 会在别的时区把「今天」算错一整天。
    expect(withOffset(new Date(2026, 9, 7, 10, 0))).toBe(
      withOffset(new Date(2026, 9, 7, 10, 0)),
    );
    const pad = (value: number) => String(value).padStart(2, '0');
    const offset = -new Date(2026, 9, 7).getTimezoneOffset();
    expect(withOffset(new Date(2026, 9, 7, 10, 0))).toBe(
      `2026-10-07T10:00:00${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`,
    );
  });
});

describe('页面按钮给谁', () => {
  it('只有自带页面且报了本领域能力的参与者才算', () => {
    const connected = [
      {
        provider: 'local.calendar',
        label: '本地日历',
        capabilities: ['calendar.list', 'page.read'],
        view: { entry: 'index.html' },
      },
      {
        provider: 'local.notes',
        label: '本地笔记',
        capabilities: ['notes.list', 'page.read'],
        view: { entry: 'index.html' },
      },
      {
        provider: 'plain.docs',
        label: '没有页面的',
        capabilities: ['notes.list'],
        view: undefined,
      },
    ];
    expect(pageProviderFor(connected, 'calendar')?.provider).toBe(
      'local.calendar',
    );
    // 报了 notes.list 但没自带页面的，点了只会开出一个空窗口 —— 不给入口。
    expect(pageProviderFor([connected[2]!], 'notes')).toBeNull();
    expect(pageProviderFor([], 'calendar')).toBeNull();
  });

  it('名册变了就该重取：签名只认寻址键与页面入口', () => {
    const base = [
      {
        provider: 'local.calendar',
        label: '本地日历',
        capabilities: [],
        view: { entry: 'index.html' },
      },
    ];
    expect(rosterSignature({ connected: base })).toBe(
      rosterSignature({
        connected: [
          // 连接时间与 label 每次握手都变，进了签名就成了「一收到名册就重取」的循环。
          { ...base[0]!, label: '本地日历（重连）' },
        ],
      }),
    );
    // 插件掉了、或者换了自带页面，都要重取。
    expect(rosterSignature({ connected: base })).not.toBe(
      rosterSignature({ connected: [] }),
    );
    expect(rosterSignature({ connected: base })).not.toBe(
      rosterSignature({
        connected: [{ ...base[0]!, view: { entry: 'day.html' } }],
      }),
    );
  });
});

describe('什么时候重取一次', () => {
  const base = {
    fetched: true,
    wasReady: true,
    ready: true,
    lastSignature: 'local.calendar:index.html',
    signature: 'local.calendar:index.html',
  };

  it('状态与名册都没变时不打扰本体', () => {
    // 每收到一帧就重取的话，取回时间会一直跳，而数据一动没动。
    expect(shouldRefetch(base)).toBe(false);
  });

  it('本体没接上时不取', () => {
    expect(shouldRefetch({ ...base, ready: false })).toBe(false);
  });

  it('第一次一定要取', () => {
    expect(shouldRefetch({ ...base, fetched: false })).toBe(true);
  });

  it('本体从没接上走到接上，要重取 —— 实机踩到的那个坑', () => {
    // 窗口常常比本体连上更早建起来：只在挂载时取一次的话，摘要会永远停在
    // 「ONE 本体没接上」，而本体明明是通的。
    expect(
      shouldRefetch({
        ...base,
        fetched: true,
        wasReady: false,
        lastSignature: null,
        signature: '',
      }),
    ).toBe(true);
  });

  it('名册变了要重取：插件起来或掉了，那句话立刻过时', () => {
    expect(
      shouldRefetch({
        ...base,
        signature: 'local.calendar:index.html,local.notes:index.html',
      }),
    ).toBe(true);
  });
});

describe('命令上下文的归属', () => {
  it('与插件页面、命令行共用同一个工作区键', () => {
    // 三处各用一个键的话，同一条日程会在三个地方各存一份。
    const snapshot = {
      workspaces: [{ id: 'w-home', name: '家' }],
      conversations: [],
      events: [],
      runs: [],
      drafts: {},
      proposals: [],
    };
    const context = summaryCommandContext(snapshot);
    expect(context.workspaceId).toBe('w-home');
    expect(context.source).toBe('ui');
    expect(pageCommandContext(snapshot).workspaceId).toBe('w-home');
    // 快照还没到就退回 personal，而不是空串。
    expect(
      summaryCommandContext({ ...snapshot, workspaces: [] }).workspaceId,
    ).toBe('personal');
  });

  it('每次请求都带自己的 requestId', () => {
    const snapshot = {
      workspaces: [],
      conversations: [],
      events: [],
      runs: [],
      drafts: {},
      proposals: [],
    };
    expect(summaryCommandContext(snapshot).requestId).not.toBe(
      summaryCommandContext(snapshot).requestId,
    );
  });
});

describe('面板里画多少条', () => {
  it('超过上限就写清楚还剩多少，不悄悄少画', async () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      event(
        `第 ${index + 1} 件`,
        `2026-10-07T${String(8 + index).padStart(2, '0')}:00:00+08:00`,
      ),
    );
    const summary = withReading(
      emptySummary(),
      await readDomain('calendar', async () => calendarPage(many)),
    );
    const row = rowsOf(summary)[0]!;
    expect(row.items).toHaveLength(PANEL_ITEM_LIMIT);
    expect(row.more).toBe(3);
  });
});

describe('排版规则留在模型里', () => {
  it('笔记条数与标题的收窄只有一处', () => {
    expect(notesOneLine(notePage([]))).toBe('没有笔记');
    expect(notesOneLine(notePage(['周报']))).toBe('1 条笔记：周报');
    expect(notesOneLine(notePage(['周报', '想法']))).toBe(
      '2 条笔记，最近：周报',
    );
  });

  it('时间格式不随运行环境的 ICU 数据变', () => {
    expect(clockOf(new Date(2026, 9, 7, 9, 5))).toBe('09:05');
    expect(clockOf(new Date(2026, 9, 7, 23, 59))).toBe('23:59');
  });
});
