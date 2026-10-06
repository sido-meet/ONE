import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 本地文件存储：日历与笔记的实体落在提供方自己的目录里（ADR-016 第 6 点）。
 *
 * 数据归提供方，本体不存副本。这正是"本体崩溃不带走日历数据"的由来：本体里
 * 根本没有这些数据，只有转发用的端口。
 *
 * 写入用"先写临时文件再改名"：进程在写一半时被杀掉，原文件仍然完整，不会留下
 * 一个被截断的 JSON 让下次启动直接读不出来。
 */

export interface JsonStore<T> {
  read(): T;
  write(next: T): void;
  /** 文件在不在。区分"没数据"与"有数据但是空的"。 */
  exists(): boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function createJsonStore<T>(file: string, fallback: T): JsonStore<T> {
  const dir = path.dirname(file);

  const ensureDir = () => {
    mkdirSync(dir, { recursive: true });
  };

  return {
    exists() {
      try {
        readFileSync(file, 'utf8');
        return true;
      } catch {
        return false;
      }
    },
    read() {
      let raw: string;
      try {
        raw = readFileSync(file, 'utf8');
      } catch {
        return structuredClone(fallback);
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) throw new Error('不是对象');
        return parsed as T;
      } catch (error) {
        // 坏文件不能静默当空：那样用户会以为日程全没了，而不是文件坏了。
        throw new Error(
          `数据文件损坏，已拒绝覆盖：${file}（${(error as Error).message}）`,
        );
      }
    },
    write(next: T) {
      ensureDir();
      const temporary = `${file}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      // 改名是原子的：读者要么看到旧的完整内容，要么看到新的完整内容。
      renameSync(temporary, file);
    },
  };
}
