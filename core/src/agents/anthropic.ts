import { ClientError } from '../../../packages/contracts/src/index.ts';
import type {
  ErrorCode,
  ReplyAgent,
} from '../../../packages/contracts/src/index.ts';
import { openHttpsStream } from '../net/https.ts';
import type {
  HttpsRequestSpec,
  HttpsResponse,
  ProxyTarget,
} from '../net/https.ts';
import { parseSse } from '../net/sse.ts';

/**
 * Anthropic 适配器 —— 阶段 3 的真模型接入（ADR-031）。
 *
 * 它实现的是**同一个** `ReplyAgent` 端口。模拟 Agent 换掉的是这一个对象，会话状态机、
 * 事件、Run、提议、界面一个字都没动 —— 这正是 ADR-028 那条边界要兑现的东西。
 *
 * **协议事实全部取自官方 SDK 源码**（`anthropic/anthropic-sdk-typescript` 的
 * `src/resources/messages/messages.ts` 与 `src/core/streaming.ts`，经本机代理取得），
 * 不是凭记忆写的。下面每处关键判断都在注释里标了它对应源码里的哪一行。
 */

const API_HOST = 'api.anthropic.com';
const API_PATH = '/v1/messages';
/** 官方 SDK `src/client.ts` 里写死的就是这个值，换了要跟着换。 */
const API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 2048;

/** 换掉真实 socket 传输。测试据此喂假字节流，于是整套事件映射不必联网就能验。 */
export type Transport = (spec: HttpsRequestSpec) => Promise<HttpsResponse>;

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  maxTokens?: number;
  /** 由壳读注册表后经环境变量传入；没有就直连（ADR-031）。 */
  proxy?: ProxyTarget | undefined;
  system?: string;
  connectTimeoutMs?: number;
  transport?: Transport;
}

/**
 * 用量。**照抄提供方给的，没有就留空**（ADR-031 第 5 条）。
 *
 * 按字符数估一个「大概的」是条捷径，而估出来的数字和真数字长得一模一样 —— 用户拿它
 * 做预算，做到月底才发现对不上，却没有任何地方告诉他那个数是猜的。
 */
export interface AnthropicUsage {
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
}

export interface AnthropicAgent extends ReplyAgent {
  /** 最后一次跑完的用量。流断了就还是上一次的值 —— 不拿半截数字冒充。 */
  lastUsage(): AnthropicUsage;
}

/**
 * 状态码 → 本体错误码（ADR-031 第 3 条）。
 *
 * 判据是「同样的话重发一次会不会有不同结果」，沿用 ADR-022 已有的 `retryable` 语义。
 * **401 与 403 必须分开**：401 是密钥不对（重发一万次也一样），403 是这个请求不被允许
 * —— 而在这台机器上，直连得到的 403 其实是地区限制（发生在认证之前），把两者说成同一句
 * 话，用户会去反复检查自己的 key，而 key 根本没问题。
 */
function classify(status: number, body: string): ClientError {
  const say = (code: ErrorCode) =>
    new ClientError(code, body ? body : 'Anthropic 没有说明原因', { status });
  if (status === 401)
    return new ClientError(
      'PERMISSION_DENIED',
      'API 密钥没被接受（401）。检查 ANTHROPIC_API_KEY。',
      { status },
    );
  if (status === 403)
    return new ClientError(
      'PERMISSION_DENIED',
      '这个请求不被允许（403）。若本机走代理，确认代理已开 —— 直连会按地区被挡。',
      { status },
    );
  if (status === 400) return say('VALIDATION');
  // 429 限流与 529 过载：官方文档说 529 对应 overloaded_error，非流式请求同样是它。
  if (status === 429 || status === 529) return say('BUSY');
  if (status >= 500) return say('UNAVAILABLE');
  return say('INTERNAL');
}

