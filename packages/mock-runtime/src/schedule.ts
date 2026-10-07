import { localInstant, localTimeZone } from '../../contracts/src/localtime.ts';
import type { CalendarDraft } from '../../contracts/src/proposal.ts';

/**
 * 从中文里抽出一份日程草稿（0.1 / ADR-022）。
 *
 * **这一版只认固定句式，认不出就说认不出。** 范围收窄是刻意的：0.1 没有真模型，
 * 与其做一个半吊子的自然语言理解、时不时猜错时间，不如一张看得见的句式表 ——
 * 猜错时间是要用户自己承担的代价（他真的会漏掉一场面试）。
 *
 * 认出来的话长这样：
 *
 * ```
 * 明天下午三点安排面试
 * 明天15:00面试
 * 后天晚上八点提醒我交周报
 * 今天上午九点
 * ```
 *
 * 将来换成真模型时，**整块换掉这一层**：上面这些句式表与中文数字解析只服务于
 * 「没有模型时的本地起草」，模型自己会给出结构化输入。`parseSchedule` 的返回
 * 形状（成功给草稿 / 失败给一句能直接说给用户听的话）是留给那之后的契约。
 */

/** 议程长度。0.1 不让用户指定时长，但**必须显示在预览里** —— 他有权知道这事多久。 */
export const DEFAULT_DURATION_MINUTES = 60;

export type ScheduleAttempt =
  { ok: true; draft: CalendarDraft } | { ok: false; reason: string };

const DAY_WORDS: Record<string, number> = {
  今天: 0,
  今日: 0,
  明天: 1,
  明日: 1,
  后天: 2,
};

const PERIOD_WORDS: Record<string, number> = {
  上午: 0,
  早上: 0,
  早晨: 0,
  中午: 12,
  下午: 12,
  傍晚: 12,
  晚上: 12,
  夜里: 12,
  今晚: 12,
};

/**
 * 开头的祈使壳。剥掉它之后剩下的才是标题：「帮我安排面试」→「面试」。
 * 刻意做成一张短名单而不是「去掉所有动词」—— 名单外的词会留在标题里，用户
 * 一眼能看出模型理解错了；误删则连错在哪都找不回来。
 */
const LEADING_VERBS = [
  '帮我',
  '请',
  '麻烦',
  '替我',
  '安排一下',
  '安排',
  '新建',
  '记一下',
  '记录',
  '提醒我',
  '提醒',
  '加一个',
  '添加',
  '约',
];

const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  两: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

/**
 * `3点` `三点` `3:30` `3点30` `3点半` `3点一刻` `3点整`。
 *
 * 备选分支的顺序有讲究：**`半|一刻|整` 必须排在数字类前面**。正则的备选是
 * 最左优先的，`一刻` 若让 `[一两二…]` 先试，它会被匹配成一个「1」，剩下的
 * 「刻」留在原地 —— 于是九点一刻变成九点零一分。这种错不报错，只是安静地把
 * 时间改了，而用户不会知道自己差三刻钟。
 */
const TIME_PATTERN =
  /(上午|早上|早晨|中午|下午|傍晚|晚上|夜里|今晚)?\s*(\d{1,2}|[零〇一两二三四五六七八九十]{1,3})\s*(?:[点时:：])\s*(半|一刻|整|\d{1,2}|[零〇一两二三四五六七八九十]{1,3})?\s*分?/;

const DAY_PATTERN = /(今天|今日|明天|明日|后天)/;

/**
 * 中文数字只覆盖 0–23（小时）与 0–59（分钟）这个范围。范围外的写法（「二十五点」
 * 「一百点」）一律判为认不出，而不是截断成别的数。
 */
