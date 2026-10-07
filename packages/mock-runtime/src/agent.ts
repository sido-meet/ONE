import { ClientError } from '../../contracts/src/index.ts';
import type {
  AgentId,
  ErrorCode,
  Proposal,
  ProposalDomain,
  ReplyAgent,
} from '../../contracts/src/index.ts';
import { parseSchedule } from './schedule.ts';
import { parseNote } from './note.ts';

/**
 * 模拟 Agent（ADR-028）。
 *
 * 它只回答「说什么」：给一句话，回一段话，外加**可选**的一份草稿。它不知道对话存在，
 * 不知道 seq 怎么排，也不知道自己说的话会被记到哪里去 —— 那些都是本体的活。
 *
 * 真模型接进来时实现的是同一个 `ReplyAgent`，**不是**重写会话状态机。
 *
 * 故障注入也在这层：它造的是「用户的话没能变成回复」，而本体那边确实已经收到了一条
 * `message.created` —— 这才是注入要模拟的失败，不是「本体会失败」。
 */
export const agentCatalog: { id: AgentId; name: string }[] = [
  { id: 'chat', name: 'Chat Agent' },
  { id: 'claude-code', name: 'Claude Code' },
  { id: 'mcode', name: 'MCode' },
];

/**
 * 一句话的结果有三种，不是一件事加一个「没有」。
 *
 * - `draft`：起草成功，落一条提议。
 * - `incomplete`：**看起来确实是在记录，只差一个信息**。这句话必须原样说给
 *   用户听 ——「记一下」后面忘了跟内容，用户补一句就成了，告诉他「没听出要记
 *   什么」只会让他重打一遍。
 * - `chitchat`：就是闲聊。不解释、不提示、不起草。用户问「今天天气不错」，
 *   回一句「没听出要记什么」听着像系统在挑刺。
 *
 * `incomplete` 这一支曾经不存在：两个解析器都精心写了「能直接说给用户听的一句
 * 话」，`draftOf` 却只返回成功与否，那句话被整个丢掉 —— 用户永远不知道自己差
 * 哪一句，只能一次次试。
 *
 * 顺序是**日程先、笔记后**。「明天下午三点安排面试」里没有「记一下」，反过来
 * 「记一下：明天三点面试」里也没有日期词，两者不会同时命中；真要撞上了，日程
 * 优先 —— 把一条说好的会议记成笔记，代价比反过来大。
 */
type DraftOutcome =
  | { kind: 'draft'; domain: ProposalDomain; draft: Proposal['draft'] }
  | { kind: 'incomplete'; hint: string }
  | { kind: 'chitchat' };

function draftOf(input: string, lastReply?: string): DraftOutcome {
  const schedule = parseSchedule(input, new Date());
  if (schedule.ok)
    return { kind: 'draft', domain: 'calendar', draft: schedule.draft };
  const note = parseNote(input, lastReply);
  if (note.ok) return { kind: 'draft', domain: 'notes', draft: note.draft };
  // 两个域都说「差一点」才给提示。日程优先，所以它的话也是先说的。
  if (schedule.near) return { kind: 'incomplete', hint: schedule.reason };
  if (note.near) return { kind: 'incomplete', hint: note.reason };
  return { kind: 'chitchat' };
}

/** 环境变量里能写出来的故障名。写错的名字当没写，不猜。 */
const FAULTS: Record<string, ErrorCode> = {
  timeout: 'TIMEOUT',
  offline: 'UNAVAILABLE',
  busy: 'BUSY',
  validation: 'VALIDATION',
  permission: 'PERMISSION_DENIED',
};

/**
 * **故障注入**（0.1 验收脚本里那条「注入模拟超时/断线」）。
 *
 * 由 `ONE_FAULT=timeout|offline|busy|validation|permission` 开启，**只作用一次**：
 * 下一次回答抛出对应的错误，之后恢复正常。没有它，「失败能重试」只能靠杀本体
 * 验 —— 而本体七八百毫秒就重启回来了，窗口往往还没来得及报错就又连上，「那句话
 * 还在框里」与「重试按钮」这两段根本验不到。
 *
 * 放在解析**之后**：要让「这句话 ONE 收不了」原样成立，就不能先被别的检查拦下，
 * 那验到的就成了另一件事。
 *
 * 它只活在模拟层。真模型接进来之后这条整体退役 —— 那时超时是真实发生的，不需要注入。
 */
function takeInjectedFault(): ErrorCode | undefined {
  const raw = (process.env['ONE_FAULT'] ?? '').trim().toLowerCase();
  const code = FAULTS[raw];
  if (!code) return undefined;
  // 一次性：读完就摘掉，不然后面每一次发送都失败，重试按钮永远成功不了。
  delete process.env['ONE_FAULT'];
  return code;
}

/**
 * 三个模拟 Agent。它们行为一样，只有名字不同 —— 名字会出现在回复里，用户得能看出
 * 「这句是谁说的」，而这正是切换 Agent 要验证的东西。
 */
export function createMockAgents(): ReplyAgent[] {
  return agentCatalog.map(({ id, name }) => ({
    id,
    name,
    async reply({ text, lastReply }) {
      const attempt = draftOf(text, lastReply);
      // 注入排在解析之后：要让「这句话 ONE 收不了」原样成立。
      const injected = takeInjectedFault();
      if (injected) throw new ClientError(injected, '注入的模拟故障');
      if (attempt.kind === 'draft') {
        return {
          content: `我按“${text}”起草了一条${attempt.domain === 'calendar' ? '日程' : '笔记'}，确认后才会写进去。`,
          draft: { domain: attempt.domain, draft: attempt.draft },
        };
      }
      return {
        // 差一句就说差哪一句，别拿模拟回复把话头岔开；闲聊就老实说是闲聊。
        content:
          attempt.kind === 'incomplete'
            ? attempt.hint
            : `这是 ${name} 的模拟回复。你说：“${text}”。\n\n这段历史保存在同一个 ONE 对话里。回复结束后，你可以切换 Agent 继续体验。真实 AI 将在后续阶段接入。`,
      };
    },
  }));
}
