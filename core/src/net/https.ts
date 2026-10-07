import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { ClientError } from '../../../packages/contracts/src/index.ts';

/**
 * 一个够用的 HTTPS 客户端 —— **能走 HTTP 代理**（ADR-031）。
 *
 * 不用 `fetch` 的理由只有一条，但很硬：Node 22 的 `fetch` 既不读 Windows 的系统代理，
 * 也没有 `NODE_USE_ENV_PROXY`（那是 Node 24 才加的）。于是它直连，而 Anthropic 对
 * 直连按地区返回 **403** —— 那个 403 发生在认证之前，跟「key 不对」的 401 长得完全
 * 不一样，却只差一个数字。所以在这个项目里「能不能上外网」是个**代理问题**，
 * 不是「网络通不通」。
 *
 * 也不引第三方 HTTP 库：本体的形状是「零第三方依赖 + 源码随包」（ADR-021/030），
 * 塞一个 undici 进去就要连着它的传递依赖一起搬，还要给它配代理开关 —— 而我们要的
 * 能力只有两个：`CONNECT` 隧道，和把响应体按字节流交出去。
 *
 * **`openHttpsStream` 只做传输，不解释状态码。** 401 是 key 不对、429 是限流、529 是
 * 过载，这些属于「Anthropic 说了什么」，由适配器那一层分类（ADR-031 第 3 条）。
 * 这一层把「能不能连上」和「连上了说了什么」分开，前者只报网络事实。
 */

/** 代理地址。由壳读注册表拿到后经环境变量传进来（ADR-031）。 */
export interface ProxyTarget {
  host: string;
  port: number;
}

export interface HttpsRequestSpec {
  host: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  /** 有就走 CONNECT 隧道，没有就直连。 */
  proxy?: ProxyTarget | undefined;
  /** 建连 + TLS 握手 + **收到响应头**的上限。默认 20 秒。 */
  connectTimeoutMs?: number;
  signal?: AbortSignal | undefined;
}

export interface HttpsResponse {
  status: number;
  /** 头名一律小写。 */
  headers: Record<string, string>;
  /** 响应体：已按 `transfer-encoding` 拆开帧。**必须消费到底或调 `.return()`。 */
  body: AsyncIterable<Uint8Array>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 20000;

/**
 * 网络失败 → 本体错误码。
 *
 * 分类标准是「同样的话重发一次会不会有不同结果」（ADR-022 定的 `retryable` 判据）：
 * 连不上代理、域名解析不了、连接被拒、对面挂断 —— 全是「再来一次可能就好了」，
 * 归 `UNAVAILABLE`；握手迟迟不来是 `TIMEOUT`。**没有一种该归 `VALIDATION`**：
 * 那类码界面上不给重试按钮，而这里每一种都值得再试一次。
 */
function netFailure(what: string, cause: unknown): ClientError {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  const detail = code ? `${code}` : String(cause);
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT')
    return new ClientError('TIMEOUT', `${what}超时了`, { code });
  return new ClientError('UNAVAILABLE', `${what}失败：${detail}`, {
    code: detail,
  });
}

/**
 * 用 `CONNECT` 打通一条隧道，拿到**裸 socket**。
 *
 * 为什么代理这条路要自己搭：拿到 socket 之后才有 TLS，TLS 之后才能当普通 HTTPS 走 ——
 * 这正是 HTTP 代理转 HTTPS 的标准做法（RFC 9110 §9.3.6）。实测这条路能通：同一个
 * 编造的 key，直连 403、经隧道 401。
 */
function openTunnel(
  proxy: ProxyTarget,
  target: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: target,
      headers: { host: target },
    });
    // 隧道建立前出的一切错都还没到 Anthropic，所以统一说「代理」而不是「Anthropic」。
    const fail = (what: string, cause: unknown) => {
      request.destroy();
      reject(netFailure(what, cause));
    };
    request.setTimeout(timeoutMs, () =>
      fail('连本机代理超时', { code: 'ETIMEDOUT' }),
    );
    request.on('connect', (response, socket) => {
      // 非 200 意味着代理明确不放行。**必须在这里报**：接着做 TLS 只会得到一句
      // 语焉不详的握手失败，而真相是「代理拒了这个地址」。
      if (response.statusCode !== 200) {
        socket.destroy();
        fail('本机代理拒绝转发', {
          code: `HTTP_${response.statusCode ?? 0}`,
        });
        return;
      }
      request.setTimeout(0);
      resolve(socket);
    });
    request.on('error', (cause) => fail('连本机代理失败', cause));
    signal?.addEventListener(
      'abort',
      () => {
        request.destroy();
        reject(new ClientError('UNAVAILABLE', '请求已取消'));
      },
      { once: true },
    );
    request.end();
  });
}

