import type { ErrorCode, Snapshot } from './index.ts';
import { isErrorCode } from './errors.ts';
import { isPagePath, parsePluginView } from './page.ts';
import type { PluginView } from './page.ts';

/**
 * Wire protocol between ONE core and any participant (docs/03, ADR-013/017).
 *
 * ONE 本体是唯一的状态与能力来源；参与者只是呈现形式或领域提供方，可以是宠物、
 * 桌面端、命令行，也可以是日历、笔记这类提供方。core 同时充当参与者之间的调用
 * 中介：每个参与者在 hello 里申报自己的能力，任何参与者都能通过 core 调用另一个
 * 参与者的能力。
 *
 * 传输是有长度边界的逐行 JSON（Windows 命名管道），协议版本不兼容即拒绝。
 *
 * v3 的变化是参与者多申报了一件事：`view`。插件是「数据接口 + 自带页面」两件货
 * （ADR-018），本体据此知道哪个寻址键能开页面，宿主据此决定能不能开窗。之所以要升
 * 版本而不是加个可选字段：v2 的本体会**静默丢掉**这个字段，于是页面永远打不开而
 * 没有任何一方报错 —— 那正是版本守卫要挡住的情况。
 *
 * v4 的变化是会话快照多了一个 `proposals`，并多了一条白名单命令
 * `proposalResolve`（ADR-022）。同样必须升版本：v3 的本体不认识这两个字段，它会把
 * 提议**静默丢掉**，界面上的「确认」按钮点下去永远没有回音 —— 用户看到的是一张
 * 装点门面的卡片，比没有更糟。
 */
export const WIRE_VERSION = 4;

/**
 * 呈现角色，纯标签，core 不为它写任何特判：客户端报 pet / desktop / cli，领域
 * 提供方报 provider。刻意不穷举 —— 每加一种角色就改协议，等于把注册表写成硬编码。
 */
export type ParticipantRole = string;

/**
 * 唯一寻址键。客户端与提供方共用一个命名空间：pet、desktop、local.calendar。
 * `capability.call.target` 靠它寻址，因此它必须全局唯一。
 */
export type ProviderId = string;

/**
 * 能力名只说做什么，不带实现前缀（ADR-017）。以前叫 `pet.bubble.open`，换实现
 * 就要改调用方代码；现在叫 `bubble.open`，由谁提供交给 target 决定。
 *
 * 前后端各有一份字符串，所以这里给出唯一真相源：Rust 侧无法 import，改为由测试
 * 保证一致（见 src-tauri/src/main.rs 的能力声明测试）。
 */
export const CAPABILITY = {
  /** 参与者自报当前状态摘要。 */
  stateSummary: 'state.summary',
  /** 呼出对话条。 */
  bubbleOpen: 'bubble.open',
  /** 显示 / 隐藏参与者自己的主窗口。 */
  windowShow: 'window.show',
  windowHide: 'window.hide',
  /** 拉起另一个已安装的参与者，参数为 { provider }。 */
  clientLaunch: 'client.launch',
} as const;

export interface ParticipantInfo {
  id: string;
  role: ParticipantRole;
  provider: ProviderId;
  label: string;
  /** 形如 `bubble.open`、`calendar.create`，按字符串寻址。 */
  capabilities: string[];
  /**
   * 自带页面的入口（ADR-018）。只有真正提供页面的插件才申报，宿主不采信页面自报
   * 的身份：这个字段连同窗口标签一起，决定这个窗口属于谁。
   */
  view?: PluginView;
}

export interface RosterEntry extends ParticipantInfo {
  connectedAt: string;
}

