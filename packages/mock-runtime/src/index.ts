import { createConversationRuntime } from '../../conversation/src/runtime.ts';
import { createMemoryStore } from './store-memory.ts';
import { createMockAgents } from './agent.ts';
import type {
  ConversationRuntime,
  ReplyAgent,
} from '../../contracts/src/index.ts';

/**
 * 模拟运行时的**装配**（ADR-028）。
 *
 * 状态机只有一份（`core/src/conversation/runtime.ts`），Agent 只有一个接口
 * （`ReplyAgent`）。这个文件只负责把「内存 Store + 模拟 Agent」接起来，给测试与
 * 开发用 —— 生产走的是同一个运行时，只是 Store 换成 SQLite、Agent 换成真模型。
 *
 * 名字叫 `createMemoryRuntime` 而不是 `createMemoryRuntime`：它返回的是运行时，不是
 * 客户端；「内存」说的是存储，不是「假的」。当年这个名字把「会话状态机」和
 * 「模拟回复」绑在了一起，正是这轮要拆开的东西。
 */
export { createMemoryProviders } from './domain.ts';
export type { MemoryProviders } from './domain.ts';
export { createMemoryStore } from './store-memory.ts';
export type { MemoryStoreOptions } from './store-memory.ts';
export { createMockAgents, agentCatalog } from './agent.ts';
export { parseSchedule, DEFAULT_DURATION_MINUTES } from './schedule.ts';
export type { ScheduleAttempt } from './schedule.ts';

export function createMemoryRuntime(
  options: { tickMs?: number; agents?: ReplyAgent[] } = {},
): ConversationRuntime {
  return createConversationRuntime(
    createMemoryStore({
      conversations: [
        {
          id: 'welcome',
          workspaceId: 'personal',
          title: '从这里开始 ONE',
          agentId: 'chat',
          createdAt: new Date().toISOString(),
        },
      ],
    }),
    options.agents ?? createMockAgents(),
    { tickMs: options.tickMs },
  );
}
