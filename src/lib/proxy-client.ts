import { ClientError } from '../../packages/contracts/src/index.ts';
import type { ProviderId } from '../../packages/contracts/src/wire.ts';
import type { CoreClient } from './core-link';

/**
 * 请另一个参与者做事（ADR-013/017）。
 *
 * 0.1 之前是"向主窗口发一条事件"，失败会静默消失。现在请求必须经过本体：
 * 对方没在运行、没装这个能力、或者没回应，都会变成一条具体的错误，
 * 界面才能把"宠物没开"告诉用户，而不是让按钮点了没反应。
 *
 * target 是寻址键而不是种类：同一个寻址键只能有一个参与者在跑，所以
 * 「找宠物」这件事从此不需要本体为种类写特判。
 */
export async function askClient(
  link: CoreClient,
  target: ProviderId,
  capability: string,
  args?: unknown,
): Promise<unknown> {
  try {
    return await link.callCapability(target, capability, args);
  } catch (cause) {
    throw new ClientError(
      cause instanceof ClientError ? cause.code : 'INTERNAL',
      describe(cause, target, capability),
      cause instanceof ClientError ? cause.details : undefined,
    );
  }
}

function describe(
  cause: unknown,
  target: ProviderId,
  capability: string,
): string {
  const message = cause instanceof Error ? cause.message : '';
  if (cause instanceof ClientError) {
    if (cause.code === 'NOT_FOUND' && message.includes('没有在运行'))
      return `${target} 没有在运行`;
    if (cause.code === 'NOT_FOUND') return `${target} 没有提供 ${capability}`;
    if (cause.code === 'TIMEOUT') return `${target} 没有回应，请稍后再试`;
    if (cause.code === 'UNAVAILABLE') return 'ONE 本体没有连接';
  }
  return message || '请求另一个参与者失败';
}

/** 拉起另一个参与者：能不能拉起由本体判断，没在安装清单里会明确拒绝。 */
export async function launchClient(
  link: CoreClient,
  provider: ProviderId,
): Promise<{ alreadyRunning?: boolean; launched?: string }> {
  try {
    const value = await link.launch(provider);
    return (value ?? {}) as { alreadyRunning?: boolean; launched?: string };
  } catch (cause) {
    throw new ClientError(
      cause instanceof ClientError ? cause.code : 'INTERNAL',
      cause instanceof ClientError && cause.code === 'NOT_FOUND'
        ? `${provider} 还没有安装`
        : cause instanceof Error
          ? cause.message
          : '拉起参与者失败',
    );
  }
}
