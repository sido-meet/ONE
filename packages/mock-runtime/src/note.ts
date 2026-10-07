import type { NoteDraft } from '../../contracts/src/proposal.ts';

/**
 * 从中文里抽出一份笔记草稿（0.1 / ADR-022）。
 *
 * 与 `schedule.ts` 同一条纪律：**只认固定句式，认不出就说认不出**。0.1 没有
 * 真模型，与其做一个半吊子的意图识别、时不时把不该记的东西记下来，不如一张
 * 看得见的句式表 —— 记错的代价看起来小（笔记可以删），但一个会乱记东西的
 * assistant 用两次就没人敢用了。
 *
 * 认得的话长这样：
 *
 * ```
 * 记一下：今天复盘的三点结论
 * 记一下 客户要求下周给报价
 * 把刚才那段记下来
 * ```
 *
 * 前两句取用户自己的话，最后一句取**上一条回复** —— 那正是 0.1 验收里
 * 「保存一段聊天结果」那一条。没有上一条回复时它不成立，也就是说：空房间里
 * 说「把刚才那段记下来」，系统必须说「刚才那段」并不存在，而不是记一条空的。
 *
 * **两条句式都整句锚定。** 锚定的理由是实机验收之前的一次批量探测：「记」是
 * 常用字，不锚定就会从句子中间开始抓 ——
 *
 * - 「你记得今天开会吗」→ 抓「记」后面的「得今天开会吗」，记成一条笔记
 * - 「这个功能还没记在文档里」→ 记成「在文档里」
 * - 「这条不用记了」→ 记成一条标题是「了」的笔记
 *
 * 三条都不是「记得记在」这几字连着念，而是「记」碰巧出现在句子里。日记里
 * 这种句子比日记本身常见得多，所以锚定不是洁癖。
 *
 * 失败的两种也要分开（`near`）：「说了记一下却没说要记什么」值得原样讲给用户
 * 听 —— 他补一句就成了；「今天天气不错」不值得回一句「没听出要记什么」，那
 * 听起来像系统在挑刺。
 */
export type NoteAttempt =
  { ok: true; draft: NoteDraft } | { ok: false; reason: string; near: boolean };

/** 标题截断长度。短到一行放得下，长到还认得出说的是哪件事。 */
export const NOTE_TITLE_LIMIT = 24;

/**
 * 客气话前缀。最多两个词，再多就该说人话了 —— 这不是「随便什么开头都行」的
 * 许可，是一个看得见的小表。
 */
const POLITE = '(?:(?:请|麻烦|帮我|替我|给我|能不能|可以)\\s*){0,2}';

/** 结尾的客套语气词与句号。「记下来吧。」也是记。 */
const TAIL = '\\s*[吧呀啊哦嗯了]?\\s*[。.!！]?';

/**
 * 明确要记的两种写法。**动词后面必须有个分隔符**（标点或空白），且必须占满整句。
 *
 * 分隔符必选是反误判的关键：「你记得今天开会吗」里「记」后面跟的是「得」，
 * 「这个功能还没记在文档里」后面跟的是「在」——都不是分隔符，所以都不成立。
 * 要求写「记一下：内容」或「记一下 内容」这两个看得见的形状，代价远小于
 * 隔三差五记一条不相干的笔记。
 *
 * 分成两条而不是一条，是因为结尾不同：标点式后面**占满整句**（可以带逗号、
 * 带句号，正文一个字都不丢），空格式式后面必须紧跟非空白内容。
 *
 * 动词拆成 `记|记录` 再接 `一?\s*下?`，而不是 `一?下|录`：`记录一下` 里「录」
 * 和「一下」都跟着记号，不拆开的话正文会被吃成「一下 报价」。
 */
const SEPARATOR = '[:：、，,]';

const EXPLICIT_COLON = new RegExp(
  `^${POLITE}(?:记|记录)\\s*一?\\s*下?\\s*${SEPARATOR}\\s*([\\s\\S]+)$`,
);
const EXPLICIT_SPACE = new RegExp(
  `^${POLITE}(?:记|记录)\\s*一?\\s*下?\\s+(\\S[\\s\\S]*)$`,
);

/**
 * 说了「记一下」就没下文。它自己不产生笔记，只为把「没听出要记什么」换成一句
 * 更准的话：用户明明已经说了「记一下」，只是还没跟内容。
 *
 * 分隔符可有可无 —— 「记一下」和「记一下：」是同一种没说完。
 */
