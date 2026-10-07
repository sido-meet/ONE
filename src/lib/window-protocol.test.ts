import { describe, expect, it, vi } from 'vitest';
import { createMockClient } from '../../packages/mock-runtime/src/index';
import { createCore } from '../../core/src/core';
import { CAPABILITY, WIRE_VERSION } from '../../packages/contracts/src/wire';
import type {
  ClientMessage,
  CoreMessage,
} from '../../packages/contracts/src/wire';
import { createCoreClient, EMPTY_SNAPSHOT } from './core-link';
import type { CoreChannel, CoreClient } from './core-link';
import { createMemoryCoreChannel } from './transport';

/**
 * 客户端与本体之间的行为，不是实现的复述（ADR-013）。每个用例都用一个真的
 * 本体跑，因此这些断言在换掉传输层之后依然成立。
 */

interface Peer {
  link: CoreClient;
  hello: ClientMessage;
  received: ClientMessage[];
}

function peer(
  provider: string,
  capabilities: string[],
  core = createCore(createMockClient(), {
    version: 'test',
    installed: ['pet', 'desktop'],
  }),
): Peer {
  const hello: ClientMessage = {
    t: 'hello',
    v: WIRE_VERSION,
    client: {
      role: provider,
      provider,
      label: `test ${provider}`,
      capabilities,
    },
  };
  const received: ClientMessage[] = [];
  const link = createCoreClient(
    createMemoryCoreChannel({
      core,
      hello,
      connection: {
        role: provider,
        provider,
        label: `test ${provider}`,
        capabilities,
        wireVersion: WIRE_VERSION,
        coreVersion: 'test',
        coreProblem: null,
      },
    }),
    hello,
  );
  return { link, hello, received };
}

/** 本体没在跑：壳报未连接，界面必须停在未连接而不是自己造一份状态。 */
function offlineClient(): { link: CoreClient; hello: ClientMessage } {
  const hello: ClientMessage = {
    t: 'hello',
    v: WIRE_VERSION,
    client: {
      role: 'pet',
      provider: 'pet',
      label: 'test pet',
      capabilities: [],
    },
  };
  const offline: CoreChannel = {
    connection: async () => ({
      connected: false,
      role: 'pet',
      provider: 'pet',
      label: 'test pet',
      capabilities: [],
      wireVersion: WIRE_VERSION,
      coreVersion: null,
      coreProblem: null,
    }),
    send: async () => {
      throw new Error('ONE 本体没有连接');
    },
    onFrame: () => () => undefined,
    onStatus: (handler) => {
      handler({
        connected: false,
        role: 'pet',
        provider: 'pet',
        label: 'test pet',
        capabilities: [],
        wireVersion: WIRE_VERSION,
        coreVersion: null,
        coreProblem: null,
      });
      return () => undefined;
    },
  };
  return { link: createCoreClient(offline, hello), hello };
}