/** 在一条已建立的流上做 TLS。 */
function secure(
  socket: net.Socket,
  host: string,
  timeoutMs: number,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({ socket, servername: host });
    const timer = setTimeout(() => {
      secured.destroy();
      reject(netFailure('TLS 握手超时', { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    timer.unref?.();
    secured.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(secured);
    });
    secured.once('error', (cause) => {
      clearTimeout(timer);
      reject(netFailure('TLS 握手失败', cause));
    });
  });
}

/**
 * 拆 `Transfer-Encoding: chunked` 的帧。
 *
 * **不做这件事就一定会出乱码。** HTTP/1.1 的流式响应默认是分块传输的，每块前面带一个
 * 十六进制长度、后面跟 CRLF。不拆的话，适配器分帧拿到的是 `1f\r\ndata: ...\r\n0\r\n\r\n`
 * 这种东西 —— 长度数字被当成了事件行，回复里凭空冒出十六进制字符，而且**不报错**。
 *
 * **逐字节状态机，而不是「攒成字符串再切」。** 曾经用 `TextDecoder('latin1')` 攒字符串
 * 切完再 `TextEncoder` 编回去：那一来一回对 ASCII 无损，对**任何 ≥0x80 的字节却是错的**
 * —— latin1 解出的是码点 128–255，`TextEncoder` 再把它们编成两字节的 UTF-8。中文块
 * 于是整片变成 `æ˜Žå¤©`。症状是回复里全是乱码、状态码 200、**一条错误日志都没有**。
 * 块体是**字节**，从头到尾都不许碰文本编解码。
 *
 * 拆成独立函数是为了能单测：这一段要对着人工构造的字节验，而真连一次外网验它既慢又
 * 不稳定。
 */
export async function* decodeChunked(
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  type State = 'size' | 'sizeEol' | 'body' | 'bodyEol';
  let state: State = 'size';
  /** 长度行是 ASCII，逐字节读成字符串没问题 —— 它不进正文。 */
  let sizeText = '';
  let remaining = 0;
  /** 块体后的 CRLF 要**两个**字节：先 `\r` 再 `\n`。分两段到也照样认。 */
  let sawCarriageReturn = false;

  for await (const chunk of chunks) {
    // `Uint8Array[]` 而不是 `Buffer[]`：进来的是任意字节块（decodeChunked 自己交出来的
    // 就是 `subarray` 的结果），强转成 Buffer 只是为了骗过类型。
    const out: Uint8Array[] = [];
    for (let i = 0; i < chunk.length; i += 1) {
      const byte = chunk[i]!;
      if (state === 'size') {
        if (byte === 0x0d) state = 'sizeEol';
        else sizeText += String.fromCharCode(byte);
        continue;
      }
      if (state === 'sizeEol') {
        if (byte !== 0x0a)
          throw new ClientError('INTERNAL', '响应分块的长度行没以 CRLF 收尾', {
            sizeText,
          });
        // 块扩展（`;name=value`）不带进尺寸里。
        const size = Number.parseInt(sizeText.split(';')[0]!.trim(), 16);
        if (Number.isNaN(size))
          throw new ClientError('INTERNAL', '响应分块长度看不懂', { sizeText });
        sizeText = '';
        // 长度 0 = 结束，后面是可选的 trailer，不进正文。
        // **先把这一段里已经攒到的正文交出去再收尾**：`0` 经常和最后一块数据落在同一个
        // TCP 段里，直接 return 就把那块丢了 —— 症状是回复结尾少一个字，不报错。
        if (size === 0) {
          if (out.length > 0) yield Buffer.concat(out);
          return;
        }
        remaining = size;
        state = 'body';
        continue;
      }
      if (state === 'body') {
        // 能拿多少拿多少，够不着就留着下一段接着拿。
        const take = Math.min(remaining, chunk.length - i);
        out.push(chunk.subarray(i, i + take));
        remaining -= take;
        i += take - 1;
        if (remaining === 0) state = 'bodyEol';
        continue;
      }
      // bodyEol：块体后面那个 CRLF。
      if (sawCarriageReturn) {
        if (byte !== 0x0a)
          throw new ClientError('INTERNAL', '响应分块体后没跟 CRLF');
        sawCarriageReturn = false;
        state = 'size';
        continue;
      }
      if (byte !== 0x0d)
        throw new ClientError('INTERNAL', '响应分块体后没跟 CRLF');
      sawCarriageReturn = true;
    }
    if (out.length > 0) yield Buffer.concat(out);
  }
}

/** 响应头：`HTTP/1.1 200 OK\r\nname: value\r\n…\r\n\r\n`。 */
function parseHead(raw: string): {
  status: number;
  headers: Record<string, string>;
} {
  const lines = raw.split('\r\n');
  const status = Number.parseInt(lines[0]?.split(' ')[1] ?? '', 10);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return { status: Number.isNaN(status) ? 0 : status, headers };
}

/**
 * 读够响应头为止，返回状态码、头，以及**头之后剩下的字节**。
 *
 * **这一步必须自己计超时。** 建隧道和 TLS 握手都有上限，但「连上了、握过手了，然后
 * 对面一句话不说」是另一回事 —— 代理挂起、节点半死、TLS 之后被中间设备丢掉，都是
 * 这个样子。没有上限的话这次 Run 会**永远转圈**：界面上光标在闪、没有错误、没有
 * 「停止」以外的出路，而背后那条连接一直占着。
 *
 * 这一条是实机逼出来的：连发四次请求，有一次整整 **60 秒**什么都没等到。
 *
 * 加上限之后它是一次普通的超时错误：界面说得出「等了多久没等到」，用户能重试。代价
 * 是极慢的首字节会被误判 —— 20 秒还拿不到响应头的请求，本来也已经不太正常。
 *
 * 抽成模块级函数而不是留在 `openHttpsStream` 里，是为了能单测：造一个「永远不说话」
 * 的字节流就行，不必真的架一个握手成功的 TLS 服务器（那需要自签证书，代价与收益
 * 不成比例）。原来那条测试用假代理测，结果触发的是**握手**超时而不是这一段 ——
 * 测试绿着，守的却不是它想守的东西。
 */
export async function readResponseHead(
  chunks: AsyncIterable<Uint8Array>,
  timeoutMs: number,
): Promise<{
  status: number;
  headers: Record<string, string>;
  /** 头之后多出来的那点字节已经属于响应体了。 */
  rest: () => AsyncIterable<Uint8Array>;
}> {
  const decoder = new TextDecoder('latin1');
  const iterator = chunks[Symbol.asyncIterator]();
  let text = '';
  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(netFailure('等响应头', { code: 'ETIMEDOUT' })),
      timeoutMs,
    );
    timer.unref?.();
  });
  for (;;) {
    const step = await Promise.race([iterator.next(), deadline]);
    const at = text.indexOf('\r\n\r\n');
    if (at >= 0) {
      const tail = Buffer.from(text.slice(at + 4), 'latin1');
      return {
        ...parseHead(text.slice(0, at)),
        rest: async function* rest() {
          if (tail.length > 0) yield tail;
          yield* chunks;
        },
      };
    }
    if (step.done) break;
    text += decoder.decode(step.value, { stream: true });
  }
  throw new ClientError('UNAVAILABLE', '响应头没等到就断了');
}

