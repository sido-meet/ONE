import { describe, expect, it } from 'vitest';
import { parseSse, SseLineDecoder } from './sse.ts';

/** 把字符串变成「按给定长度切开的字节段」，模拟 TCP 分段。 */
async function* segmented(text: string, size: number) {
  const bytes = new TextEncoder().encode(text);
  for (let at = 0; at < bytes.length; at += size) {
    yield bytes.slice(at, at + size);
  }
}

async function collect(chunks: AsyncIterable<Uint8Array>) {
  const out: { event: string; data: string }[] = [];
  for await (const event of parseSse(chunks)) out.push(event);
  return out;
}

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe('SSE 分帧', () => {
  it('一个事件被切成几段也能拼回来', async () => {
    const stream =
      frame('message_start', { type: 'message_start' }) +
      frame('message_stop', { type: 'message_stop' });
    // 每 7 字节一段：字段名、冒号、JSON 都会被劈开。
    expect(await collect(segmented(stream, 7))).toEqual([
      { event: 'message_start', data: '{"type":"message_start"}' },
      { event: 'message_stop', data: '{"type":"message_stop"}' },
    ]);
  });

  /**
   * **一个汉字横跨两个 TCP 段。**
   *
   * 逐段 `toString()` 的写法在这里会得到 `�` —— 而那个乱码会一路进到对话历史里，
   * 用户看到的是模型说了一句带乱码的话，**没有任何地方报错**。所以这条守的是
   * 「TextDecoder 的 stream 模式」，不是「分帧逻辑」。
   */
  it('汉字被劈到两段也不会变乱码', async () => {
    const body = 'data: {"text":"明天下午三点面试"}\n\n';
    const bytes = new TextEncoder().encode(body);
    // 找到「点」这个字的首字节，在它中间切开。
    const cut = bytes.indexOf(0xe7) + 1;
    async function* split() {
      yield bytes.slice(0, cut);
      yield bytes.slice(cut);
    }
    const events = await collect(split());
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe('{"text":"明天下午三点面试"}');
    expect(events[0]!.data).not.toContain('\uFFFD');
  });

  it('三个行尾写法都认', async () => {
    for (const eol of ['\n', '\r\n', '\r']) {
      const stream = `event: ping${eol}data: {}${eol}${eol}`;
      expect(await collect(segmented(stream, 3))).toEqual([
        { event: 'ping', data: '{}' },
      ]);
    }
  });

  it('多个 data 行用换行拼起来', async () => {
    const stream = 'event: e\ndata: 第一行\ndata: 第二行\n\n';
    expect(await collect(segmented(stream, 4))).toEqual([
      { event: 'e', data: '第一行\n第二行' },
    ]);
  });

  it('冒号后只去掉一个前导空格', async () => {
    // 规范只去一个。顺手 trim 会把值开头那个空格也吃掉，JSON 就能被改坏。
    const stream = 'event: e\ndata:  {"a":1}\n\n';
    expect((await collect(segmented(stream, 5)))[0]!.data).toBe(' {"a":1}');
  });

  it('注释被忽略，空 data 的事件不派发', async () => {
    // 心跳就是靠「只有注释、没有 data」这两条被吃掉的；派发出去等于每十几秒往
    // 适配器塞一个空事件。
    const stream =
      ': keep-alive\n\n: another\ndata:\n\nevent: real\ndata: 1\n\n';
    expect(await collect(segmented(stream, 6))).toEqual([
      { event: 'real', data: '1' },
    ]);
  });

  it('最后一段没有换行收尾也不丢', async () => {
    // 连接被对面关掉是常事。丢掉这半句等于让回复少一段尾巴，而且不报错。
    const events = await collect(segmented('event: e\ndata: 结尾', 6));
    expect(events).toEqual([{ event: 'e', data: '结尾' }]);
  });

  it('一个 data 也没有的事件不会派发空串', async () => {
    expect(await collect(segmented('event: e\n\n', 3))).toEqual([]);
  });
});

describe('SseLineDecoder', () => {
  it('缓冲跨调用保留半行', () => {
    const decoder = new SseLineDecoder();
    expect(decoder.decode(new TextEncoder().encode('ab'))).toEqual([]);
    // `ef` 没有换行收尾，所以现在还不算一行 —— 只在 flush 时才吐出来。
    expect(decoder.decode(new TextEncoder().encode('cd\nef'))).toEqual([
      'abcd',
    ]);
    expect(decoder.flush()).toEqual(['ef']);
  });

  it('flush 把没换行收尾的那半句吐出来', () => {
    const decoder = new SseLineDecoder();
    decoder.decode(new TextEncoder().encode('半句'));
    expect(decoder.flush()).toEqual(['半句']);
  });
});
