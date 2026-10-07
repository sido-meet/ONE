import { describe, expect, it } from 'vitest';
import { parseSchedule } from './schedule';

/**
 * 这一层的行为不是「实现长什么样」，是**哪些话它敢接、哪些不敢**（ADR-022）。
 *
 * 0.1 没有真模型，日程时间全靠这张表。接错一句话的代价由用户承担 —— 他会真的
 * 漏掉一场面试 —— 所以「拒绝」的例子比「接受」的例子更重要。
 */

const NOW = new Date(2026, 9, 7, 10, 30, 0); // 2026-10-07 10:30 本地时间
const accept = (text: string) => {
  const result = parseSchedule(text, NOW);
  if (!result.ok)
    throw new Error(`本该认出来却没认出来：${text} —— ${result.reason}`);
  return result.draft;
};
const refuse = (text: string) => {
  const result = parseSchedule(text, NOW);
  if (result.ok) throw new Error(`本该拒绝却认出来了：${text}`);
  return result.reason;
};

describe('中文日程句式', () => {
  it('认得「明天下午三点安排面试」，标题只留「面试」', () => {
    const draft = accept('明天下午三点安排面试');
    expect(draft.title).toBe('面试');
    expect(draft.startsAt).toMatch(/^2026-10-08T15:00:00[+-]\d{2}:\d{2}$/);
    expect(draft.endsAt).toMatch(/^2026-10-08T16:00:00[+-]\d{2}:\d{2}$/);
  });

  it('数字钟点与冒号写法一样认', () => {
    expect(accept('明天15:00面试').startsAt).toBe(
      accept('明天下午三点面试').startsAt,
    );
    expect(accept('明天15:30面试').startsAt).toMatch(/T15:30:00/);
  });

  it('中文数字与「半」「一刻」', () => {
    expect(accept('明天下午三点半面试').startsAt).toMatch(/T15:30:00/);
    expect(accept('明天上午九点一刻面试').startsAt).toMatch(/T09:15:00/);
    expect(accept('明天下午三点整面试').startsAt).toMatch(/T15:00:00/);
  });

  it('时段词会平移钟点，十二点是十二点', () => {
    expect(accept('今天上午九点体检').startsAt).toMatch(/^2026-10-07T09:00:00/);
    expect(accept('今天下午三点体检').startsAt).toMatch(/^2026-10-07T15:00:00/);
    expect(accept('今天晚上十点体检').startsAt).toMatch(/^2026-10-07T22:00:00/);
    expect(accept('今天中午十二点吃饭').startsAt).toMatch(
      /^2026-10-07T12:00:00/,
    );
    // 「下午十二点」是中午十二点，不是半夜十二点 —— 加十二小时会变成 24 点。
    expect(accept('今天下午十二点吃饭').startsAt).toMatch(
      /^2026-10-07T12:00:00/,
    );
  });

  it('今天、明天、后天各差一天', () => {
    expect(accept('今天下午三点面试').startsAt).toMatch(/^2026-10-07T/);
    expect(accept('明天下午三点面试').startsAt).toMatch(/^2026-10-08T/);
    expect(accept('后天上午三点面试').startsAt).toMatch(/^2026-10-09T/);
  });

  it('剥掉开头的祈使壳，留下的才是标题', () => {
    expect(accept('明天上午十点帮我安排一下季度总结').title).toBe('季度总结');
    expect(accept('后天下午两点提醒我交周报').title).toBe('交周报');
    expect(accept('明天九点体检').title).toBe('体检');
  });

  it('时间词在句中出现两次时两个都剥掉', () => {
    // 「replaceAll」漏掉第二处的话，标题会变成「明天下午开会」——
    // 用户看到的是一个像模像样的错答案，而不是一个明确的拒绝。
    expect(accept('明天下午三点开会，明天上午十点散会').title).not.toContain(
      '明天',
    );
    expect(accept('明天上午十点和明天下午三点都要开会').title).not.toContain(
      '明天',
    );
  });

  it('默认一小时，并且时长写在草稿里让用户看得见', () => {
    const draft = accept('明天下午三点面试');
    const minutes =
      (Date.parse(draft.endsAt) - Date.parse(draft.startsAt)) / 60_000;
    expect(minutes).toBe(60);
  });

  it('带时区的 RFC3339，并且时区写清楚是哪一个', () => {
    const draft = accept('明天下午三点面试');
    expect(draft.timeZone).toBeTruthy();
    expect(draft.startsAt).toContain(draft.timeZone === 'UTC' ? 'Z' : '+');
  });

  it('没有日期词就说没听出哪一天，并给一个例子', () => {
    const reason = refuse('下午三点安排面试');
    expect(reason).toContain('哪一天');
    expect(reason).toContain('明天下午三点安排面试');
  });

  it('有日期但没钟点就说没听出几点', () => {
    expect(refuse('明天安排面试')).toContain('几点');
  });

  it('知道日期与钟点但没有事由，说明缺的是事由而不是时间', () => {
    // 这句必须与「没听出时间」分开说：用户补一件事就能成，
    // 告诉他时间没听懂只会让他重打一遍。
    const reason = refuse('明天下午三点');
    expect(reason).toContain('安排什么');
  });

  it('超出范围的钟点被拒绝，不截断成别的数', () => {
    expect(refuse('今天下午二十五点面试')).toContain('几点');
    // 分与钟点要分开说：用户看到「几分」就知道该改分钟，看到「几点」会去改钟点。
    expect(refuse('今天下午三点七十分面试')).toContain('几分');
  });

  it('「一刻」是 15 分，不会被当成「1 分」', () => {
    // 正则备选最左优先：`一刻` 若让数字类先试就会匹配成「1」，剩下的「刻」留在原地，
    // 九点一刻安静地变成九点零一分 —— 不报错，只是把时间改了。
    expect(accept('明天上午九点一刻面试').startsAt).toMatch(/T09:15:00/);
    expect(accept('明天上午九点零一面试').startsAt).toMatch(/T09:01:00/);
  });

  it('空输入不会被当成「全天日程」', () => {
    expect(refuse('   ')).toBeTruthy();
  });
});
