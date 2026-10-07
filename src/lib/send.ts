import {
  ClientError,
  isErrorCode,
} from '../../packages/contracts/src/index.ts';
import type { ErrorCode } from '../../packages/contracts/src/index.ts';

/**
 * 发送失败时**留住那句话**，并说清发生了什么、能做什么（P06）。
 *
 * 两条纪律：
 *
 * 1. **失败不清空输入框。** 清掉等于用户白打一遍，而白打的那遍往往还不一样。
 *    送出去了才清 —— 送不出去的话还在框里，旁边有个「重试」。
 * 2. **同一句话重试有没有意义，是能判的。** `VALIDATION`（这句话收不了）与
 *    `PERMISSION_DENIED`（没授权）重发一次结果一模一样，给一个点下去必然还是
 *    失败的「重试」按钮是在骗人。`TIMEOUT` / `UNAVAILABLE` / `BUSY` 则相反 ——
 *    它们说的都是「再来一次可能就成了」。
 *
 * 判据是**同样的输入会不会有不同的结果**，不是「这个错看起来严不严重」。
 */

export interface SendFailure {
  /** 没送出去的那句话。界面据此提供重试与「算了」。 */
  text: string;
  code: ErrorCode;
  /** 给用户看的一句话：发生了什么 + 现在能做什么。 */
  reason: string;
  retryable: boolean;
}

/** 每个错误码对应的话。写成人话，且说清下一步。 */
const REASONS: Record<ErrorCode, string> = {
  BUSY: '上一个还没回完，等它说完再发。',
  TIMEOUT: 'ONE 本体没有回应，可能已经不在了。',
  UNAVAILABLE: 'ONE 本体没有连接，这句话没能送出去。',
  VALIDATION: '这句话 ONE 收不了，发送前检查一下内容。',
  NOT_FOUND: '找不到这个对话了，它可能已经被删掉。',
  CONFLICT: '这件事刚刚已经处理过了，界面上还是旧的样子。',
  PERMISSION_DENIED: '还没有授权，ONE 不能替你去动它。',
  DISPOSED: '这个客户端已经关闭了。',
  INTERNAL: 'ONE 内部出了点问题，不是你说错了什么。',
};

/** 重发同一句话会得到不同结果的，才给「重试」。 */
const RETRYABLE: Record<ErrorCode, boolean> = {
  BUSY: true,
  TIMEOUT: true,
  UNAVAILABLE: true,
  INTERNAL: true,
  VALIDATION: false,
  NOT_FOUND: false,
  CONFLICT: false,
  PERMISSION_DENIED: false,
  DISPOSED: false,
};

/** 不认识的错误一律按「内部出了点问题」算，但不因此把它变成可重试的。 */
const fallbackCode = (cause: unknown): ErrorCode =>
  cause instanceof ClientError && isErrorCode(cause.code)
    ? cause.code
    : 'INTERNAL';

export function failureOf(text: string, cause: unknown): SendFailure {
  const code = fallbackCode(cause);
  return {
    text,
    code,
    reason: REASONS[code],
    retryable: RETRYABLE[code],
  };
}

/** 界面上显示哪一句。没有失败就显示空串，省掉调用方到处判断。 */
export function reasonOf(failure: SendFailure | undefined): string {
  return failure?.reason ?? '';
}
