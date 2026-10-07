import { describe, expect, it } from 'vitest';
import { createMemoryRuntime } from '../../packages/mock-runtime/src/index.ts';
import {
  PAGE_READ_CAPABILITY,
  WIRE_VERSION,
  parseClientMessage,
} from '../../packages/contracts/src/index.ts';
import type { CoreMessage } from '../../packages/contracts/src/index.ts';
import { createCore } from './core.ts';
import { ClientError } from '../../packages/contracts/src/errors.ts';
import type { Connection, Core } from './core.ts';

/**
 * `page.read` 的仲裁（ADR-018）。
 *
 * 宿主拿到的是一段 HTML，来源是一个自报的地址，因此本体是唯一能确认「这个寻址键
 * 真的带着页面」的地方。下面每一条都是「宿主说了不算」的反面：提供方没有自己申报，
 * 本体就不转交；申报了却答不上来，回执里也不会出现页面内容。
 */

type Session = ReturnType<Core['connect']>;

function core(options: { capabilityTimeoutMs?: number } = {}): Core {
  return createCore(createMemoryRuntime(), {
    version: 'test',
    installed: ['pet'],
    ...options,
  });
}

interface Participant {
  session: Session;
  sent: CoreMessage[];
  /** 提供方真答内容时用它；不答就是缺席。 */
  answer?: (args: unknown) => unknown;
}

function connect(
  theCore: Core,
  client: {
    provider: string;
    role?: string;
    capabilities?: string[];
    view?: { entry: string };
    answer?: (args: unknown) => unknown;
  },
): Participant {
  const sent: CoreMessage[] = [];
  const state: { session: Session } = { session: null };
  const connection: Connection = {
    send: (message) => {
      sent.push(message);
      // 提供方收到 invoke 就当场回 —— 真插件也是这么干的（走管道，只是这里在
      // 同一个进程里同步完成）。回执要走 core：会话本身不认识 handleMessage。
      if (message.t !== 'invoke' || !state.session) return;
      // 没给 answer 就当这个提供方不会答：本体那边会等到超时，正好是那条用例要的。
      if (!client.answer) return;
      try {
        theCore.handleMessage(state.session, {
          t: 'capability.result',
          id: message.id,
          ok: true,
          value: client.answer(message.args),
        });
      } catch (error) {
        // 失败的回执要带码：只有一句话的话，上游只能一律当成内部错误。
        theCore.handleMessage(state.session, {
          t: 'capability.result',
          id: message.id,
          ok: false,
          code: error instanceof ClientError ? error.code : 'INTERNAL',
          message: error instanceof Error ? error.message : '提供方处理失败',
        });
      }
    },
    close: () => sent.push({ t: 'rejected', message: 'closed' }),
  };
  const session = theCore.connect(connection, {
    t: 'hello',
    v: WIRE_VERSION,
    client: {
      role: client.role ?? 'provider',
      provider: client.provider,
      label: client.provider,
      capabilities: client.capabilities ?? [],
      ...(client.view ? { view: client.view } : {}),
    },
  });
  state.session = session;
  return { session, sent, answer: client.answer };
}

