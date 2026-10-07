import http from 'node:http';
import type net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeChunked, openHttpsStream } from './https.ts';

/** 把字符串变成「按给定长度切开的字节段」，模拟 TCP 分段。 */
async function* segmented(text: string, size: number) {
  const bytes = new TextEncoder().encode(text);
  for (let at = 0; at < bytes.length; at += size) {
    yield bytes.slice(at, at + size);
  }
}

async function collect(chunks: AsyncIterable<Uint8Array>) {
  const out: Buffer[] = [];
  for await (const chunk of chunks) out.push(Buffer.from(chunk));
  return Buffer.concat(out).toString('utf8');
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

/** 起一个只会拒绝 CONNECT 的假代理，返回它的端口。 */
async function refusingProxy(status: string): Promise<number> {
  const server = http.createServer();
  server.on('connect', (_req, socket) => {
    socket.end(`HTTP/1.1 ${status}\r\n\r\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  cleanup.push(() => server.close());
  return port;
}

describe('分块传输解码', () => {
  it('按长度把块拼回去', async () => {
    const raw = '5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n';
    expect(await collect(decodeChunked(segmented(raw, 4)))).toBe('hello world');
  });

  /**
   * **长度行和块体被劈到两段。**
   *
   * 十六进制长度在流的开头，解析器必须等到「长度行完整 + 块体够长」才肯出这一块。
   * 少等一个字节，回复开头就会多出一个数字；多等，则整条流卡死不回话 —— 两者都不会
   * 报错，界面上分别是「凭空多了个字」和「一直转圈」。
   */
  it('块被切成碎片也能拼对', async () => {
    const tail = 'abcdefghijklmnopqrstuvwxyz';
    // 长度必须按**字节**写：26 = 0x1a。写成 0x1f 的话解析器会理直气壮地多等 5 个字节，
    // 把结尾的 `0\r\n` 当成正文吃进去 —— 那正是「长度算错就静默多出几个字」的形态。
    const raw = `5\r\nhello\r\n${tail.length.toString(16)}\r\n${tail}\r\n0\r\n\r\n`;
    for (const size of [1, 2, 3, 7, 13, 64]) {
      expect(await collect(decodeChunked(segmented(raw, size)))).toBe(
        `hello${tail}`,
      );
    }
  });

  it('块扩展与 trailer 不进正文', async () => {
    // `;name=value` 是块扩展，`0` 之后是 trailer —— 两者都不是内容。
    const raw = '3;foo=bar\r\nabc\r\n0\r\nx-trailer: 1\r\n\r\n';
    expect(await collect(decodeChunked(segmented(raw, 3)))).toBe('abc');
  });

  it('中文按字节算长度也不会被截坏', async () => {
    // 「明」是 3 个字节：块长写 3 而不是 1，少一个字节就是半个汉字。
    const body = '明天下午';
    const size = Buffer.byteLength(body);
    const raw = `${size.toString(16)}\r\n${body}\r\n0\r\n\r\n`;
    expect(await collect(decodeChunked(segmented(raw, 2)))).toBe(body);
  });
});

describe('走代理的连接', () => {
  it('代理拒绝转发要说清是代理挡的', async () => {
    const port = await refusingProxy('403 Forbidden');
    // 关键不是「报错了」，而是**别把这句说成 Anthropic 的问题** —— 用户会去查 key，
    // 而 key 根本还没被送到。
    await expect(
      openHttpsStream({
        host: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {},
        body: '{}',
        proxy: { host: '127.0.0.1', port },
        connectTimeoutMs: 3000,
      }),
    ).rejects.toThrow(/本机代理拒绝转发/);
  });

  it('代理没开也归「不可用」而不是「输入有问题」', async () => {
    // 这个码决定界面上给不给「重试」按钮。归成 VALIDATION 的话，代理开着就能成的事
    // 会被说成「重发一次也没用」。
    await expect(
      openHttpsStream({
        host: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {},
        body: '{}',
        // 1 端口上不会有代理在听。
        proxy: { host: '127.0.0.1', port: 1 },
        connectTimeoutMs: 3000,
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('取消要真的掐断，不留一条挂着的连接', async () => {
    // 假代理**不回** CONNECT 响应：这条连接会一直挂着，正是「用户已经走了、连接还在」
    // 那种漏钱的形态。
    const server = http.createServer();
    server.on('connect', () => {
      /* 故意什么都不做 */
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as net.AddressInfo).port;
    cleanup.push(() => server.close());

    const controller = new AbortController();
    const pending = openHttpsStream({
      host: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {},
      body: '{}',
      proxy: { host: '127.0.0.1', port },
      connectTimeoutMs: 30_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