function cnNumber(raw: string): number | null {
  if (raw === '半') return 30;
  if (raw === '一刻') return 15;
  if (raw === '整') return 0;
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) return Number(raw);
  // 十X 与 X十 与 十几 的合成：「十」=10「十五」=15「二十三」=23
  if (raw.includes('十')) {
    const [head = '', tail = ''] = raw.split('十');
    const high = head === '' ? 1 : CN_DIGITS[head];
    const low = tail === '' ? 0 : CN_DIGITS[tail];
    if (high === undefined || low === undefined) return null;
    return high * 10 + low;
  }
  let value = 0;
  for (const char of raw) {
    const digit = CN_DIGITS[char];
    if (digit === undefined) return null;
    value = value * 10 + digit;
  }
  return value;
}

const reject = (reason: string): ScheduleAttempt => ({ ok: false, reason });

/**
 * 抽草稿。`now` 是基准时刻（测试传固定值，不依赖真实时钟）。
 *
 * 失败时给的是**可以直接说给用户听的一句话**，不是错误码：Agent 要把它讲出来，
 * 所以必须像人话，而且要带上「怎么说它才听得懂」的例子。
 */
export function parseSchedule(text: string, now: Date): ScheduleAttempt {
  const input = text.trim();
  if (!input) return reject('没听清要安排什么。');

  const dayMatch = input.match(DAY_PATTERN);
  if (!dayMatch)
    return reject('没听出是哪一天。试试「明天下午三点安排面试」这种说法。');

  const timeMatch = input.match(TIME_PATTERN);
  if (!timeMatch)
    return reject('没听出是几点。试试「明天下午三点安排面试」这种说法。');

  const [, periodWord, rawHour = '', rawMinute] = timeMatch;
  const hour = cnNumber(rawHour);
  if (hour === null || hour < 0 || hour > 23)
    return reject('没听出是几点。试试「明天下午三点安排面试」这种说法。');
  const minute = cnNumber(rawMinute ?? '') ?? 0;
  if (minute < 0 || minute > 59)
    return reject('没听出是几分。试试「明天下午三点半安排面试」这种说法。');

  const shift = PERIOD_WORDS[periodWord ?? ''] ?? 0;
  // 十二点是十二点，不加十二小时。「下午三点」=15:00，「下午十二点」=12:00。
  const hour24 = hour === 12 ? (shift === 0 ? 0 : 12) : hour + shift;
  if (hour24 > 23) return reject('这个钟点不存在。');

  const day = dayMatch[0] ?? '';
  const title = titleOf(input, day, timeMatch[0] ?? '');
  if (!title)
    return reject(
      '知道是哪天哪几点，但没听出要安排什么。试试「明天下午三点安排面试」。',
    );
  const dayOffset = DAY_WORDS[day as keyof typeof DAY_WORDS];
  if (dayOffset === undefined)
    return reject('没听出是哪一天。试试「明天下午三点安排面试」这种说法。');

  const start = new Date(now);
  start.setDate(start.getDate() + dayOffset);
  start.setHours(hour24, minute, 0, 0);

  const end = new Date(start.getTime() + DEFAULT_DURATION_MINUTES * 60_000);
  const timeZone = localTimeZone();
  return {
    ok: true,
    draft: {
      title,
      startsAt: localInstant(start),
      endsAt: localInstant(end),
      timeZone,
    },
  };
}

/**
 * 标题 = 原文减去日期词与时间片段，再剥掉开头的祈使壳。
 *
 * `replaceAll` 要用**全局**形式：`String.replace` 拿字符串当第一参数时只换第一个，
 * 而「明天」在「明天上午明天」这种句子里可能出现两次 —— 漏掉第二个会让时间
 * 词混进标题，用户看到的是一句莫名其妙的话而不是一个明确的错误。
 */
function titleOf(input: string, day: string, time: string): string {
  let rest = input.split(day).join(' ').split(time).join(' ');
  rest = rest.replace(/[，,。.、；;：:！!？?\s]+/g, ' ').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const verb of LEADING_VERBS) {
      if (rest.startsWith(verb)) {
        rest = rest.slice(verb.length).trim();
        changed = true;
      }
    }
  }
  return rest.trim();
}