async function readPath(
  pet: Participant,
  theCore: Core,
  provider: string,
  path = 'index.html',
  waitMs = 200,
) {
  const id = `read-${Math.random().toString(36).slice(2)}`;
  theCore.handleMessage(pet.session!, {
    t: 'page.read',
    id,
    provider,
    path,
  } as never);
  // 转发是异步的：本体 → 提供方 → 本体。轮询到有回执为止，这样"超时"那条用例
  // 才真的等到了它要等的那次超时。
  const deadline = Date.now() + waitMs;
  for (;;) {
    const answer = pet.sent.filter(
      (item) => item.t === 'result' && item.id === id,
    );
    if (answer[0]) return answer[0] as ReturnType<typeof asResult>;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const asResult = (message: {
  t: string;
  id?: string;
  ok?: boolean;
  value?: unknown;
}) =>
  message as
    | { t: 'result'; id: string; ok: true; value?: unknown }
    | {
        t: 'result';
        id: string;
        ok: false;
        error: { code: string; message: string };
      };

describe('插件页面取用', () => {
  it('转交给声明了页面的提供方，并把内容原样带回', async () => {
    const theCore = core();
    const pet = connect(theCore, { provider: 'pet', role: 'pet' });
    const asked: unknown[] = [];
    const plugin = connect(theCore, {
      provider: 'local.calendar',
      capabilities: [PAGE_READ_CAPABILITY],
      view: { entry: 'calendar.html' },
      // 参数在断言之外先记下来：断言一旦在回执链路里抛错，本体只会回一个
      // INTERNAL，测出来的是"失败"而不是"参数不对"。
      answer: (args) => {
        asked.push(args);
        return { mime: 'text/html; charset=utf-8', content: '<h1>日历</h1>' };
      },
    });

    const answer = await readPath(
      pet,
      theCore,
      'local.calendar',
      'calendar.html',
    );
    expect(asked).toEqual([{ path: 'calendar.html' }]);
    expect(answer?.ok).toBe(true);
    expect(answer?.ok && answer.value).toEqual({
      mime: 'text/html; charset=utf-8',
      content: '<h1>日历</h1>',
    });
    // 宿主问的是本体，提供方收到的是本体的 invoke。
    expect(plugin.sent.some((item) => item.t === 'invoke')).toBe(true);
    expect(pet.sent.some((item) => item.t === 'invoke')).toBe(false);
  });

  it('没申报页面的提供方拿不到页面，哪怕它自己会答 page.read', async () => {
    const theCore = core();
    const pet = connect(theCore, { provider: 'pet', role: 'pet' });
    const quiet = connect(theCore, {
      provider: 'local.notes',
      capabilities: [PAGE_READ_CAPABILITY],
      answer: () => ({ mime: 'text/html', content: '<h1>偷偷摸摸</h1>' }),
    });

    const answer = await readPath(pet, theCore, 'local.notes');
    expect(answer?.ok).toBe(false);
    expect(answer?.ok === false && answer.error.code).toBe('NOT_FOUND');
    expect(answer?.ok === false && answer.error.message).toContain(
      '没有自带页面',
    );
    // 一个字节都不能出去。
    expect(quiet.sent.some((item) => item.t === 'invoke')).toBe(false);
  });

  it('申报了页面却没提供 page.read，本体不放行', async () => {
    const theCore = core();
    const pet = connect(theCore, { provider: 'pet', role: 'pet' });
    connect(theCore, {
      provider: 'local.calendar',
      capabilities: [],
      view: { entry: 'calendar.html' },
      answer: () => ({ mime: 'text/html', content: '<h1>不该出现</h1>' }),
    });

    const answer = await readPath(pet, theCore, 'local.calendar');
    expect(answer?.ok).toBe(false);
    expect(answer?.ok === false && answer.error.code).toBe('NOT_FOUND');
    expect(answer?.ok === false && answer.error.message).toContain(
      PAGE_READ_CAPABILITY,
    );
  });

  it('提供方没在运行时说「没有在运行」，而不是「没这个文件」', async () => {
    const theCore = core();
    const pet = connect(theCore, { provider: 'pet', role: 'pet' });

    const answer = await readPath(pet, theCore, 'local.calendar');
    expect(answer?.ok).toBe(false);
    // 这两种情况要分开：一个是"插件挂了"，另一个是"插件里没这个文件"。
    expect(answer?.ok === false && answer.error.code).toBe('UNAVAILABLE');
    expect(answer?.ok === false && answer.error.message).toContain(
      '没有在运行',
    );
  });

  it('提供方答不上来时不把空内容当成功', async () => {
    // 短超时：这里要的就是"没人答"这条路径，不必真等五秒。
    const theCore = core({ capabilityTimeoutMs: 30 });
    const pet = connect(theCore, { provider: 'pet', role: 'pet' });
    connect(theCore, {
      provider: 'local.calendar',
      capabilities: [PAGE_READ_CAPABILITY],
      view: { entry: 'calendar.html' },
      // 声明了能力却不答：本体的 invoke 会超时，之前的内容也不能被缓存顶上。
      answer: undefined,
    });

    const answer = await readPath(
      pet,
      theCore,
      'local.calendar',
      'index.html',
      400,
    );
    expect(answer?.ok).toBe(false);
    expect(answer?.ok === false && answer.error.code).toBe('TIMEOUT');
  });

  it('提供方的错误码一路带到界面，而不是统统变成内部错误', async () => {
    // 实机抓到的：提供方报了 NOT_FOUND，回执里只有一句话，壳只能当成 502。
    // 页面「没这个文件」与插件「里面坏了」在用户那里必须长得不一样（ADR-016）。
    const theCore = core();
    const pet = connect(theCore, { provider: 'pet', role: 'pet' });
    connect(theCore, {
      provider: 'local.calendar',
      capabilities: [PAGE_READ_CAPABILITY],
      view: { entry: 'index.html' },
      answer: () => {
        throw new ClientError('NOT_FOUND', '这个插件没有 calendar.html');
      },
    });

    const answer = await readPath(
      pet,
      theCore,
      'local.calendar',
      'calendar.html',
    );
    expect(answer?.ok).toBe(false);
    expect(answer?.ok === false && answer.error.code).toBe('NOT_FOUND');
    expect(answer?.ok === false && answer.error.message).toContain(
      'calendar.html',
    );
  });

  it('名册里的入口跟着参与者一起进出', () => {
    const theCore = core();
    connect(theCore, {
      provider: 'local.calendar',
      capabilities: [PAGE_READ_CAPABILITY],
      view: { entry: 'calendar.html' },
    });
    expect(theCore.roster()[0]?.view).toEqual({ entry: 'calendar.html' });

    theCore.disconnect(theCore.roster()[0]?.id ?? '');
    expect(theCore.roster()).toHaveLength(0);
  });

  it('声明了非法入口的参与者被当作没有页面', () => {
    // 路径守卫在协议解析那一层：坏入口静默降级成"没申报"，不会变成一个宿主
    // 会拿去拼地址的字符串。
    const message = parseClientMessage({
      t: 'hello',
      v: WIRE_VERSION,
      client: {
        role: 'provider',
        provider: 'local.calendar',
        label: '日历',
        capabilities: [],
        view: { entry: '../../secrets.json' },
      },
    });
    expect(message?.t).toBe('hello');
    expect(message?.t === 'hello' ? message.client.view : 'not hello').toBe(
      undefined,
    );
  });
});
