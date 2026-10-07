/**
 * 本体启动的**先后**：先占住管道，再拉别的东西。
 *
 * 这不是风格问题，是实机挖出来的洞。曾经反着来：拉起安装清单里的提供方在前、抢管道
 * 在后。于是「第二个本体」（管道已被占、注定要退出）在退出**之前**就把一整套提供方
 * 拉了起来 —— 它们连到真正的本体上，名册里每个寻址键出现两个参与者，而它们**没有
 * 任何人管**（本体不管别人的孩子，提供方只知道管道断了才退，可管道没断）。
 * 后果是调用时挑中先来的那个，用户看到的现象是「我改了日历，界面没反应」。
 *
 * 更麻烦的是它**看不出来**：多出来的参与者是静默的，日志里只多一行「正在拉起」。
 *
 * 所以规矩定死：**确定「我是那个本体」之前，不许有任何副作用。** 这一条正好也是
 * 「一个寻址键只能有一个参与者在跑」（ADR-017）的前提 —— 前提是有人守住，而守住
 * 的动作就是抢到管道那一刻。
 */

/** 抢管道。返回 false 表示管道已被占：已经有本体在跑，本次启动作废。 */
export type Claim = () => Promise<boolean>;

export interface StartupHooks {
  claim: Claim;
  /**
   * 抢不到时做什么 —— 正常路径，不是故障。**只有这一条会走。**
   * 说清「已经有本体在跑」就够了，别把栈打到用户脸上。
   */
  claimFailed: () => void;
  /**
   * 抢到之后才做的事，按数组顺序一件一件来。
   *
   * 一步一步来（而不是一个 `for` 塞在调用方）是为了让「哪些副作用发生在抢到之后」
   * 这件事**写在数据结构里**，而不是靠读者的眼力扫代码顺序。
   *
   * 收 `Promise<unknown>` 而不是 `Promise<void>`：步骤的返回值没人看，写成 `void`
   * 只会逼调用方把 `array.push()` 那类表达式硬塞进花括号。
   */
  steps: (() => Promise<unknown>)[];
}

/**
 * 抢管道，然后才做那几件事。
 *
 * @returns true 表示「我就是本体」；false 表示「已经有本体了，本次启动作废」，
 *   此时 `steps` 一个都没跑，`claimFailed` 是唯一被调用的钩子。
 */
export async function becomeTheCore(hooks: StartupHooks): Promise<boolean> {
  if (!(await hooks.claim())) {
    hooks.claimFailed();
    return false;
  }
  for (const step of hooks.steps) await step();
  return true;
}

/**
 * 拉起安装清单里的提供方，得到一串**脚本名**。
 *
 * 按**脚本**去重，不是按寻址键：日历与笔记由同一个进程提供，拉两次就会有两个进程各
 * 报一次身份，名册里凭空多出两个参与者，调用时还会挑中先来的那个。
 * 一个寻址键只能有一个参与者在跑 —— 这是协议的前提（ADR-017）。
 *
 * 没装的提供方不在这儿出现：`installed` 之外的 id 说明用户压根没装那个源，
 * 拉它等于凭空多一个参与者。
 */
export function providerScriptsOf(
  installed: readonly string[],
  launchScripts: Readonly<Record<string, string>>,
): string[] {
  const scripts = new Set<string>();
  for (const id of installed) {
    const script = launchScripts[id];
    if (script) scripts.add(script);
  }
  return [...scripts];
}
