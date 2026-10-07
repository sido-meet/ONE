import { describe, expect, it } from 'vitest';
import { NOTE_TITLE_LIMIT, parseNote } from './note';

/**
 * 与日程解析器同一件事：**哪些话它敢接、哪些不敢**。
 *
 * 笔记记错的代价比日程小，但一个会乱记东西的助手用两次就没人敢用了 ——
 * 所以「拒绝」的例子和「接受」的一样重要。
 */

const accept = (text: string, last?: string) => {
  const result = parseNote(text, last);
  if (!result.ok)
    throw new Error(`本该认出来却没认出来：${text} —— ${result.reason}`);
  return result.draft;
};
const refuse = (text: string, last?: string) => {
  const result = parseNote(text, last);
  if (result.ok) throw new Error(`本该拒绝却认出来了：${text}`);
  return result.reason;
};

const REPLY =
  '今天复盘的三点结论：一、日历要提前一天排；二、插件页面不能再拖。';

describe('中文笔记句式', () => {
  it('认得「记一下：内容」，冒号可有可无', () => {
    expect(accept('记一下：客户要求下周给报价').body).toBe(
      '客户要求下周给报价',
    );
    expect(accept('记一下 客户要求下周给报价').body).toBe('客户要求下周给报价');
    expect(accept('记一下，客户要求下周给报价').body).toBe(
      '客户要求下周给报价',
    );
    expect(accept('记录：客户要求下周给报价').body).toBe('客户要求下周给报价');
  });

  it('正文里的换行与标点原样保留', () => {
    const body = '第一行\n第二行，带逗号、句号。';
    expect(accept(`记一下：${body}`).body).toBe(body);
  });

  it('「把刚才那段记下来」取的是上一条回复，正是验收里那条', () => {
    expect(accept('把刚才那段记下来', REPLY).body).toBe(REPLY);
    expect(accept('把上面这段记下来', REPLY).body).toBe(REPLY);
    expect(accept('这段记一下', REPLY).body).toBe(REPLY);
  });

  it('没有上一条回复时不编一段出来', () => {
    // 空房间里说「把刚才那段记下来」，记一条空的或编出来的都是撒谎。
    const reason = refuse('把刚才那段记下来');
    expect(reason).toContain('上面还没有');
    expect(reason).toContain('记一下');
  });

  it('标题取首行并截断，不拿整段开头当标题', () => {
    const draft = accept(`记一下：${REPLY}`);
    expect(draft.title.length).toBeLessThanOrEqual(NOTE_TITLE_LIMIT + 1);
    expect(draft.body).toBe(REPLY);
    // 多行笔记的第一行才是标题
    const multi = accept('记一下：关于插件页面\n正文第二行');
    expect(multi.title).toBe('关于插件页面');
  });

  it('标题带省略号而不是硬切', () => {
    const long = '一'.repeat(40);
    const draft = accept(`记一下：${long}`);
    expect(draft.title.endsWith('…')).toBe(true);
    expect(draft.title).toHaveLength(NOTE_TITLE_LIMIT + 1);
  });

  it('说了「记一下」却没说要记什么，会说清缺的是什么', () => {
    // 与「没听出是哪一天」同一件事：用户补一句话就能成，
    // 告诉他时间没听懂只会让他重打一遍。
    expect(refuse('记一下：')).toContain('没说要记什么');
    expect(refuse('记一下：   ')).toContain('没说要记什么');
  });

  it('跟日程无关的话不产生笔记', () => {
    expect(refuse('今天天气不错')).toContain('记一下');
    expect(refuse('明天下午三点安排面试')).toBeTruthy();
  });

  it('空输入不会被当成「记一条空的」', () => {
    expect(refuse('   ')).toBeTruthy();
  });

  /**
   * 下面这一组是实机验收前跑批量句式探测抓出来的。每一句在旧句式下都会被记成
   * 一条笔记，而且**都不报错** —— 用户看到的是「记好了」，回头翻笔记才发现多了
   * 一条「了」。记错不吵，安静地记错才吓人。
   */
  it('句子里只是提到「记」，不会被当成要记笔记', () => {
    // 「记」后面跟的是「得」「在」「不」，都不是分隔符。
    expect(refuse('你记得今天开会吗')).toContain('没听出');
    expect(refuse('这个功能还没记在文档里')).toContain('没听出');
    expect(refuse('这条不用记了')).toContain('没听出');
  });

  it('说「不用记」时不反手去记上一条回复', () => {
    // 光杆「记」后面没有补语，那里根本没有「记下来」这个动作。
    // 旧句式在这里会去抓上一条回复，于是用户说「别记」，ONE 照记不误。
    expect(refuse('刚才那段不用记', REPLY)).toContain('没听出');
    expect(refuse('这段不用记', REPLY)).toContain('没听出');
  });

  it('指代词与「记」之间允许几个字，但不许吞掉整句', () => {
    expect(accept('把刚才说的记下来', REPLY).body).toBe(REPLY);
    expect(accept('把刚才那段内容记下来', REPLY).body).toBe(REPLY);
    expect(accept('把刚才那段存到笔记', REPLY).body).toBe(REPLY);
    expect(accept('把刚才那段记下来吧。', REPLY).body).toBe(REPLY);
  });

  it('客气话前缀认得，但只认那几个', () => {
    expect(accept('帮我记一下：报价').body).toBe('报价');
    expect(accept('麻烦记一下：周五之前把方案发我').body).toBe(
      '周五之前把方案发我',
    );
    // 前缀是有限的一张表，不是「随便什么开头都行」。
    expect(refuse('给我一杯咖啡')).toContain('没听出');
  });

  it('标点分隔的正文占满整句，逗号与句号都不截断', () => {
    const body = '客户要求下周给报价，口头说的没有邮件。';
    expect(accept(`记一下：${body}`).body).toBe(body);
    expect(accept(`记一下，${body}`).body).toBe(body);
  });

  /**
   * `near` 是 `NoteAttempt` 的一部分，决定这句话要不要被解释给用户听。
   * 它和日程那边是一对：日程看钟点词，笔记看句式本身（句式都已锚定，命中即
   * 说明用户真的在记录）。
   */
  it('区分「用户开口了只差内容」与「压根是闲聊」', () => {
    const nearOf = (text: string, last?: string) => {
      const result = parseNote(text, last);
      if (result.ok) throw new Error(`本该拒绝却认出来了：${text}`);
      return result.near;
    };
    expect(nearOf('记一下')).toBe(true);
    expect(nearOf('帮我记一下')).toBe(true);
    expect(nearOf('记一下：')).toBe(true);
    expect(nearOf('把刚才那段记下来')).toBe(true);
    expect(nearOf('   ')).toBe(false);
    expect(nearOf('今天天气不错')).toBe(false);
    expect(nearOf('这条不用记了')).toBe(false);
  });
});
