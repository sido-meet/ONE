/**
 * 聊天记录要不要跟着新内容往下滚（滚动纪律，P06）。
 *
 * **新消息到达时，只有用户本来就在底部才往下滚。** 他往上翻是为了读刚才那条，
 * 把他拽回底部等于在他读东西的时候把东西从眼前抽走 —— 而且他不知道为什么。
 * 这不是「滚动条别乱动」这种小心思：宠物端收到一条回复的时候，用户往往正在
 * 上面读更早的一段。
 *
 * 全部写成对数字的纯函数，不碰 DOM：判断逻辑是这个功能的全部，绑到元素上
 * 之后既没法单测，也容易在 resize 之类的地方写错一次。
 */

/** 容差。低于这个像素就算「不在底部」。 */
export const BOTTOM_TOLERANCE_PX = 24;

/** 滚动位置的最小信息。给元素布局读出来的三个数即可。 */
export interface ScrollBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** 离底部还有多远。0 就是贴着底。内容装得下时是负数（没有可滚的距离）。 */
export function distanceToBottom(box: ScrollBox): number {
  return box.scrollHeight - box.clientHeight - box.scrollTop;
}

/**
 * 该不该粘在底部。
 *
 * 内容装得下（没有可滚的距离）时永远为真：这时「保持位置」和「跟到底」是
 * 同一件事，用户根本没法往上翻，把它判成「不粘」只会让新消息落在视野外。
 */
export function shouldStickToBottom(
  box: ScrollBox,
  tolerance = BOTTOM_TOLERANCE_PX,
): boolean {
  const distance = distanceToBottom(box);
  if (distance <= 0) return true;
  return distance <= tolerance;
}

/** 滚到底。写回 `scrollTop` 而不是 `scrollTo`，免得在测试环境里依赖布局。 */
export function stickToBottom(box: ScrollBox): number {
  return Math.max(0, box.scrollHeight - box.clientHeight);
}
