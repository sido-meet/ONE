import { describe, expect, it } from 'vitest';
import { createAnthropicAgent } from './anthropic.ts';
import type { AnthropicConfig } from './anthropic.ts';
import type { HttpsRequestSpec, HttpsResponse } from '../net/https.ts';

/**
 * 适配器的测试**不联网**。
 *
 * 做法是把 `transport` 换成假的，让它吐出**真的 SSE 字节流**（走真的分帧器、真的
 * 分块解码）。这样验的是「对面按官方协议发过来，我们能不能正确读出来」，而这件事在
 * 真连外网时既慢又不稳定 —— 而且一旦字段名记错了，联网测出来的只是一个看不懂的 4xx。
 *
 * 联不联网能不能通，是实机验收那一步的事（3f），不是这里的判据。
 */

/** 把若干段文本拼成一段分块传输的响应体 —— 真的走 `decodeChunked`。 */
function chunkedBody(pieces: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  async function* raw() {
    let wire = '';
    for (const piece of pieces) {
      const size = Buffer.byteLength(piece);
      wire += `${size.toString(16)}\r\n${piece}\r\n`;
    }
    wire += '0\r\n\r\n';
    // 一段一段吐，模拟真实网络。
    const bytes = encoder.encode(wire);
    for (let at = 0; at < bytes.length; at += 11) {
      yield bytes.slice(at, at + 11);
    }
  }
  return raw();
}

function respond(
  status: number,
  body: AsyncIterable<Uint8Array>,
  headers: Record<string, string> = {},
): HttpsResponse {
  return { status, headers, body };
}

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** 一条正常的完整回答。 */
function* happyStream() {
  yield frame('message_start', {
    type: 'message_start',
    message: { usage: { input_tokens: 42 } },
  });
  yield frame('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  for (const piece of ['明天下午', '三点面试']) {
    yield frame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: piece },
    });
  }
  yield frame('content_block_stop', {
    type: 'content_block_stop',
    index: 0,
  });
  yield frame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 17 },
  });
  yield frame('message_stop', { type: 'message_stop' });
}

async function run(
  config: Partial<AnthropicConfig>,
  input: {
    text: string;
    history?: { role: 'user' | 'assistant'; content: string }[];
  },
  response: HttpsResponse,
) {
  const seen: HttpsRequestSpec[] = [];
  const agent = createAnthropicAgent({
    apiKey: 'sk-test',
    model: 'claude-test',
    transport: async (spec) => {
      seen.push(spec);
      return response;
    },
    ...config,
  });
  const answer = await agent.reply({
    text: input.text,
    lastReply: undefined,
    ...(input.history ? { history: input.history } : {}),
  });
  const chunks: string[] = [];
  for await (const piece of answer.content) chunks.push(piece);
  return { text: chunks.join(''), seen, agent };
}

const okResponse = () => respond(200, chunkedBody([...happyStream()]));

