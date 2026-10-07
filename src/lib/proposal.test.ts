import { describe, expect, it } from 'vitest';
import type { Proposal } from '../../packages/contracts/src/index.ts';
import {
  bodyOf,
  offsetLabel,
  outcomeOf,
  pendingCount,
  pendingOf,
  proposalsByMessage,
  stampOf,
  titleOf,
  weekdayOf,
  whenOf,
} from './proposal';

/**
 * 卡片上那几行字。这些断言盯的是**别把时间显示错** —— 日程差三个小时是要出事的，
 * 而这类错误不会抛异常，只会让用户准时出现在错误的地方。
 */

/** 联合类型上做部分覆盖会摊成 `domain: 'calendar' | 'notes'`，所以整体断言一次。 */
const proposal = (patch: Partial<Proposal> = {}): Proposal =>
  ({
    id: 'p1',
    domain: 'calendar',
    status: 'pending',
    messageId: 'm1',
    workspaceId: 'personal',
    sourceConversationId: 'c1',
    createdAt: '2026-10-07T10:30:00.000Z',
    draft: {
      title: '面试',
      startsAt: '2026-10-08T15:00:00+08:00',
      endsAt: '2026-10-08T16:00:00+08:00',
      timeZone: 'Asia/Shanghai',
    },
    ...patch,
  }) as Proposal;

describe('提议卡片上的时间', () => {
  it('拆 RFC3339 时不掺本地时区', () => {
    // 拆出来的是**草稿声明的**墙上时间 15:00，不是这台机器此刻的钟面。
    expect(stampOf('2026-10-08T15:00:00+08:00')).toEqual({
      date: '2026-10-08',
      time: '15:00',
      offset: '+08:00',
    });
    expect(stampOf('2026-10-08T15:00:00Z')?.offset).toBe('+00:00');
    expect(stampOf('2026-10-08 15:00')).toBeNull();
  });

  it('偏移写成 GMT+8，零偏移也照写', () => {
    expect(offsetLabel('+08:00')).toBe('GMT+8');
    expect(offsetLabel('-05:30')).toBe('GMT-5:30');
    expect(offsetLabel('+00:00')).toBe('GMT+0');
  });

  it('周几从日期分量算，跨月那天不会读错', () => {
    expect(weekdayOf('2026-10-08')).toBe('周四');
    expect(weekdayOf('2026-10-01')).toBe('周四');
    expect(weekdayOf('不是日期')).toBe('');
  });

  it('同一天写一个日期，跨天写两个', () => {
    expect(whenOf(proposal())).toBe(
      '周四 2026-10-08 15:00–16:00（GMT+8 Asia/Shanghai）',
    );
    const overnight = proposal({
      draft: {
        title: '通宵部署',
        startsAt: '2026-10-08T23:30:00+08:00',
        endsAt: '2026-10-09T00:30:00+08:00',
        timeZone: 'Asia/Shanghai',
      },
    } as Partial<Proposal>);
    // 只写结束那个日期的话，跨月会被读成同一天下午。
    expect(whenOf(overnight)).toContain('2026-10-08 23:30 → 2026-10-09 00:30');
  });

  it('拆不出来就退回原串，不显示一个假的「15:00」', () => {
    expect(
      whenOf(
        proposal({
          draft: {
            title: 'x',
            startsAt: '??',
            endsAt: '??',
            timeZone: 'Asia/Shanghai',
          },
        } as Partial<Proposal>),
      ),
    ).toBe('??');
  });
});

