import type { Proposal, Snapshot } from '../../packages/contracts/src/index.ts';

/**
 * 待确认提议的**模型**部分：怎么把提议摊平成一句能给人看的话。
 *
 * 排版规则集中在这里，视图只负责画 —— 宠物端对话条 380×168、主窗口 1200×820，
 * 两处各写一份排版的话，迟早会走偏（D05 在摘要条上已经吃过一次亏）。
 *
 * **时间直接拆 RFC3339 字符串，不走 Date 的本地化。** 草稿里的
 * `2026-10-08T15:00:00+08:00` 自带偏移，那串字符**就是**提议声明的那个墙上时间；
 * 拿 `new Date(s).getHours()` 去读，读到的是**这台机器**的时区。两者今天恰好
 * 一样，用户把配置复制到另一时区的机器上就会差出几个小时 —— 而日程差三个小时
 * 是会出事的。
 */

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const;

/** `2026-10-08T15:00:00+08:00` 的各个分量。拆不出来就当作不可解析，不猜。 */
interface Stamped {
  date: string;
  time: string;
  offset: string;
}

const STAMPED =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export function stampOf(value: string): Stamped | null {
  const matched = value.match(STAMPED);
  if (!matched) return null;
  const [, year, month, day, hour, minute, offset] = matched;
  if (!year || !month || !day || !hour || !minute || !offset) return null;
  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`,
    offset: offset === 'Z' ? '+00:00' : offset,
  };
}

/** `+08:00` → `GMT+8`。零偏移写 `GMT+0` 而不是 `GMT`，免得像句号。 */
export function offsetLabel(offset: string): string {
  const matched = offset.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!matched) return offset;
  const [, sign, hour, minute] = matched;
  const total = Number(hour) * 60 + Number(minute);
  const hours = Math.trunc(total / 60);
  const rest = total % 60;
  if (sign === '-' && total === 0) return 'GMT+0';
  const body = rest
    ? `${hours}:${String(rest).padStart(2, '0')}`
    : String(hours);
  return `GMT${sign === '-' ? '-' : '+'}${body}`;
}

/**
 * 绝对时间 + 时区，一行。0.1 验收要的就是这个：用户按确认之前，得能回答
 * 「到底是哪天的几点、哪个时区」，而不是「大概是明天下午」。
 *
 * 跨天时把两个日期都摆出来 —— 只写结束时间那个日期，跨月时会读成同一天。
 */
export function whenOf(proposal: Proposal): string {
  if (proposal.domain !== 'calendar') return '';
  const start = stampOf(proposal.draft.startsAt);
  const end = stampOf(proposal.draft.endsAt);
  if (!start || !end) return proposal.draft.startsAt;
  const span =
    start.date === end.date
      ? `${start.time}–${end.time}`
      : `${start.date} ${start.time} → ${end.date} ${end.time}`;
  return `${weekdayOf(start.date)} ${start.date} ${span}（${offsetLabel(start.offset)} ${proposal.draft.timeZone}）`;
}

/** 周几从日期分量算，不用 Date：掺进本地时区会跨日，「周日」会变成「周六」。 */
export function weekdayOf(date: string): string {
  const matched = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) return '';
  const [, year, month, day] = matched;
  const stamp = Date.UTC(Number(year), Number(month) - 1, Number(day));
  if (!Number.isFinite(stamp)) return '';
  return `周${WEEKDAYS[new Date(stamp).getUTCDay()]}`;
}

/** 提议挂在哪条消息下面。气泡里的卡片靠它归位。 */
export function proposalsByMessage(
  proposals: Proposal[],
): Map<string, Proposal[]> {
  const grouped = new Map<string, Proposal[]>();
  for (const proposal of proposals) {
    const list = grouped.get(proposal.messageId);
    if (list) list.push(proposal);
    else grouped.set(proposal.messageId, [proposal]);
  }
  return grouped;
}

/**
 * 最老的那条待确认提议。
 *
 * 宠物端对话条只放得下一张卡，因此取**最老**的一条而不是最新一条：用户依次
 * 说了三件事时，最早的那件到期最近，先问它。取最新会让最早提出的日程一直排
 * 不上队，然后被用户以为「ONE 把它吞了」。
 */
export function pendingOf(proposals: Proposal[]): Proposal | undefined {
  return proposals.find((item) => item.status === 'pending');
}

/**
 * 一条提议现在的状态陈述。三个结果都要有话说 —— 卡片从「待确认」变成空白，
 * 用户会以为它从没出现过。
 *
 * 「日历」和「笔记」要说不同的话：统一说「已保存」会让用户不知道东西去了哪。
 */
export function outcomeOf(proposal: Proposal): string {
  const where = proposal.domain === 'calendar' ? '已写进日历' : '已写进笔记';
  const when = proposal.created?.at.slice(0, 16).replace('T', ' ');
  if (proposal.status === 'pending') return '还没写进去，等你确认。';
  if (proposal.status === 'created')
    return proposal.created && when ? `${where}（${when}）。` : `${where}。`;
  return proposal.rejected?.reason
    ? `没写进去：${proposal.rejected.reason}`
    : '没写进去。';
}

/** 提议的标题。两个域都有，日历那个不是唯一有标题的。 */
export function titleOf(proposal: Proposal): string {
  return proposal.draft.title;
}

/**
 * 笔记正文的预览。**按行截，不按字截** —— 按字截会把一行腰斩，
 * 用户看到的半句话反而更让人拿不准这条笔记记了什么。
 *
 * 卡片只有两三行的位置，所以只给前几行；要看全文用「编辑」。
 */
export const NOTE_PREVIEW_LINES = 3;

export function bodyOf(proposal: Proposal): string {
  if (proposal.domain !== 'notes') return '';
  const lines = proposal.draft.body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  // 只剩标题那一句就返回空串：标题本来就是正文首行（note.ts 的 titleOf 从
  // 正文取），短笔记再摆一遍等于同一句话写两遍，看着像出了两次内容。
  if (lines.length <= 1) return '';
  const shown = lines.slice(0, NOTE_PREVIEW_LINES);
  return lines.length > shown.length
    ? `${shown.join('\n')}…`
    : shown.join('\n');
}

/** 快照里还剩几条没处理 —— 气泡用它决定要不要在云里让位给卡片。 */
export function pendingCount(snapshot: Snapshot): number {
  return snapshot.proposals.filter((item) => item.status === 'pending').length;
}