describe('Anthropic 适配器', () => {
  it('把文本增量原样交出来', async () => {
    const { text } = await run({}, { text: '明天下午三点面试' }, okResponse());
    expect(text).toBe('明天下午三点面试');
  });

  it('用量照抄对面给的，不自己估', async () => {
    const { agent } = await run({}, { text: '你好' }, okResponse());
    expect(agent.lastUsage()).toEqual({
      inputTokens: 42,
      outputTokens: 17,
      stopReason: 'end_turn',
    });
  });

  /**
   * **`output_tokens` 是累计值。**
   *
   * 来两个 `message_delta`（11 然后 17）的话，相加会报成 28 —— 用户按那个数估的钱会比
   * 实际多快一倍，而界面上看不出任何异常。官方 SDK 在同一处明写「overwrite when present
   * and never add」。
   */
  it('多个 message_delta 不把用量加起来', async () => {
    const response = respond(
      200,
      chunkedBody([
        frame('message_start', {
          type: 'message_start',
          message: { usage: { input_tokens: 5 } },
        }),
        frame('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text' },
        }),
        frame('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '好' },
        }),
        frame('message_delta', {
          type: 'message_delta',
          delta: {},
          usage: { output_tokens: 11 },
        }),
        frame('message_delta', {
          type: 'message_delta',
          delta: {},
          usage: { output_tokens: 17 },
        }),
        frame('message_stop', { type: 'message_stop' }),
      ]),
    );
    const { agent } = await run({}, { text: '你好' }, response);
    expect(agent.lastUsage().outputTokens).toBe(17);
  });

  /**
   * **只收 `text_delta` 的 `text` 字段，其余一律不进正文。**
   *
   * 思考块的推理过程与工具块的参数 json 都不该进对话 —— 后者尤其不能忍：模型的中间
   * 产物一旦落进历史就成了「模型说过的话」，而它本来不打算给人看。
   *
   * 这条守的是**字段名**：三种 delta 各带各的字段（`text` / `thinking` /
   * `partial_json`），认错一个就把它们当正文交出来了。验过红：把 `text_delta` 那道
   * 类型检查摘掉，这一条仍然是绿的 —— 所以真正兜住的是下面那句只取 `delta.text`。
   * 两条都留着是故意的：类型那道防的是**将来**新增一种带 text 的 delta。
   */
  it('非文本块的内容不进正文', async () => {
    const response = respond(
      200,
      chunkedBody([
        frame('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking' },
        }),
        frame('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: '先想一下…' },
        }),
        frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
        frame('content_block_start', {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use' },
        }),
        frame('content_block_delta', {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"title":' },
        }),
        frame('content_block_stop', { type: 'content_block_stop', index: 1 }),
        frame('content_block_start', {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'text' },
        }),
        frame('content_block_delta', {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'text_delta', text: '正式答复' },
        }),
        frame('message_stop', { type: 'message_stop' }),
      ]),
    );
    const { text } = await run({}, { text: '你好' }, response);
    expect(text).toBe('正式答复');
    expect(text).not.toContain('先想一下');
  });

  it('ping 与不认识的事件类型都跳过，不当成致命错误', async () => {
    // 官方明写「应当能妥善处理未知的事件类型」。当成致命错误的话，对面加一个事件
    // 就能让 ONE 的聊天整体不可用。
    const response = respond(
      200,
      chunkedBody([
        frame('ping', { type: 'ping' }),
        frame('citation', { type: 'citation', delta: { cited_text: '某处' } }),
        frame('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text' },
        }),
        frame('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '还在' },
        }),
        frame('message_stop', { type: 'message_stop' }),
      ]),
    );
    const { text } = await run({}, { text: '你好' }, response);
    expect(text).toBe('还在');
  });

  it('流中间来的 error 事件要报成错误，不能安静收尾', async () => {
    const response = respond(
      200,
      chunkedBody([
        frame('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text' },
        }),
        frame('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '说了半句' },
        }),
        frame('error', {
          type: 'error',
          error: { type: 'overloaded_error', message: '服务过载' },
        }),
      ]),
    );
    // 状态码是 200 —— 只看状态码的话这次回答会「成功」结束，界面上是半句话加一个
    // completed，用户以为模型就这么答的。
    await expect(run({}, { text: '你好' }, response)).rejects.toMatchObject({
      code: 'BUSY',
    });
  });

  /**
   * **401 与 403 不是同一件事。**
   *
   * 401 是 key 不对（重发一万次也一样）；403 在这台机器上通常是**直连撞上地区限制**
   * —— 它发生在认证之前，把 key 换一百遍也没用。合成一句话的话，用户会去反复检查
   * 自己的密钥，而真正该做的是把代理打开。
   */
  it('401 说密钥，403 说请求不被允许', async () => {
    const unauthorized = respond(
      401,
      chunkedBody([
        JSON.stringify({ error: { message: 'invalid x-api-key' } }),
      ]),
    );
    await expect(run({}, { text: '你好' }, unauthorized)).rejects.toMatchObject(
      {
        code: 'PERMISSION_DENIED',
        message: expect.stringContaining('401'),
      },
    );

    const forbidden = respond(
      403,
      chunkedBody([JSON.stringify({ error: { message: 'forbidden' } })]),
    );
    await expect(run({}, { text: '你好' }, forbidden)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: expect.stringContaining('403'),
    });
  });

  it('429 与 529 归成「再来一次可能就成了」', async () => {
    for (const status of [429, 529]) {
      const response = respond(
        status,
        chunkedBody([JSON.stringify({ error: { message: 'busy' } })]),
      );
      await expect(run({}, { text: '你好' }, response)).rejects.toMatchObject({
        code: 'BUSY',
      });
    }
  });

  it('400 归校验错 —— 重发一次结果一模一样', async () => {
    const response = respond(
      400,
      chunkedBody([JSON.stringify({ error: { message: 'max_tokens 太大' } })]),
    );
    await expect(run({}, { text: '你好' }, response)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('请求体带上了这段对话之前说过的话', async () => {
    const { seen } = await run(
      {},
      {
        text: '那明天呢',
        history: [
          { role: 'user', content: '明天下午三点面试' },
          { role: 'assistant', content: '记下了' },
        ],
      },
      okResponse(),
    );
    const body = JSON.parse(seen[0]!.body) as { messages: unknown[] };
    // 少了 history 的话模型只看得见「那明天呢」四个字 —— 用户问的「那个」不存在。
    expect(body.messages).toEqual([
      { role: 'user', content: '明天下午三点面试' },
      { role: 'assistant', content: '记下了' },
      { role: 'user', content: '那明天呢' },
    ]);
    expect(seen[0]!.body).not.toContain('sk-test');
    expect(seen[0]!.headers['x-api-key']).toBe('sk-test');
    expect(seen[0]!.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('没有历史时只发这一句，不发空数组', async () => {
    const { seen } = await run({}, { text: '你好' }, okResponse());
    const body = JSON.parse(seen[0]!.body) as { messages: unknown[] };
    expect(body.messages).toEqual([{ role: 'user', content: '你好' }]);
  });
});
