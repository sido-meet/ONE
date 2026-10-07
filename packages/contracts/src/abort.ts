/**
 * 可被 signal 打断的等待 —— **取消要掐断等待，不是等它走完**（ADR-031）。
 *
 * 这个函数存在的原因是一个具体到有点难堪的发现：用户点了「停止回复」，调用方拿着
 * 生成器调 `iterator.return()`，但生成器正挂在一次 `await sleep(…)` 上。`return`
 * 的请求**排在那个 pending 的 `next` 后面**，于是这一次等待照走、这一段照交，等它
 * 终于走到 `return` 的时候，用户早就看着界面停了 —— 而对面还在收 token。
 *
 * 所以取消的可靠通道是 `AbortSignal`：等待本身被它叫醒，醒来第一眼就看见 aborted，
 * 立刻不交。`return()` 仍然要调（它负责跑 `finally`、释放 socket），但它只是**善后**，
 * 不是**掐断**。
 *
 * 醒来时是 resolve 而不是 reject：取消不是错误。它是用户按的按钮，Agent 不该为此
 * 抛栈，真正要记的是「这次 Run 结束了」——那由运行时记账。
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  // 已经取消了就别再等：留着这一次定时器只会让「停止」看起来晚了 ms 毫秒。
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      // 摘掉监听器，否则长时间回复 + 反复取消会一路攒下来。
      signal?.removeEventListener('abort', wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    signal?.addEventListener('abort', wake, { once: true });
  });
}
