import { describe, expect, it } from 'vitest';
import { ClientError } from '../../packages/contracts/src/index.ts';
import type { ErrorCode } from '../../packages/contracts/src/index.ts';
import { failureOf, reasonOf } from './send';

/**
 * 发送失败：留住那句话，说清发生了什么，重试按钮不该骗人。
 */
describe('发送失败', () => {
  it('留住没送出去的那句话', () => {
    const failure = failureOf(
      '帮我看看这个',
      new ClientError('UNAVAILABLE', ''),
    );
    expect(failure.text).toBe('帮我看看这个');
  });

  it('每个错误码都有一句给用户看的话，不是一串代码', () => {
    const codes = [
      'BUSY',
      'TIMEOUT',
      'UNAVAILABLE',
      'VALIDATION',
      'NOT_FOUND',
      'CONFLICT',
      'PERMISSION_DENIED',
      'DISPOSED',
      'INTERNAL',
    ] as const;
    for (const code of codes) {
      const failure = failureOf('x', new ClientError(code, '原始技术消息'));
      expect(failure.reason).toBeTruthy();
      // 不能把本体回传的技术消息原样甩给用户。
      expect(failure.reason).not.toContain('原始技术消息');
    }
  });

  it('只有「再来一次可能就成了」的错才给重试', () => {
    const retryable = (code: ErrorCode) =>
      failureOf('x', new ClientError(code, '')).retryable;
    expect(retryable('TIMEOUT')).toBe(true);
    expect(retryable('UNAVAILABLE')).toBe(true);
    expect(retryable('BUSY')).toBe(true);

    // 这三个重发一次结果一模一样，给个点下去必然还是失败的按钮是在骗人。
    expect(retryable('VALIDATION')).toBe(false);
    expect(retryable('PERMISSION_DENIED')).toBe(false);
    expect(retryable('NOT_FOUND')).toBe(false);
  });

  it('不认识的东西按内部问题算，且不因此变成可重试', () => {
    const failure = failureOf('x', new Error('boom'));
    expect(failure.code).toBe('INTERNAL');
    expect(failure.reason).toBeTruthy();
  });

  it('代码明明不在九种之列时不认它', () => {
    const failure = failureOf(
      'x',
      Object.assign(new Error('x'), { code: 'WAT', name: 'ClientError' }),
    );
    expect(failure.code).toBe('INTERNAL');
  });

  it('没有失败就没有话说', () => {
    expect(reasonOf(undefined)).toBe('');
  });
});
