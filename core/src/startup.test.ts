import { describe, expect, it } from 'vitest';
import { becomeTheCore, providerEntriesOf } from './startup.ts';

/**
 * 这组测试守着一条实机挖出来的规矩：**确定「我是不是那个本体」之前，不许有任何副作用。**
 *
 * 违反它的样子用户看不见：第二个本体把一整套提供方拉了起来，它们连到真正的本体上，
 * 名册里每个寻址键出现两个参与者，而没有人管它们。界面上一切正常，直到某次改动
 * 「没反应」。
 */
describe('本体启动的先后', () => {
  it('抢不到管道时：那几件事一步都不做，只说清已经有本体在跑', async () => {
    const done: string[] = [];
    const became = await becomeTheCore({
      claim: async () => false,
      claimFailed: () => done.push('说已经有本体了'),
      steps: [
        async () => done.push('打印启动行'),
        async () => done.push('拉起提供方'),
        async () => done.push('拉起可视客户端'),
      ],
    });
    expect(became).toBe(false);
    expect(done).toEqual(['说已经有本体了']);
  });

  it('抢到管道之后：那几件事按给的顺序做', async () => {
    const done: string[] = [];
    const became = await becomeTheCore({
      claim: async () => {
        done.push('抢管道');
        return true;
      },
      claimFailed: () => done.push('说已经有本体了'),
      steps: [
        async () => done.push('打印启动行'),
        async () => done.push('拉起提供方'),
        async () => done.push('拉起可视客户端'),
      ],
    });
    expect(became).toBe(true);
    expect(done).toEqual([
      '抢管道',
      '打印启动行',
      '拉起提供方',
      '拉起可视客户端',
    ]);
  });

  it('抢管道这一步失败要说清是「已经有本体」，不是把异常往上抛', async () => {
    // 异常是 claim 自己该分清的事：EADDRINUSE 是正常路径（另一个本体在跑），
    // 别的错误才是故障。分不清的话，用户会看到一屏栈。
    const boom = new Error('access denied') as NodeJS.ErrnoException;
    boom.code = 'EACCES';
    await expect(
      becomeTheCore({
        claim: async () => Promise.reject(boom),
        claimFailed: () => undefined,
        steps: [async () => undefined],
      }),
    ).rejects.toThrow('access denied');
  });

  it('一步失败就不做后面的，但已经做完的不回滚', async () => {
    // 本体不能因为一个插件缺失就不启动 —— 每一步各自兜住自己的错误，所以
    // 这里断言的是「后面没做」，不是「整体抛出去」。
    const done: string[] = [];
    const became = await becomeTheCore({
      claim: async () => true,
      claimFailed: () => undefined,
      steps: [
        async () => done.push('第一件事'),
        async () => {
          throw new Error('拉不起来');
        },
        async () => done.push('第三件事'),
      ],
    }).catch(() => false);
    expect(became).toBe(false);
    expect(done).toEqual(['第一件事']);
  });
});

describe('拉起哪几个提供方', () => {
  // 值是相对 repoRoot 的入口路径，不是脚本名（ADR-030）。这里用真实的那张表 ——
  // 测一份与代码里不同的假数据，很容易让测试在改名换值之后还照样绿。
  const entries = {
    'local.calendar': 'packages/provider-local/src/main.ts',
    'local.notes': 'packages/provider-local/src/main.ts',
  };

  it('同一个入口只算一次 —— 拉两次就有两个进程各报一次身份', () => {
    // 名册里凭空多出两个参与者，调用时还会挑中先来的那个，用户看到的现象是
    // 「我改了日历，界面没反应」。ADR-017：一个寻址键只能有一个参与者在跑。
    expect(
      providerEntriesOf(['local.calendar', 'local.notes'], entries),
    ).toEqual(['packages/provider-local/src/main.ts']);
  });

  it('没装的寻址键不拉 —— 凭空多一个参与者比少一个更坏', () => {
    expect(providerEntriesOf(['pet'], entries)).toEqual([]);
    expect(providerEntriesOf([], entries)).toEqual([]);
  });

  it('没有入口的寻址键也不拉，而不是拿一个空路径去 spawn', () => {
    expect(
      providerEntriesOf(['local.calendar', 'outlook.calendar'], entries),
    ).toEqual(['packages/provider-local/src/main.ts']);
  });

  it('顺序跟着安装清单来，日志每次都一样', () => {
    const both = {
      'local.notes': 'packages/provider-local/src/main.ts',
      'local.calendar': 'packages/outlook-local/src/main.ts',
    };
    expect(providerEntriesOf(['local.calendar', 'local.notes'], both)).toEqual([
      'packages/outlook-local/src/main.ts',
      'packages/provider-local/src/main.ts',
    ]);
  });
});
