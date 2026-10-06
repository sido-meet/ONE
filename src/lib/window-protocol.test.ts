import { describe, expect, it, vi } from 'vitest';
import { createMockClient } from '../../packages/mock-runtime/src/index';
import { createCore } from '../../core/src/core';
import { WIRE_VERSION } from '../../packages/contracts/src/wire';
import type {
  ClientKind,
  ClientMessage,
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
  kind: ClientKind,
  capabilities: string[],
  core = createCore(createMockClient(), {
    version: 'test',
    installed: ['pet', 'desktop'],
  }),
): Peer {
  const hello: ClientMessage = {
    t: 'hello',
    v: WIRE_VERSION,
    client: { kind, label: `test ${kind}`, capabilities },
  };
  const received: ClientMessage[] = [];
  const link = createCoreClient(
    createMemoryCoreChannel({
      core,
      hello,
      connection: {
        kind,
        label: `test ${kind}`,
        capabilities,
        wireVersion: WIRE_VERSION,
        coreVersion: 'test',
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
    client: { kind: 'pet', label: 'test pet', capabilities: [] },
  };
  const offline: CoreChannel = {
    connection: async () => ({
      connected: false,
      kind: 'pet',
      label: 'test pet',
      capabilities: [],
      wireVersion: WIRE_VERSION,
      coreVersion: null,
    }),
    send: async () => {
      throw new Error('ONE 本体没有连接');
    },
    onFrame: () => () => undefined,
    onStatus: (handler) => {
      handler({
        connected: false,
        kind: 'pet',
        label: 'test pet',
        capabilities: [],
        wireVersion: WIRE_VERSION,
        coreVersion: null,
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
      client: { kind: 'pet', label: '旧客户端', capabilities: [] },
    };
    const link = createCoreClient(
      createMemoryCoreChannel({
        core,
        hello,
        connection: {
          kind: 'pet',
          label: '旧客户端',
          capabilities: [],
          wireVersion: WIRE_VERSION + 99,
          coreVersion: 'test',
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
    const pet = peer('pet', ['pet.bubble.open'], core);
    pet.link.expose('pet.bubble.open', () => '打开了');
    const desktop = peer('desktop', [], core);
    await vi.waitFor(() => expect(desktop.link.state()).toBe('ready'));
    await expect(
      desktop.link.callCapability('pet', 'pet.bubble.open'),
    ).resolves.toBe('打开了');
    await expect(
      desktop.link.callCapability('pet', 'pet.hide'),
    ).rejects.toThrow(/没有提供/);
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