const EXPLICIT_BARE = new RegExp(
  `^${POLITE}(?:记|记录)\\s*一?\\s*下?\\s*${SEPARATOR}?${TAIL}$`,
);

/** 指代词。 */
const ANAPHORA = '(?:刚才|刚刚|上面那|上面|上述|上一|这几|这些|此|这|那)';

/**
 * 指代词与「记」之间最多 4 个字：「的」「说的」「那段内容」「上面那点」。
 *
 * 拆成「指代词 + 量词」两个必选段反而会互相卡住：「这段」会先被指代词吃掉
 * 一个「这」，剩下的「段」谁也消费不掉。留一段有界间隔更耐用。
 */
const BRIDGE = '[\\u4e00-\\u9fa5]{0,4}?';

/**
 * 「记」的补语。**必选**，这是句尾那条防线的位置。
 *
 * 「刚才那段不用记」里的「记」是光杆动词，后面什么都没有 —— 那里根本没有
 * 「记下来」这个动作，正文得往别处找，于是错手记了上一条回复。补语必选之后
 * 这句直接不成立：用户说的是「不用记」，系统就该当没听见这句话。
 *
 * 「着」也在列：「把刚才那段记着」是同义说法。
 */
const SAVE_TAIL = '(?:下来|下|着|到笔记|进笔记|到备忘|进备忘)';

/** 指代式：「把刚才那段记下来」。整句锚定，含礼貌与语气词。 */
const ANAPHORIC = new RegExp(
  `^${POLITE}(?:把|将)?\\s*${ANAPHORA}\\s*${BRIDGE}(?:记|存|保存|写)\\s*录?\\s*一?\\s*${SAVE_TAIL}${TAIL}$`,
);

/**
 * 解析。「上一条回复」由调用方传进来 —— 解析器不该自己去翻会话历史，
 * 否则同一条输入在两个时刻会得到两个不同的结果，测试也就没法固定基准。
 */
export function parseNote(text: string, lastReply?: string): NoteAttempt {
  const input = text.trim();
  if (!input) return { ok: false, reason: '没听清要记什么。', near: false };

  // 指代句先判：它含「记下」，先跑 EXPLICIT 的话正文会被吃成那个「来」。
  if (ANAPHORIC.test(input)) {
    const body = (lastReply ?? '').trim();
    // 「刚才那段」不存在时**不记一条空的**，更不编一段出来。
    if (!body)
      return {
        ok: false,
        reason:
          '上面还没有可以记下来的回复，先说点什么或者直接「记一下：内容」。',
        near: true,
      };
    return { ok: true, draft: { title: titleOf(body), body } };
  }

  const colon = input.match(EXPLICIT_COLON);
  if (colon) {
    const body = (colon[1] ?? '').trim();
    if (!body) return blank();
    return { ok: true, draft: { title: titleOf(body), body } };
  }

  const space = input.match(EXPLICIT_SPACE);
  if (space) {
    const body = (space[1] ?? '').trim();
    if (!body) return blank();
    return { ok: true, draft: { title: titleOf(body), body } };
  }

  if (EXPLICIT_BARE.test(input)) return blank();

  return {
    ok: false,
    reason:
      '没听出要记什么。试试「记一下：内容」，或者说「把刚才那段记下来」。',
    // 认不出来，且看不出用户是想记东西 —— 当闲聊，不解释。
    near: false,
  };
}

/** 「说了记一下却没说要记什么」。用户已经开口了，只差内容，告诉他差在哪。 */
const blank = (): NoteAttempt => ({
  ok: false,
  reason: '说了「记一下」但没说要记什么。',
  near: true,
});

/**
 * 标题取首行、截到 24 字。
 *
 * 刻意**不用正文的前 24 个字就算** —— 多行笔记的第一行往往是「关于…」，
 * 拿整段开头会让标题读起来像半句话。
 */
export function titleOf(body: string): string {
  const firstLine =
    body.split('\n').find((line) => line.trim().length > 0) ?? '';
  const trimmed = firstLine.trim();
  return trimmed.length > NOTE_TITLE_LIMIT
    ? `${trimmed.slice(0, NOTE_TITLE_LIMIT)}…`
    : trimmed;
}
