/**
 * SSE 分帧（Server-Sent Events）。
 *
 * 自己写而不是用 `fetch` + `eventsource-parser`，有两个具体理由：
 *
 * 1. **Node 22 的 `fetch` 不走系统代理**（ADR-031 实测：直连 Anthropic 得 403，
 *    经本机代理得 401 —— 前者发生在认证之前，含义完全相反）。而代理只能自己用
 *    `node:http` 的 CONNECT 隧道搭，搭出来的是一个**裸 socket**，没有 `Response`
 *    对象可读。分帧于是只能自己从字节流里切出来。
 * 2. 分帧是**唯一一处**「一个协议事件跨好几个 TCP 段」的地方。切错了不会报错，只会
 *    安静地少几个字或者多几个字 —— 那种错在界面上长得和模型自己写错了一模一样。
 *    所以它单独成文件、单独有测试。
 *
 * 规范事实（MDN 与官方 SDK `src/core/streaming.ts` 一致）：
 * - 事件之间用**空行**分隔；行尾是 `\n`、`\r\n` 或 `\r` 都算；
 * - `data` 可以有多行，**用换行拼起来**；只有一个 `data` 行时**不加**尾部换行；
 * - 冒号后**只**去掉一个前导空格（JSON 开头正好是 `{` 时没有空格，不能顺手 trim）；
 * - 以 `:` 开头的是注释，忽略；
 * - `data` 为空的事件**不派发**（心跳就靠这条被吃掉）。
 */

/** 一个已经分好帧的事件。`event` 为空串表示对面没给 `event:` 字段。 */
export interface SseEvent {
  event: string;
  data: string;
}

/**
 * 切成行的解码器。**单独抽出来是因为它有自己的状态机**：一个 UTF-8 字符可能横跨两个
 * TCP 段（中文尤其如此），用 `chunk.toString()` 逐段转的话，边界上那个字会变成
 * `�`。`TextDecoder` 的 `stream` 模式就是为这件事存在的。
 */
export class SseLineDecoder {
  /** 未启用 stream 模式时为 undefined；此时调用方收尾要把剩下的半截也吐出来。 */
  private readonly decoder = new TextDecoder('utf-8');
  private buffer = '';

  /** 喂进一段字节，吐出**若干完整行**（不带行尾）。半截留在缓冲里等下一段。 */
  decode(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  /**
   * 流结束了，吐出缓冲里剩下的东西。
   *
   * 对面没以换行收尾是常事（连接被关掉），那最后一段仍然是有效内容 —— 把它丢掉等于
   * 少一句话。
   */
  flush(): string[] {
    this.buffer += this.decoder.decode();
    const lines = this.drain(true);
    const tail = this.buffer;
    this.buffer = '';
    return tail ? [...lines, tail] : lines;
  }

  private drain(final: boolean): string[] {
    const lines: string[] = [];
    for (;;) {
      const at = this.buffer.search(/\r\n|\n|\r/);
      if (at < 0) break;
      const isCrLf = this.buffer.startsWith('\r\n', at);
      /**
       * **缓冲末尾那个孤零零的 `\r` 不能当行尾。**
       *
       * 它多半是 `\r\n` 的前半截，而 `\n` 还在下一段里。抢先切一刀的话，那个 `\n`
       * 就成了下一行的开头 —— 空行即事件边界，于是**每一个事件后面都凭空多出一个空
       * 事件**。症状是适配器收到两倍的帧，而且不报错，只是内容里混进一堆空壳。
       *
       * 这条不是假想：自己写的 SSE 一律用 `\n`，而中间那层代理（Clash 之类）经常把
       * 行尾改写成 `\r\n`，于是一个只在纯 `\n` 下测过的实现上机就散架。
       */
      if (!isCrLf && at === this.buffer.length - 1 && !final) break;
      lines.push(this.buffer.slice(0, at));
      // 一行行吃掉，不整体替换：整体替换每来一个字节都要复制一遍剩下的全部内容，
      // 长回复下那是 O(n²)。
      this.buffer = this.buffer.slice(at + (isCrLf ? 2 : 1));
    }
    return lines;
  }
}

/**
 * 一个事件攒到现在的正文。`null`（一个 data 都没有）与 `''`（只有空 data 行）在派发
 * 规则上一样，都不算一个事件。
 *
 * 写成独立函数而不是就地判空，是因为就地写的话 TypeScript 的控制流分析看不见
 * `take` 这个闭包改过 `data`，会把流末尾那一行推成 `data: never`。
 */
const joinedData = (value: string[] | null): string =>
  value === null ? '' : value.join('\n');

/**
 * 把字节流切成事件。
 *
 * 调用方**必须**消费到底（或调 `.return()`）：底层 socket 归这条流管，消费一半就撒手
 * 会把连接留在那儿。
 */
export async function* parseSse(
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterable<SseEvent> {
  const lines = new SseLineDecoder();
  let event = '';
  /** `null` 表示「这个事件一个 data 都没有」；`[]` 表示「有 data 行但内容是空的」。 */
  let data: string[] | null = null;

  /** 处理一行。返回要不要派发。 */
  const take = (line: string): SseEvent | undefined => {
    // 空行 = 一个事件结束。注释（以 `:` 开头）常被用来保活，忽略。
    if (line === '') {
      // **拼起来是空串就不派发**，而不是「data 行数为 0」。`data:` 单独一行产生的是
      // `['']` —— 行数是 1，内容却是空的。规范说的就是「数据缓冲是空串就不派发」，
      // 按行数判会让保活帧变成一堆空事件涌进适配器。
      const joined = joinedData(data);
      const finished = joined === '' ? undefined : { event, data: joined };
      event = '';
      data = null;
      return finished;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    // 规范只去**一个**前导空格。顺手 trim 会把 JSON 里值开头那个空格也吃掉。
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') (data ??= []).push(value);
    else if (field === 'event') event = value;
    // `id` / `retry` 用不上：Anthropic 不用断线续传，客户端也不该拿服务端的 id 当会话 id。
    return undefined;
  };

  for await (const chunk of chunks) {
    for (const line of lines.decode(chunk)) {
      const finished = take(line);
      if (finished) yield finished;
    }
  }
  for (const line of lines.flush()) {
    const finished = take(line);
    if (finished) yield finished;
  }
  /**
   * **没收尾的那一帧也要派发。**
   *
   * 服务端可能在写完最后一个事件后立刻关连接，`message_stop` 后面那个空行没来得及
   * 发出去。按「只认空行」的话，最后一个事件被安静地丢掉 —— 界面上是回复少了个句号，
   * 而 Run 照样标成 completed，没有任何地方说它不完整。
   *
   * 代价是被截断的半截 JSON 也会被递出去。那一跳交给上层的 `JSON.parse`：它会抛，
   * 上层跳过并记一行日志。宁可多记一条日志，也不能悄悄少一个事件。
   */
  // 收尾要看的是闭包改过的 `data`，交给上面那个函数读，别在这儿就地判空。
  const joined = joinedData(data);
  if (joined !== '') yield { event, data: joined };
}