/** 流中间来的 `error` 事件。分帧还在，连接也没断，但这次回答已经废了。 */
function classifyStreamError(type: string, message: string): ClientError {
  if (type === 'overloaded_error' || type === 'rate_limit_error')
    return new ClientError('BUSY', message || 'Anthropic 暂时忙不过来', {
      type,
    });
  return new ClientError('UNAVAILABLE', message || 'Anthropic 中断了这次回答', {
    type,
  });
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

export function createAnthropicAgent(config: AnthropicConfig): AnthropicAgent {
  const transport = config.transport ?? openHttpsStream;
  let usage: AnthropicUsage = {};
  return {
    // 复用 `chat` 这个寻址键：对话里「谁在说话」是 ONE 的事，不因为换了实现就换名字。
    id: 'chat',
    name: `Claude（${config.model}）`,
    // 界面上那个「模拟」标签会因此消失 —— 它读的是这一行，不是前端常量（ADR-031）。
    kind: 'real' as const,
    lastUsage: () => ({ ...usage }),
    async reply({ text: prompt, history, signal }) {
      usage = {};
      /**
       * **这次提问之前**说过的话，加上这一句。
       *
       * ONE 的历史第一条永远是用户消息（回复只能由用户消息触发），所以不会出现
       * 「以助手消息开头」这种对面不收的形状。同角色连续出现是对面明确支持的 ——
       * 官方 SDK 类型里原话是「Consecutive user or assistant turns in your request
       * will be combined into a single turn」，所以这里**不合并**：合并了就得猜哪句该
       * 归哪边，猜错就是改写用户说过的话。
       */
      const messages = [
        ...(history ?? []).map((item) => ({
          role: item.role,
          content: item.content,
        })),
        { role: 'user' as const, content: prompt },
      ];
      const spec: HttpsRequestSpec = {
        host: API_HOST,
        path: API_PATH,
        method: 'POST',
        // 密钥只在这一层出现：不写进快照、不下发客户端、不进 core.db（ADR-031 第 6 条）。
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
          messages,
          stream: true,
          ...(config.system ? { system: config.system } : {}),
        }),
        ...(config.proxy ? { proxy: config.proxy } : {}),
        ...(config.connectTimeoutMs
          ? { connectTimeoutMs: config.connectTimeoutMs }
          : {}),
        ...(signal ? { signal } : {}),
      };
      const response = await transport(spec);
      // 非 2xx 的响应体不是 SSE，是一段 JSON 错误说明。读完它才能说清为什么。
      if (response.status < 200 || response.status >= 300) {
        const text = await readAll(response.body);
        throw classify(response.status, text);
      }

      /**
       * **流里的内容块要按序号记住类型。**
       *
       * 官方 SDK 的 `accumulateEvent` 里每一处 text_delta 都先判
       * `content[index].type === 'text'` 才收。不判的话，一旦模型开了工具块
       * （`input_json_delta`）或者思考块，同一个数组里混着两种内容，回复里就会冒出
       * 工具参数或者思考过程 —— 后者更糟：那是模型不打算给人看的中间产物。
       */
      async function* content(): AsyncIterable<string> {
        for await (const event of parseSse(response.body)) {
          if (event.event === 'ping') continue;
          const payload = parseData(event.data);
          if (!payload) continue;
          const type = text(payload['type']);
          if (type === 'error') {
            const error = record(payload['error']);
            throw classifyStreamError(
              text(error?.['type']) ?? 'unknown',
              text(error?.['message']) ?? '',
            );
          }
          if (type === 'message_start') {
            const message = record(payload['message']);
            const incoming = record(message?.['usage']);
            const input = incoming?.['input_tokens'];
            if (typeof input === 'number')
              usage = { ...usage, inputTokens: input };
            continue;
          }
          if (type === 'content_block_delta') {
            const delta = record(payload['delta']);
            /**
             * **只收 `text_delta`，而且只取它那个 `text` 字段。**
             *
             * 其余几种 delta 带的是各自的东西：`thinking_delta` 带模型的中间推理、
             * `input_json_delta` 带工具参数、`citations_delta` 带引用。
             * 官方类型里它们互不重叠，所以这一道就把它们全挡住了 —— 而且只认**认识的**
             * 那种 delta 类型：将来对面加一种新的、名字里也带 text 的，落到这里仍然被
             * 丢掉，而不是把没准备过的内容直接摆到用户面前。
             *
             * 曾经这里还多写了一道「这个 index 的块是不是 text」的判断（官方 SDK 的
             * `accumulateEvent` 确实也判）。**实测摘掉它测试不会红** —— 因为对真实协议
             * 来说它和上面那道完全重复。留着一道测不到、又看不出为什么在的检查，比没有
             * 更糟：它让人以为这里有两层保护，真出事时却只有一层。
             */
            if (text(delta?.['type']) !== 'text_delta') continue;
            const piece = text(delta?.['text']);
            if (piece) yield piece;
            continue;
          }
          if (type === 'message_delta') {
            const delta = record(payload['delta']);
            const reason = text(delta?.['stop_reason']);
            if (reason) usage = { ...usage, stopReason: reason };
            /**
             * **累计值，覆盖，不相加。** 官方 SDK 在同一处的注释原话是
             * 「The remaining usage counters are cumulative whole-message totals …
             * so overwrite when present and never add.」
             * 相加的话每来一个 `message_delta` 就翻一倍 —— 那是花自己的钱。
             */
            const output = record(payload['usage'])?.['output_tokens'];
            if (typeof output === 'number')
              usage = { ...usage, outputTokens: output };
            continue;
          }
          // `content_block_stop` / `message_stop` 不用专门处理：结束靠流自己结束。
          // **没见过的类型一律跳过**（ADR-031 第 4 条）—— 官方明写应当能妥善处理未知的
          // 事件类型，把没见过的当致命错误等于让对面加个字段就能让 ONE 崩掉。
        }
      }
      return { content: content() };
    },
  };
}

/**
 * 错误响应体只读一次。**读它不是为了解析，是为了说人话**：对面给的 `error.message`
 * 是唯一知道「为什么被拒」的来源，自己编一句只会让用户猜。
 */
async function readAll(body: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    parts.push(Buffer.from(chunk));
    size += chunk.length;
    // 错误说明不会有几百 KB。截断是为了不让一个坏掉的响应用光内存。
    if (size > 64 * 1024) break;
  }
  try {
    const raw = Buffer.concat(parts).toString('utf8');
    const error = record(JSON.parse(raw)?.['error']);
    return text(error?.['message']) ?? raw;
  } catch {
    return Buffer.concat(parts).toString('utf8').slice(0, 200);
  }
}

/**
 * `data:` 是 JSON。**解析不了就跳过，不抛。**
 *
 * 连接被切断时最后一帧可能是半截 JSON。抛出去的话，一次正常回复会因为「最后半个字符」
 * 而整个失败，用户看到的是「AI 出错了」而其实内容已经完整 —— 比少一个字糟得多。
 */
function parseData(raw: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(raw));
  } catch {
    process.stderr.write(
      `ONE 模型：跳过一个读不懂的事件（${raw.length} 字节）\n`,
    );
    return undefined;
  }
}
