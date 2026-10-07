import { describe, expect, it } from 'vitest';
import { createMockClient } from '../../packages/mock-runtime/src/index';
import { createCore } from '../../core/src/core';
import { CAPABILITY, WIRE_VERSION } from '../../packages/contracts/src/wire';
import type { ClientMessage } from '../../packages/contracts/src/wire';
import { createMemoryCoreChannel } from './transport';
import { createCoreClient } from './core-link';

/**
 * 进程内通道的行为（ADR-013）。浏览器预览和宠物端的测试都跑在这上面，
 * 因此这里要守住"和命名管道完全一致"：第一帧握手，之后每帧都是命令，
 * 状态是本体的而不是通道自己编的。
 */

describe('一根管道只有一次握手', () => {
  it('只读窗口不握手，而是向壳要重放', async () => {
    // 实机踩到：插件页面窗口与宠物主窗口共用一根管道，两个窗口各握一次手，
    // 本体只认第一次 —— 只读窗口既拿不到回执，也等不到下一次握手，
    // 于是永远停在「ONE 本体未连接」。
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
    const sent: string[] = [];
    let replays = 0;
    const status = {
      connected: true,
      role: 'pet',
      provider: 'pet',
      label: 'ONE 宠物',
      capabilities: [CAPABILITY.bubbleOpen],
      wireVersion: WIRE_VERSION,
      coreVersion: 'test',
      coreProblem: null,
    };
    const listeners: ((line: string) => void)[] = [];
    const channel = {
      connection: async () => status,
      send: async (frame: ClientMessage) => {
        sent.push(frame.t);
      },
      onFrame: (handler: (line: string) => void) => {
        listeners.push(handler);
        return () => undefined;
      },
      onStatus: () => () => undefined,
      replay: async () => {
        replays += 1;
      },
    };
    const view = createCoreClient(channel, hello, { handshake: false });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent, '只读窗口绝不能自己握手').toEqual([]);
    expect(replays, '它要向壳要重放').toBe(1);
    // 重放回来的帧照常解释：welcome 让它从"正在连接"走到"已连接"。
    listeners[0]?.(
      JSON.stringify({
        t: 'welcome',
        v: WIRE_VERSION,
        clientId: 'x',
        coreVersion: 'test',
      }),
    );
    expect(view.state()).toBe('ready');
  });

  it('主窗口照旧握手一次', async () => {
    const core = createCore(createMockClient(), { version: 'test' });
    const hello: ClientMessage = {
      t: 'hello',
      v: WIRE_VERSION,
      client: {
        role: 'pet',
        provider: 'pet',
        label: 'ONE 宠物',
        capabilities: [],
      },
    };
    const sent: string[] = [];
    const channel = {
      connection: async () => ({
        connected: true,
        role: 'pet',
        provider: 'pet',
        label: 'ONE 宠物',
        capabilities: [],
        wireVersion: WIRE_VERSION,
        coreVersion: 'test',
        coreProblem: null,
      }),
      send: async (frame: ClientMessage) => {
        sent.push(frame.t);
      },
      onFrame: () => () => undefined,
      onStatus: () => () => undefined,
    };
    createCoreClient(channel, hello);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent).toEqual(['hello']);
    void core;
  });
});

function setup() {
  const core = createCore(createMockClient(), { version: 'test' });
  const hello: ClientMessage = {
    t: 'hello',
    v: WIRE_VERSION,
    client: {
      role: 'pet',
      provider: 'pet',
      label: 'test',
      capabilities: [CAPABILITY.bubbleOpen],
    },
  };
  const lines: string[] = [];
  const statuses: boolean[] = [];
  const channel = createMemoryCoreChannel({
    core,
    hello,
    connection: {
      role: 'pet',
      provider: 'pet',
      label: 'test',
      capabilities: [CAPABILITY.bubbleOpen],
      wireVersion: WIRE_VERSION,
      coreVersion: 'test',
      coreProblem: null,
    },
  });
  channel.onFrame((line) => lines.push(line));
  channel.onStatus((status) => statuses.push(status.connected));
  return { core, hello, channel, lines, statuses };
}

describe('进程内通道', () => {
  it('第一帧建立会话，之后的帧才当作命令', async () => {
    const { core, hello, channel, lines } = setup();
    expect(core.roster()).toHaveLength(0);
    await channel.send(hello);
    expect(core.roster()).toHaveLength(1);
    await channel.send({ t: 'ping', id: 'p1' } as ClientMessage);
    expect(lines.map((line) => JSON.parse(line).t)).toEqual([
      'welcome',
      'state',
      'roster',
      'pong',
    ]);
  });

  it('状态帧带本体自己的版本号，不是通道编的', async () => {
    const { hello, channel, lines } = setup();
    await channel.send(hello);
    const welcome = lines
      .map((line) => JSON.parse(line))
      .find((f) => f.t === 'welcome');
    expect(welcome).toMatchObject({ coreVersion: 'test', v: WIRE_VERSION });
  });

  it('命令帧的 id 原样送到本体，回执才能对得上', async () => {
    const { hello, channel, lines } = setup();
    await channel.send(hello);
    lines.length = 0;
    await channel.send({ t: 'ping', id: 'p1' } as ClientMessage);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ t: 'pong' });
  });

  it('重复的连接通知不会凭空多出会话', async () => {
    const { core, hello, channel, statuses } = setup();
    await channel.send(hello);
    expect(statuses.length).toBeGreaterThan(1);
    expect(core.roster()).toHaveLength(1);
  });
});
