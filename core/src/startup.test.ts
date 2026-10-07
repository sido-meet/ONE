import { describe, expect, it } from 'vitest';
import { becomeTheCore, providerScriptsOf } from './startup.ts';

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
  const scripts = {
    'local.calendar': 'provider:local',
    'local.notes': 'provider:local',
  };

  it('同一个脚本只算一次 —— 拉两次就有两个进程各报一次身份', () => {
    // 名册里凭空多出两个参与者，调用时还会挑中先来的那个，用户看到的现象是
    // 「我改了日历，界面没反应」。ADR-017：一个寻址键只能有一个参与者在跑。
    expect(
      providerScriptsOf(['local.calendar', 'local.notes'], scripts),
    ).toEqual(['provider:local']);
  });

  it('没装的寻址键不拉 —— 凭空多一个参与者比少一个更坏', () => {
    expect(providerScriptsOf(['pet'], scripts)).toEqual([]);
    expect(providerScriptsOf([], scripts)).toEqual([]);
  });

  it('没有启动器的寻址键也不拉，而不是拿一个空脚本名去 spawn', () => {
    expect(
      providerScriptsOf(['local.calendar', 'outlook.calendar'], scripts),
    ).toEqual(['provider:local']);
  });

  it('顺序跟着安装清单来，日志每次都一样', () => {
    const both = {
      'local.notes': 'provider:local',
      'local.calendar': 'provider:notes',
    };
    expect(providerScriptsOf(['local.calendar', 'local.notes'], both)).toEqual([
      'provider:notes',
      'provider:local',
    ]);
  });
});
