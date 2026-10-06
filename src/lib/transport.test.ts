import { describe, expect, it } from 'vitest';
import { createMockClient } from '../../packages/mock-runtime/src/index';
import { createCore } from '../../core/src/core';
import { WIRE_VERSION } from '../../packages/contracts/src/wire';
import type { ClientMessage } from '../../packages/contracts/src/wire';
import { createMemoryCoreChannel } from './transport';

/**
 * 进程内通道的行为（ADR-013）。浏览器预览和宠物端的测试都跑在这上面，
 * 因此这里要守住"和命名管道完全一致"：第一帧握手，之后每帧都是命令，
 * 状态是本体的而不是通道自己编的。
 */

function setup() {
  const core = createCore(createMockClient(), { version: 'test' });
  const hello: ClientMessage = {
    t: 'hello',
    v: WIRE_VERSION,
    client: { kind: 'pet', label: 'test', capabilities: ['pet.bubble.open'] },
  };
  const lines: string[] = [];
  const statuses: boolean[] = [];
  const channel = createMemoryCoreChannel({
    core,
    hello,
    connection: {
      kind: 'pet',
      label: 'test',
      capabilities: ['pet.bubble.open'],
      wireVersion: WIRE_VERSION,
      coreVersion: 'test',
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
