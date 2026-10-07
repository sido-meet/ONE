import { describe, expect, it } from 'vitest';
import {
  BOTTOM_TOLERANCE_PX,
  distanceToBottom,
  shouldStickToBottom,
  stickToBottom,
} from './follow';

/**
 * 滚动纪律：**用户往上翻了就不许把他拽回底部。**
 *
 * 这些用例钉的是行为，不是实现 —— 「容差是 24 还是 30」不重要，重要的是
 * 「贴着底要跟」与「离开了底就不跟」这两条在任何情况下都成立。
 */

const box = (
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

describe('聊天记录要不要跟着新内容往下滚', () => {
  it('用户就在底部时跟着滚', () => {
    const atBottom = box(500, 1200, 700);
    expect(distanceToBottom(atBottom)).toBe(0);
    expect(shouldStickToBottom(atBottom)).toBe(true);
  });

  it('差一点点也仍然算在底部', () => {
    // 差几像素是滚轮惯性，不是「用户想往上看」。
    expect(shouldStickToBottom(box(500, 1200, 700 + BOTTOM_TOLERANCE_PX))).toBe(
      true,
    );
  });

  it('用户往上翻了就不往下拽', () => {
    // 这条是全部理由：他在读更早的一段，把他拽回去等于当着他的面把字抽走。
    expect(shouldStickToBottom(box(0, 1200, 700))).toBe(false);
    expect(shouldStickToBottom(box(300, 1200, 700))).toBe(false);
  });

  it('内容装得下时永远粘底', () => {
    // 装得下就没有可滚的距离，判成「不粘」只会让新消息落在视野外。
    const short = box(0, 300, 700);
    expect(distanceToBottom(short)).toBeLessThan(0);
    expect(shouldStickToBottom(short)).toBe(true);
    expect(stickToBottom(short)).toBe(0);
  });

  it('滚到底算的是内容高度减去视口高度，不会滚出负数', () => {
    expect(stickToBottom(box(0, 1200, 700))).toBe(500);
    expect(stickToBottom(box(0, 300, 700))).toBe(0);
  });
});
