/**
 * 每对话各留一份草稿（P06）。
 *
 * 一个输入框只存一个字符串，于是切到别的对话再切回来，刚才打了一半的那句就没了。
 * 用户会重打一遍 —— 而重打的那遍往往还不一样，等于把两次思路都丢了。
 *
 * **草稿跟着对话走，不跟着窗口走**：切对话时把当前这句存进去、取出目标对话那份，
 * 换句话说这是「每对话草稿」而不是「全局草稿」。
 *
 * 刻意**不落盘**。0.1 是内存模式（刷新后回到初始状态是明写出来的验收项），
 * 草稿写进 localStorage 会让关掉再打开的用户看到自己以为已经没了的话。
 */

export interface DraftBook {
  read(conversationId: string): string;
  /** 输入框里的每一次变化都往这儿写，切换时才不会漏。 */
  save(conversationId: string, text: string): void;
  /** 发送成功后调用：对话已经多了一条消息，这份草稿的使命结束。 */
  clear(conversationId: string): void;
  /** 换了对话时返回目标对话该显示什么。 */
  take(conversationId: string): string;
  /** 对话没了（新建、删除）时不要留下孤儿草稿。 */
  forget(conversationId: string): void;
  size(): number;
}

export function createDraftBook(): DraftBook {
  const drafts = new Map<string, string>();

  const save = (conversationId: string, text: string) => {
    // 空的不占位：否则对话列表一大，草稿表里全是空字符串。
    if (text) drafts.set(conversationId, text);
    else drafts.delete(conversationId);
  };

  return {
    read: (conversationId) => drafts.get(conversationId) ?? '',
    save,
    clear: (conversationId) => drafts.delete(conversationId),
    take: (conversationId) => {
      const text = drafts.get(conversationId) ?? '';
      drafts.delete(conversationId);
      return text;
    },
    forget: (conversationId) => drafts.delete(conversationId),
    size: () => drafts.size,
  };
}
