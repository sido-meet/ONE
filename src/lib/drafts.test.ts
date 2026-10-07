import { describe, expect, it } from 'vitest';
import { createDraftBook } from './drafts';

/**
 * 每对话各留一份草稿。钉住的是「切走再切回来，那句话还在」以及
 * 「送出去之后草稿不再留着」这两件事。
 */
describe('每对话草稿', () => {
  it('切走再切回来，打了一半的那句还在', () => {
    const book = createDraftBook();
    book.save('welcome', '帮我看看这个');
    book.save('work', '明天下午三点');

    expect(book.take('welcome')).toBe('帮我看看这个');
    expect(book.take('work')).toBe('明天下午三点');
  });

  it('取出一次就没了 —— 那是「切过去」，不是复制一份', () => {
    const book = createDraftBook();
    book.save('welcome', '还没说完');
    expect(book.take('welcome')).toBe('还没说完');
    expect(book.read('welcome')).toBe('');
  });

  it('发送成功后清掉那一份', () => {
    const book = createDraftBook();
    book.save('welcome', '送出去了');
    book.clear('welcome');
    expect(book.read('welcome')).toBe('');
    expect(book.size()).toBe(0);
  });

  it('空的不占位', () => {
    // 对话列表一大，草稿表里全是空字符串的话，内存与排障都没法看。
    const book = createDraftBook();
    book.save('a', '');
    expect(book.size()).toBe(0);
    book.save('a', '有内容');
    book.save('a', '');
    expect(book.size()).toBe(0);
  });

  it('对话没了就把它忘掉，不留孤儿草稿', () => {
    const book = createDraftBook();
    book.save('gone', '草稿');
    book.forget('gone');
    expect(book.size()).toBe(0);
  });

  it('没写过的对话读到的是空串，不是 undefined', () => {
    expect(createDraftBook().read('never-seen')).toBe('');
    expect(createDraftBook().take('never-seen')).toBe('');
  });
});