/** 客户端 → core */
export type ClientMessage =
  | {
      t: 'hello';
      v: number;
      client: {
        role: ParticipantRole;
        provider: ProviderId;
        label: string;
        capabilities: string[];
        view?: PluginView;
      };
    }
  | { t: 'call'; id: string; cmd: string; args: unknown[] }
  | { t: 'clients.list'; id: string }
  | { t: 'clients.launch'; id: string; provider: ProviderId }
  /**
   * 取插件页面的一段资源。宿主不自己找提供方要文件：这个请求必须经本体，好让本体
   * 用它那份权威名册确认对方**确实**申报过页面与 `page.read`（ADR-016/018）。
   */
  | { t: 'page.read'; id: string; provider: ProviderId; path: string }
  | {
      t: 'capability.call';
      id: string;
      target: ProviderId;
      capability: string;
      args?: unknown;
    }
  | { t: 'capability.result'; id: string; ok: true; value?: unknown }
  /**
   * `code` 是可选的，但带上才有意义：被调用的参与者如果不报码，本体只能按
   * INTERNAL 处理，而本体与壳正是靠码把「没这个文件」「没运行」「没授权」
   * 分开说（ADR-016）。少了它，一个 NOT_FOUND 到壳那里会变成 502。
   */
  | {
      t: 'capability.result';
      id: string;
      ok: false;
      message: string;
      code?: ErrorCode;
    }
  | { t: 'ping' };

/** core → 客户端 */
export type CoreMessage =
  | {
      t: 'welcome';
      v: number;
      clientId: string;
      coreVersion: string;
    }
  | { t: 'state'; revision: number; snapshot: Snapshot }
  | { t: 'result'; id: string; ok: true; value?: unknown }
  | {
      t: 'result';
      id: string;
      ok: false;
      error: {
        code: ErrorCode;
        message: string;
        details?: Record<string, unknown>;
      };
    }
  | { t: 'roster'; participants: RosterEntry[]; installed: ProviderId[] }
  | { t: 'invoke'; id: string; capability: string; args?: unknown }
  | { t: 'rejected'; message: string }
  | { t: 'pong' };

/**
 * 寻址键的形状：小写字母开头，点或连字符分段，如 pet、local.calendar。
 * 刻意不放行空格、大写与斜杠 —— 它们会出现在日志和 URL 里，是命令注入的入口。
 */
const PROVIDER_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const ROLE = /^[a-z][a-z0-9-]*$/;
const MAX_PROVIDER_ID = 128;
const MAX_ROLE = 32;

export function isProviderId(value: unknown): value is ProviderId {
  return (
    typeof value === 'string' &&
    value.length <= MAX_PROVIDER_ID &&
    PROVIDER_ID.test(value)
  );
}

export function isParticipantRole(value: unknown): value is ParticipantRole {
  return (
    typeof value === 'string' && value.length <= MAX_ROLE && ROLE.test(value)
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Untrusted input from a socket: anything unrecognised is rejected, not guessed. */
export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isRecord(value) || typeof value.t !== 'string') return null;
  switch (value.t) {
    case 'hello': {
      if (typeof value.v !== 'number') return null;
      const client = isRecord(value.client) ? value.client : null;
      if (!client || !isParticipantRole(client.role)) return null;
      if (!isProviderId(client.provider)) return null;
      if (typeof client.label !== 'string') return null;
      const capabilities = Array.isArray(client.capabilities)
        ? client.capabilities.filter(
            (item): item is string => typeof item === 'string',
          )
        : [];
      // 申报了页面却没有合法入口，等于没申报：静默降级会让宿主开出一个空窗口。
      const view = parsePluginView(client.view);
      return {
        t: 'hello',
        v: value.v,
        client: {
          role: client.role,
          provider: client.provider,
          label: client.label.slice(0, 64),
          capabilities: capabilities.slice(0, 32),
          ...(view ? { view } : {}),
        },
      };
    }
    case 'call':
      if (typeof value.id !== 'string' || !value.id) return null;
      if (typeof value.cmd !== 'string') return null;
      if (!Array.isArray(value.args)) return null;
      return { t: 'call', id: value.id, cmd: value.cmd, args: value.args };
    case 'clients.list':
      if (typeof value.id !== 'string' || !value.id) return null;
      return { t: 'clients.list', id: value.id };
    case 'clients.launch':
      if (typeof value.id !== 'string' || !value.id) return null;
      if (!isProviderId(value.provider)) return null;
      return { t: 'clients.launch', id: value.id, provider: value.provider };
    case 'page.read':
      if (typeof value.id !== 'string' || !value.id) return null;
      if (!isProviderId(value.provider)) return null;
      if (!isPagePath(value.path)) return null;
      return {
        t: 'page.read',
        id: value.id,
        provider: value.provider,
        path: value.path,
      };
    case 'capability.call':
      if (typeof value.id !== 'string' || !value.id) return null;
      if (!isProviderId(value.target)) return null;
      if (typeof value.capability !== 'string' || !value.capability)
        return null;
      return {
        t: 'capability.call',
        id: value.id,
        target: value.target,
        capability: value.capability.slice(0, 64),
        args: value.args,
      };
    case 'capability.result':
      if (typeof value.id !== 'string' || !value.id) return null;
      if (typeof value.ok !== 'boolean') return null;
      if (value.ok)
        return {
          t: 'capability.result',
          id: value.id,
          ok: true,
          value: value.value,
        };
      if (typeof value.message !== 'string') return null;
      const code = isErrorCode(value.code) ? value.code : undefined;
      return {
        t: 'capability.result',
        id: value.id,
        ok: false,
        message: value.message.slice(0, 200),
        ...(code ? { code } : {}),
      };
    case 'ping':
      return { t: 'ping' };
    default:
      return null;
  }
}