/**
 * 发一个 HTTPS 请求，拿到**流式**响应体。
 *
 * 只在**收到响应头**时 resolve。状态码多少都 resolve —— 401、429、529 全是要分类的
 * 事实，不是传输失败。传输层失败（连不上、握手失败、等不到头）才 reject。
 */
export async function openHttpsStream(
  spec: HttpsRequestSpec,
): Promise<HttpsResponse> {
  const timeoutMs = spec.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const target = `${spec.host}:443`;
  const raw = spec.proxy
    ? await openTunnel(spec.proxy, target, timeoutMs, spec.signal)
    : await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.connect({ host: spec.host, port: 443 });
        const timer = setTimeout(() => {
          socket.destroy();
          reject(netFailure('直连超时', { code: 'ETIMEDOUT' }));
        }, timeoutMs);
        timer.unref?.();
        socket.once('connect', () => {
          clearTimeout(timer);
          resolve(socket);
        });
        socket.once('error', (cause) => {
          clearTimeout(timer);
          reject(netFailure('直连失败', cause));
        });
      });

  const socket = await secure(raw, spec.host, timeoutMs);
  // **不要**把请求体之外的东西也一起管：头之后这段字节流是 SSE 的。
  const head = [
    `${spec.method} ${spec.path} HTTP/1.1`,
    `host: ${spec.host}`,
    ...Object.entries(spec.headers).map(([name, value]) => `${name}: ${value}`),
    `content-length: ${Buffer.byteLength(spec.body)}`,
    'connection: close',
    '',
    '',
  ].join('\r\n');
  socket.write(head + spec.body);

  /** 逐块交出去，直到流结束。取消时安静地结束 —— 取消不是错误（ADR-031）。 */
  async function* body(): AsyncIterable<Uint8Array> {
    const queue: Uint8Array[] = [];
    let wait: (() => void) | undefined;
    let ended = false;
    let failure: unknown;

    const wake = () => {
      wait?.();
      wait = undefined;
    };
    socket.on('data', (chunk: Buffer) => {
      queue.push(chunk);
      wake();
    });
    socket.on('end', () => {
      ended = true;
      wake();
    });
    socket.on('close', () => {
      ended = true;
      wake();
    });
    socket.on('error', (cause) => {
      failure = cause;
      ended = true;
      wake();
    });
    const abort = () => {
      ended = true;
      // **真的掐断**：socket 还在的话说明对面还在给我们推 token。
      socket.destroy();
      wake();
    };
    spec.signal?.addEventListener('abort', abort, { once: true });

    try {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (ended) break;
        await new Promise<void>((resolve) => {
          wait = resolve;
        });
      }
      while (queue.length > 0) yield queue.shift()!;
      // 取消导致的结束不是故障；真断了才报。
      if (failure && !spec.signal?.aborted) throw failure;
    } finally {
      spec.signal?.removeEventListener('abort', abort);
      socket.destroy();
    }
  }

  const { status, headers, rest } = await readResponseHead(body(), timeoutMs);
  const chunks = rest();
  const chunked = headers['transfer-encoding']
    ?.toLowerCase()
    .includes('chunked');
  return {
    status,
    headers,
    // 不分块就是原样；分块就必须拆。不拆的话 SSE 里会混进十六进制长度。
    body: chunked ? decodeChunked(chunks) : chunks,
  };
}
