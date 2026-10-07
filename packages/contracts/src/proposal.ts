import { ClientError } from './errors.ts';

/**
 * 待确认的领域写入提议（ADR-022）。
 *
 * 提议是**会话与领域之间那道缝**：Agent 说「我要建一个日程」，本体说「行，
 * 我来建」。它必须在写入发生**之前**落到用户眼前 —— 日历和笔记都是用户的数据，
 * 猜错时间、猜错标题，代价由用户承担。
 *
 * 四条规矩，都是这几轮踩坑长出来的：
 *
 * 1. **幂等键由提议 id 派生，不进草稿。** 「重复确认不重复创建」如果靠调用方
 *    记得传对键，那只是一句约定；键由提议自己决定之后它是结构性的 —— 点十次
 *    和点一次完全等价。
 * 2. **提议只描述意图，不复制领域实体。** 它带 `sourceConversationId` 是因为
 *    「这条日程是哪句话来的」必须答得出来（0.1 验收：笔记要能返回来源对话）。
 * 3. **认不出就说认不出。** 草稿里的时间是解析器算的；解析器没把握时必须让
 *    Agent 说出来，而不是塞一个看起来合理的时间。
 * 4. **解决一次就定了。** 卡片点完变成结果陈述，按钮消失；要改主意就在聊天里
 *    再说一遍，那会是一条新提议。这比让状态在 created/rejected 之间来回翻便宜，
 *    也比「已经创建的提议再点拒绝」少一条撒谎的路。
 */

export type ProposalDomain = 'calendar' | 'notes';
export type ProposalStatus = 'pending' | 'created' | 'rejected';

/**
 * 日程草稿。字段与 `CalendarCreateInput` 对齐，但**不含幂等键**（见文件头第 1 条）。
 * 时间一律带时区偏移：裸本地时间会让「下午三点」在换时区的机器上漂掉。
 */
export interface CalendarDraft {
  title: string;
  startsAt: string;
  endsAt: string;
  /** IANA 名称，例如 `Asia/Shanghai`。界面上要把它显示出来，用户才敢按确认。 */
  timeZone: string;
}

export interface NoteDraft {
  title: string;
  body: string;
}

interface ProposalBase {
  id: string;
  status: ProposalStatus;
  /** 卡片挂在哪条消息下面。跨窗口重放时靠它归位。 */
  messageId: string;
  workspaceId: string;
  sourceConversationId: string;
  createdAt: string;
  /** 确认后本体回填：写进去的到底是哪一个实体。界面靠它回答「进哪儿了」。 */
  created?: { entityId: string; at: string };
  /**
   * 拒绝后本体回填：为什么没写。
   *
   * 拒绝一张卡片不是「让它消失」—— 用户下次还敢不敢按确认，取决于他能不能看见
   * 上一次为什么没成。
   */
  rejected?: { reason: string; at: string };
}

/**
 * 判别联合而不是 `{domain, draft: ProposalDraft}`：`domain: 'calendar'` 配一份
 * `NoteDraft` 在类型上就该通不过，而不是等到本体边界才发现。
 */
export type Proposal =
  | (ProposalBase & { domain: 'calendar'; draft: CalendarDraft })
  | (ProposalBase & { domain: 'notes'; draft: NoteDraft });

export interface ProposalResolveInput {
  proposalId: string;
  decision: 'confirm' | 'reject';
  reason?: string;
}

/**
 * 一次处理的结果。`applied` 是这里唯一需要解释的字段：重复点确认时它是
 * false，界面据此说「已经创建过了，没有重复创建」，而不是假装又干了一遍。
 *
 * `reason` 只在拒绝时有意义，但**不设成可选的 discriminated 分支**：一次处理
 * 走完就结束了，读结果的人不该靠「status 是不是 rejected」去猜 reason 存不存在。
 */
export interface ProposalResolution {
  proposalId: string;
  applied: boolean;
  status: 'created' | 'rejected';
  entityId?: string;
  reason?: string;
  at: string;
}

/**
 * 解析「确认还是拒绝」。
 *
 * 确认与拒绝是**同一条命令的两个分支**，不是两条命令：它们解决的是同一件事
 * —— 这条提议还作不作数。分成两条命令，「已解决的提议再次被解决」就有两种
 * 走法要分别堵，而只有一条命令时才谈得上「堵一次」。
 *
 * 确认**不接受**自定义幂等键，也不接受覆盖草稿：用户点确认的语义是「就这样
 * 写」，不是「按我临时改的写」。要改就拒绝，然后重新说一遍。
 */
export function parseProposalResolve(input: unknown): ProposalResolveInput {
  const record =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : fail('提议处理必须是一个对象');
  const proposalId =
    typeof record.proposalId === 'string' ? record.proposalId.trim() : '';
  if (!proposalId) fail('缺少提议 ID');
  if (record.decision !== 'confirm' && record.decision !== 'reject')
    fail('decision 只能是 confirm 或 reject');

  for (const key of Object.keys(record))
    if (!['proposalId', 'decision', 'reason'].includes(key))
      fail(`提议处理不支持的字段：${key}`);

  if (record.decision === 'confirm') {
    if (record.reason !== undefined) fail('确认不能带原因，只有拒绝能');
    return { proposalId, decision: 'confirm' };
  }
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  if (!reason) fail('拒绝必须写明原因');
  if (reason.length > 500) fail('拒绝原因最多 500 个字符');
  return { proposalId, decision: 'reject', reason };
}

/** 确认用的幂等键就是提议 id 派生的，不接受外部指定（文件头第 1 条）。 */
export function proposalIdempotencyKey(proposalId: string): string {
  return `proposal:${proposalId}`;
}

/** 已经解决过的提议：返回既有结果，不重复写入。这是幂等的定义，不是将就。 */
export function settledResolution(proposal: Proposal): ProposalResolution {
  const at =
    proposal.created?.at ?? proposal.rejected?.at ?? proposal.createdAt;
  return {
    proposalId: proposal.id,
    applied: false,
    status: proposal.status === 'created' ? 'created' : 'rejected',
    ...(proposal.created ? { entityId: proposal.created.entityId } : {}),
    ...(proposal.rejected ? { reason: proposal.rejected.reason } : {}),
    at,
  };
}

function fail(message: string): never {
  throw new ClientError('VALIDATION', message);
}