/** Upper bound on one frame so a broken client cannot exhaust memory. */
export const MAX_FRAME_BYTES = 1024 * 1024;

const isRosterEntry = (value: unknown): value is RosterEntry => {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    isParticipantRole(value.role) &&
    isProviderId(value.provider) &&
    typeof value.label === 'string' &&
    typeof value.connectedAt === 'string' &&
    Array.isArray(value.capabilities)
  );
};

/**
 * The mirror of `parseClientMessage`, for the other direction. A renderer that
 * receives a raw line from the shell must run it through here before acting:
 * `CoreMessage` describes what the core may send, not what actually arrived.
 */
export function parseCoreMessage(value: unknown): CoreMessage | null {
  if (!isRecord(value) || typeof value.t !== 'string') return null;
  switch (value.t) {
    case 'welcome':
      if (typeof value.v !== 'number') return null;
      if (typeof value.clientId !== 'string' || !value.clientId) return null;
      if (typeof value.coreVersion !== 'string') return null;
      return {
        t: 'welcome',
        v: value.v,
        clientId: value.clientId,
        coreVersion: value.coreVersion,
      };
    case 'state':
      if (typeof value.revision !== 'number') return null;
      if (!isRecord(value.snapshot)) return null;
      return {
        t: 'state',
        revision: value.revision,
        snapshot: value.snapshot as unknown as Snapshot,
      };
    case 'result': {
      if (typeof value.id !== 'string' || !value.id) return null;
      if (typeof value.ok !== 'boolean') return null;
      if (value.ok) {
        return { t: 'result', id: value.id, ok: true, value: value.value };
      }
      const error = isRecord(value.error) ? value.error : null;
      if (
        !error ||
        typeof error.code !== 'string' ||
        typeof error.message !== 'string'
      )
        return null;
      return {
        t: 'result',
        id: value.id,
        ok: false,
        error: {
          code: error.code as ErrorCode,
          message: error.message,
          ...(isRecord(error.details) ? { details: error.details } : {}),
        },
      };
    }
    case 'roster':
      if (!Array.isArray(value.participants) || !Array.isArray(value.installed))
        return null;
      return {
        t: 'roster',
        participants: value.participants.filter(isRosterEntry).map((entry) => {
          // 名册是本体给的权威事实，页面入口仍然要过一遍路径守卫：宿主会把它拼进
          // one-plugin:// 地址，坏路径在这里就该挡住，而不是等开窗才失败。
          const { view, ...rest } = entry;
          const parsed = parsePluginView(view);
          return { ...rest, ...(parsed ? { view: parsed } : {}) };
        }),
        installed: value.installed.filter(isProviderId),
      };
    case 'invoke':
      if (typeof value.id !== 'string' || !value.id) return null;
      if (typeof value.capability !== 'string' || !value.capability)
        return null;
      return {
        t: 'invoke',
        id: value.id,
        capability: value.capability,
        args: value.args,
      };
    case 'rejected':
      if (typeof value.message !== 'string') return null;
      return { t: 'rejected', message: value.message };
    case 'pong':
      return { t: 'pong' };
    default:
      return null;
  }
}