describe('卡片的状态陈述', () => {
  it('日历与笔记要说不同的话：统一说「已保存」会让用户不知道东西去了哪', () => {
    const created = {
      status: 'created',
      created: { entityId: 'e1', at: '2026-10-07T11:00:00.000Z' },
    } as const;
    expect(outcomeOf(proposal(created))).toContain('已写进日历');
    expect(
      outcomeOf(
        proposal({
          ...created,
          domain: 'notes',
          draft: { title: '会议纪要', body: '三点结论' },
        } as Partial<Proposal>),
      ),
    ).toContain('已写进笔记');
  });

  it('三个结果各有一句话，卡片不会变成空白', () => {
    expect(outcomeOf(proposal())).toContain('等你确认');
    expect(
      outcomeOf(
        proposal({
          status: 'created',
          created: { entityId: 'e1', at: '2026-10-07T11:00:00.000Z' },
        }),
      ),
    ).toContain('已写进日历');
    expect(
      outcomeOf(
        proposal({
          status: 'rejected',
          rejected: { reason: '那天我在外地', at: '2026-10-07T11:00:00.000Z' },
        }),
      ),
    ).toBe('没写进去：那天我在外地');
  });

  it('拒绝没有理由时不装出理由', () => {
    expect(
      outcomeOf(
        proposal({ status: 'rejected', rejected: { reason: '', at: 'x' } }),
      ),
    ).toBe('没写进去。');
  });
});

describe('挑哪一条给用户看', () => {
  it('按消息分组，卡片挂回自己的气泡', () => {
    const grouped = proposalsByMessage([
      proposal({ id: 'a', messageId: 'm1' }),
      proposal({ id: 'b', messageId: 'm1' }),
      proposal({ id: 'c', messageId: 'm2' }),
    ]);
    expect(grouped.get('m1')?.map((item) => item.id)).toEqual(['a', 'b']);
    expect(grouped.get('m2')).toHaveLength(1);
  });

  it('取最老的待确认，不是最新那条', () => {
    // 三件事里最早提的那件到期最近，先问它 —— 取最新会让最早那条一直排不上队，
    // 然后被用户以为「ONE 把它吞了」。
    expect(
      pendingOf([
        proposal({ id: 'a' }),
        proposal({ id: 'b' }),
        proposal({ id: 'c' }),
      ])?.id,
    ).toBe('a');
    expect(
      pendingOf([
        proposal({ id: 'a', status: 'created' }),
        proposal({ id: 'b' }),
      ])?.id,
    ).toBe('b');
    expect(
      pendingOf([proposal({ id: 'a', status: 'rejected' })]),
    ).toBeUndefined();
  });

  it('标题取自草稿，笔记也有标题', () => {
    expect(titleOf(proposal())).toBe('面试');
    expect(
      titleOf(
        proposal({
          domain: 'notes',
          draft: { title: '会议纪要', body: '…' },
        } as Partial<Proposal>),
      ),
    ).toBe('会议纪要');
  });

  it('笔记预览按行截，不按字截', () => {
    // 按字截会把一行腰斩，用户看到的半句话反而更拿不准这条笔记记了什么。
    const note = proposal({
      domain: 'notes',
      draft: {
        title: '复盘',
        body: '第一点很长很长很长很长很长很长很长的一行\n第二点\n第三点\n第四点',
      },
    } as Partial<Proposal>);
    const preview = bodyOf(note);
    expect(preview).toContain('第一点很长');
    expect(preview).toContain('第三点');
    expect(preview).not.toContain('第四点');
    expect(preview.endsWith('…')).toBe(true);
    // 日历没有正文可言
    expect(bodyOf(proposal())).toBe('');
  });

  it('只有一句的笔记不再重复摆一遍正文', () => {
    // 标题本来就是正文首行，短笔记再摆一遍等于同一句话写两遍。
    const short = proposal({
      domain: 'notes',
      draft: { title: '一句话', body: '一句话' },
    } as Partial<Proposal>);
    expect(bodyOf(short)).toBe('');
  });

  it('待确认的条数告诉气泡要不要让位给卡片', () => {
    expect(
      pendingCount({
        workspaces: [],
        conversations: [],
        events: [],
        runs: [],
        drafts: {},
        proposals: [
          proposal({ id: 'a' }),
          proposal({ id: 'b', status: 'rejected' }),
        ],
      }),
    ).toBe(1);
  });
});