describe('core 客户端', () => {
  it('接上本体之后拿到的状态来自本体，而不是自己造的一份', async () => {
    const core = createCore(createMockClient(), { version: 'test' });
    const { link } = peer('pet', [], core);
    await vi.waitFor(() => expect(link.state()).toBe('ready'));
    expect(link.snapshot()).not.toBe(EMPTY_SNAPSHOT);
    expect(link.snapshot().conversations.map((item) => item.id)).toContain(
      'welcome',
    );
  });

  it('本体没在运行时不给假快照，命令也必须失败', async () => {
    const { link } = offlineClient();
    expect(link.state()).toBe('unavailable');
    expect(link.snapshot()).toBe(EMPTY_SNAPSHOT);
    await expect(link.client.sendMessage('welcome', 'hi')).rejects.toThrow(
      /本体/,
    );
  });

  it('只把状态和回执当状态，不把旧的一帧当成新的', async () => {
    const core = createCore(createMockClient(), { version: 'test' });
    const { link } = peer('pet', [], core);
    await vi.waitFor(() => expect(link.state()).toBe('ready'));
    const first = link.snapshot();
    const run = await link.client.sendMessage('welcome', '你好');
    await vi.waitFor(() =>
      expect(link.snapshot().runs.map((item) => item.id)).toContain(run.id),
    );
    // 同一个 revision 重复到达时不该再次触发订阅者。
    let notified = 0;
    link.subscribe(() => (notified += 1));
    expect(link.snapshot()).not.toBe(first);
    expect(notified).toBe(0);
  });

  it('本体拒绝握手时把原因留着，不假装连上了', async () => {
    const core = createCore(createMockClient(), { version: 'test' });
    const hello: ClientMessage = {
      t: 'hello',
      v: WIRE_VERSION + 99,
      client: {
        role: 'pet',
        provider: 'pet',
        label: '旧客户端',
        capabilities: [],
      },
    };
    const link = createCoreClient(
      createMemoryCoreChannel({
        core,
        hello,
        connection: {
          role: 'pet',
          provider: 'pet',
          label: '旧客户端',
          capabilities: [],
          wireVersion: WIRE_VERSION + 99,
          coreVersion: 'test',
          coreProblem: null,
        },
      }),
      hello,
    );
    await vi.waitFor(() => expect(link.state()).toBe('rejected'));
    expect(link.refusal()).toContain('协议版本不兼容');
    await expect(link.client.sendMessage('welcome', 'hi')).rejects.toThrow(
      /协议版本不兼容/,
    );
  });

  /**
   * 本体起不来的原因必须**盖过**「本体没有连接」（ADR-021）。
   *
   * 这不是偏好问题而是结构问题：壳报 `connected: false` 时 `markUnavailable`
   * 一定会把 `failure` 设成那句笼统的话，所以只要 coreProblem 不排在前面，
   * 壳费劲查出来的原因（漏打包 / node 没装 / 清单坏了）每次都会被吃掉，
   * 用户永远只看到「没接上」。
   */
  it('本体起不来的原因盖过笼统的「本体没有连接」', () => {
    const reason =
      '找不到 ONE 本体可执行运行时。找过：D:\\one\\dist-runtime（pnpm core:package）';
    const hello: ClientMessage = {
      t: 'hello',
      v: WIRE_VERSION,
      client: {
        role: 'pet',
        provider: 'pet',
        label: 'test pet',
        capabilities: [],
      },
    };
    const status = {
      connected: false,
      role: 'pet',
      provider: 'pet',
      label: 'test pet',
      capabilities: [],
      wireVersion: WIRE_VERSION,
      coreVersion: null,
      coreProblem: reason,
    };
    const channel: CoreChannel = {
      connection: async () => status,
      send: async () => {
        throw new Error('ONE 本体没有连接');
      },
      onFrame: () => () => undefined,
      onStatus: (handler) => {
        handler(status);
        return () => undefined;
      },
    };
    const link = createCoreClient(channel, hello);
    expect(link.state()).toBe('unavailable');
    expect(link.problem()).toBe(reason);
    expect(link.problem()).not.toContain('没有连接');
  });

  it('本体起不来盖过协议不兼容：起不来才是更根本的那条', async () => {
    const core = createCore(createMockClient(), { version: 'test' });
    const hello: ClientMessage = {
      t: 'hello',
      v: WIRE_VERSION + 99,
      client: {
        role: 'pet',
        provider: 'pet',
        label: 'test pet',
        capabilities: [],
      },
    };
    const status = {
      connected: true,
      role: 'pet',
      provider: 'pet',
      label: 'test pet',
      capabilities: [],
      wireVersion: WIRE_VERSION,
      coreVersion: 'test',
      coreProblem: '壳自己那份本体没起来，可能是 dist-runtime 漏打包',
    };
    const lines: string[] = [];
    const link = createCoreClient(
      {
        connection: async () => status,
        send: async (frame: ClientMessage) => {
          lines.push(JSON.stringify(frame));
        },
        onFrame: (handler) => {
          // 壳那边的管道上挂着另一个本体，它按自己的版本表拒绝了我们。
          handler(
            JSON.stringify({
              t: 'rejected',
              message: '协议版本不兼容：壳报 3，本体要 102',
            }),
          );
          return () => undefined;
        },
        onStatus: () => () => undefined,
      },
      hello,
    );
    await vi.waitFor(() => expect(link.state()).toBe('rejected'));
    expect(link.refusal()).toContain('协议版本不兼容');
    expect(link.problem()).toContain('漏打包');
  });

  it('本体接上之后就不再拿「起不来」说事', async () => {
    const core = createCore(createMockClient(), { version: 'test' });
    const { link } = peer('pet', [], core);
    await vi.waitFor(() => expect(link.state()).toBe('ready'));
    expect(link.problem()).toBe('');
    expect(link.connection()?.coreProblem).toBeNull();
  });

  it('同一个对话同时只允许一个写入 Run，第二个必须被本体拒绝', async () => {
    const core = createCore(createMockClient(), { version: 'test' });
    const pet = peer('pet', [], core);
    await vi.waitFor(() => expect(pet.link.state()).toBe('ready'));
    const desktop = peer('desktop', [], core);
    await vi.waitFor(() => expect(desktop.link.state()).toBe('ready'));
    await pet.link.client.sendMessage('welcome', '先开始');
    await expect(
      desktop.link.client.sendMessage('welcome', '我也想插一句'),
    ).rejects.toThrow();
  });

  it('客户端只回答自己声明过的能力', async () => {
    const core = createCore(createMockClient(), { version: 'test' });
    const pet = peer('pet', [CAPABILITY.bubbleOpen], core);
    pet.link.expose(CAPABILITY.bubbleOpen, () => '打开了');
    const desktop = peer('desktop', [], core);
    await vi.waitFor(() => expect(desktop.link.state()).toBe('ready'));
    await expect(
      desktop.link.callCapability('pet', CAPABILITY.bubbleOpen),
    ).resolves.toBe('打开了');
    await expect(
      desktop.link.callCapability('pet', CAPABILITY.windowHide),
    ).rejects.toThrow(/没有提供/);
  });

  it('同一会话里没注册能力的窗口必须保持沉默', async () => {
    // 宠物进程有宠物窗口和对话条窗口，两者共用一根管道，因此**每个窗口都会
    // 收到 invoke**。对话条声明的能力是空的，若它抢先回一句「本客户端没有
    // 提供」，本体只认第一个回执，于是调用会被自己的另一块屏幕判死。
    const core = createCore(createMockClient(), { version: 'test' });
    const hello: ClientMessage = {
      t: 'hello',
      v: WIRE_VERSION,
      client: {
        role: 'pet',
        provider: 'pet',
        label: 'ONE 宠物',
        capabilities: [CAPABILITY.bubbleOpen],
      },
    };
    // 两个窗口共用同一个 channel —— 这正是壳里单例 CoreLink 的形状。
    const channel = createMemoryCoreChannel({
      core,
      hello,
      connection: {
        role: 'pet',
        provider: 'pet',
        label: 'ONE 宠物',
        capabilities: [CAPABILITY.bubbleOpen],
        wireVersion: WIRE_VERSION,
        coreVersion: 'test',
        coreProblem: null,
      },
    });
    // 对话条窗口**先**挂载。注册顺序写死在这里，断言的是「本体最终收到什么」，
    // 不依赖真实运行时那场竞态的先后 —— 只要对话条回了一句失败，本体就只认
    // 这一条，宠物窗口真正的应答会被丢掉。
    const bubbleWindow = createCoreClient(channel, hello);
    const petWindow = createCoreClient(channel, hello);
    petWindow.expose(CAPABILITY.bubbleOpen, () => '打开了');
    void bubbleWindow.state();
    void petWindow.state();
    await vi.waitFor(() => expect(core.roster()).toHaveLength(1));

    // 以命令行视角发一次调用，只看本体把什么回给了调用方。
    const answers: CoreMessage[] = [];
    const cli = core.connect(
      {
        send: (message: CoreMessage) => answers.push(message),
        close: () => undefined,
      },
      {
        t: 'hello',
        v: WIRE_VERSION,
        client: {
          role: 'cli',
          provider: 'cli',
          label: '命令行',
          capabilities: [],
        },
      },
    );
    if (!cli) throw new Error('cli 握手被拒');
    core.handleMessage(cli, {
      t: 'capability.call',
      id: 'x',
      target: 'pet',
      capability: CAPABILITY.bubbleOpen,
    });

    await vi.waitFor(() =>
      expect(answers.filter((message) => message.t === 'result')).toHaveLength(
        1,
      ),
    );
    expect(
      answers.filter((message) => message.t === 'result')[0],
    ).toMatchObject({ id: 'x', ok: true, value: '打开了' });
  });

  it('异步能力要等它落地再回，不能把 Promise 当结果发出去', async () => {
    // 实机验收抓到的：多数能力要过壳，都是 async。直接发 Promise 会被
    // JSON.stringify 变成 `{}`，调用方拿到「成功 + 空对象」——比失败更难查。
    const core = createCore(createMockClient(), { version: 'test' });
    const pet = peer('pet', [CAPABILITY.bubbleOpen], core);
    pet.link.expose(
      CAPABILITY.bubbleOpen,
      () =>
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('打开了'), 5),
        ),
    );
    const cli = peer('cli', [], core);
    await vi.waitFor(() => expect(cli.link.state()).toBe('ready'));
    await expect(
      cli.link.callCapability('pet', CAPABILITY.bubbleOpen),
    ).resolves.toBe('打开了');
  });

  it('能力失败要回失败，不能当成成功', async () => {
    const core = createCore(createMockClient(), { version: 'test' });
    const pet = peer('pet', [CAPABILITY.windowShow], core);
    pet.link.expose(CAPABILITY.windowShow, () =>
      Promise.reject(new Error('窗口打不开')),
    );
    const cli = peer('cli', [], core);
    await vi.waitFor(() => expect(cli.link.state()).toBe('ready'));
    await expect(
      cli.link.callCapability('pet', CAPABILITY.windowShow),
    ).rejects.toThrow(/窗口打不开/);
  });

  it('目标没有声明这个能力时，由本体给出 NOT_FOUND 而不是窗口', async () => {
    // 能力存不存在是本体该回答的问题：它在转发前就校验过目标的声明。
    const core = createCore(createMockClient(), { version: 'test' });
    const pet = peer('pet', [CAPABILITY.bubbleOpen], core);
    pet.link.expose(CAPABILITY.bubbleOpen, () => '打开了');
    const cli = peer('cli', [], core);
    await vi.waitFor(() => expect(cli.link.state()).toBe('ready'));
    await expect(
      cli.link.callCapability('pet', CAPABILITY.windowHide),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('本体告诉每个客户端谁在线、谁装了', async () => {
    const core = createCore(createMockClient(), {
      version: 'test',
      installed: ['pet'],
    });
    const pet = peer('pet', [], core);
    await vi.waitFor(() => expect(pet.link.state()).toBe('ready'));
    await expect(pet.link.listClients()).resolves.toMatchObject({
      installed: ['pet'],
    });
    // 连上不等于装了：命令行能连上，但默认不在安装清单里。
    await expect(pet.link.launch('desktop')).rejects.toThrow(/还没有安装/);
  });

  it('客户端断开后，本体不再把它算作在线', async () => {
    const core = createCore(createMockClient(), { version: 'test' });
    const pet = peer('pet', [], core);
    await vi.waitFor(() => expect(pet.link.state()).toBe('ready'));
    expect(core.roster()).toHaveLength(1);
    pet.link.dispose();
    // 通道随界面一起消失，本体那边要收到 close 才会清理。
    expect(core.roster()).toHaveLength(1);
  });
});
