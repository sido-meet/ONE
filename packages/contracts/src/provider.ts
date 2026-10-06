import { ClientError } from './errors.ts';
import type {
  CalendarCreateInput,
  CalendarDeleteInput,
  CalendarEvent,
  CalendarPage,
  CalendarUpdateInput,
  CommandContext,
  DeleteResult,
  NormalizedCalendarListInput,
  NormalizedNotesListInput,
  Note,
  NotePage,
  NotesCreateInput,
  NotesDeleteInput,
  NotesUpdateInput,
} from './domain.ts';

/**
 * 领域能力的规范化端口（ADR-016）。
 *
 * 关键点有两个：端口签名收**已解析**类型，不再是 `unknown` —— 校验只发生在本体
 * 边界一次（domain.ts 的 parseXxx），提供方拿到的一定是可信输入；第二，端口只描述
 * 数据与行为，不描述界面 —— 插件自带的页面走 ADR-018 的沙箱 iframe，不在这里出现。
 */

/** 两类领域能力。Agent 不是领域能力，不进这里。 */
export type DomainKind = 'calendar' | 'notes';

/** 能力名只说做什么，不带实现前缀（ADR-017）：换实现不改调用方。 */
export const CALENDAR_CAPABILITIES = [
  'calendar.list',
  'calendar.create',
  'calendar.update',
  'calendar.delete',
] as const;
export const NOTES_CAPABILITIES = [
  'notes.list',
  'notes.create',
  'notes.update',
  'notes.delete',
] as const;

/** 中文标签集中在这里，文案不散落到各个调用点。 */
export const DOMAIN_LABELS: Record<DomainKind, string> = {
  calendar: '日历',
  notes: '笔记',
};

export interface CalendarProvider {
  list(
    context: CommandContext,
    input: NormalizedCalendarListInput,
  ): Promise<CalendarPage>;
  create(
    context: CommandContext,
    input: CalendarCreateInput,
  ): Promise<CalendarEvent>;
  update(
    context: CommandContext,
    input: CalendarUpdateInput,
  ): Promise<CalendarEvent>;
  remove(
    context: CommandContext,
    input: CalendarDeleteInput,
  ): Promise<DeleteResult>;
}

export interface NotesProvider {
  list(
    context: CommandContext,
    input: NormalizedNotesListInput,
  ): Promise<NotePage>;
  create(context: CommandContext, input: NotesCreateInput): Promise<Note>;
  update(context: CommandContext, input: NotesUpdateInput): Promise<Note>;
  remove(
    context: CommandContext,
    input: NotesDeleteInput,
  ): Promise<DeleteResult>;
}

/**
 * 提供方的可得性。四种不可用的原因必须分开：没安装、装了没运行、没授权、版本对不上。
 * 一旦合成一句「出了点问题」，UI 就没法给出不同的引导。
 */
export type ProviderStatus = 'ready' | 'stopped' | 'denied';

export interface ProviderSlot<T> {
  /** 寻址键，如 local.calendar（ADR-017）。 */
  id: string;
  kind: DomainKind;
  status: ProviderStatus;
  /** status 为 denied 时给出具体缺哪几项权限。 */
  missingPermissions?: readonly string[];
  /** 提供方自报的版本，用于与本体期望做对比。 */
  providerVersion?: number;
  /** status 为 ready 时才存在。 */
  provider?: T;
}

/** 结构化的失败原因。文案会改，这个不会，UI 靠它分流。 */
export type ProviderUnavailableReason =
  'not-installed' | 'not-running' | 'not-authorized' | 'version-conflict';

export interface ProviderProblem {
  kind: DomainKind;
  reason: ProviderUnavailableReason;
  /** 没安装时为空字符串：还没有 provider 可说。 */
  provider: string;
  missing?: readonly string[];
  providerVersion?: number;
  coreVersion?: number;
}

const problem = (
  code: 'UNAVAILABLE' | 'PERMISSION_DENIED' | 'CONFLICT',
  message: string,
  detail: ProviderProblem,
) => new ClientError(code, message, { providerProblem: detail });

/** 根本没安装：还有怎么装的信息，不能与「装了没运行」共用一句话。 */
export function providerNotInstalled(kind: DomainKind): ClientError {
  const label = DOMAIN_LABELS[kind];
  return problem('UNAVAILABLE', `还没有接${label}源`, {
    kind,
    reason: 'not-installed',
    provider: '',
  });
}

/** 装了但进程没跑：说的是连接不上，不是功能不存在。 */
export function providerNotRunning(kind: DomainKind, id: string): ClientError {
  const label = DOMAIN_LABELS[kind];
  return problem('UNAVAILABLE', `${label}源没有连上`, {
    kind,
    reason: 'not-running',
    provider: id,
  });
}

/** 装了但用户没授权：必须指出缺哪一项，否则用户不知道怎么解决。 */
export function providerNotAuthorized(
  kind: DomainKind,
  id: string,
  missing: readonly string[],
): ClientError {
  const label = DOMAIN_LABELS[kind];
  return problem(
    'PERMISSION_DENIED',
    `${label}源缺少授权：${missing.join('、')}`,
    { kind, reason: 'not-authorized', provider: id, missing },
  );
}

/** 版本对不上：带上双方版本，UI 做对比而不是覆盖。 */
export function providerVersionConflict(
  kind: DomainKind,
  id: string,
  providerVersion: number,
  coreVersion: number,
): ClientError {
  const label = DOMAIN_LABELS[kind];
  return problem(
    'CONFLICT',
    `${label}源版本与 ONE 不一致（插件 ${providerVersion}，本体 ${coreVersion}）`,
    {
      kind,
      reason: 'version-conflict',
      provider: id,
      providerVersion,
      coreVersion,
    },
  );
}

/** 本体期望的提供方契约版本；提供方版本不同即冲突，不做兼容猜测。 */
export const PROVIDER_CONTRACT_VERSION = 1;

/**
 * 解析端口，未就绪时抛出对应语义的那一个错误。
 *
 * `slot` 为 undefined 表示根本没安装 —— 这与「装了但没运行」是两种情况，
 * 调用方不该自己判，所以由这里统一翻译。
 */
export function resolveProvider<T>(
  slot: ProviderSlot<T> | undefined,
  kind: DomainKind,
): T {
  if (!slot) throw providerNotInstalled(kind);
  if (slot.status === 'denied')
    throw providerNotAuthorized(kind, slot.id, slot.missingPermissions ?? []);
  if (slot.status === 'stopped') throw providerNotRunning(kind, slot.id);
  if (slot.providerVersion !== undefined) {
    const providerVersion = slot.providerVersion;
    if (providerVersion !== PROVIDER_CONTRACT_VERSION)
      throw providerVersionConflict(
        kind,
        slot.id,
        providerVersion,
        PROVIDER_CONTRACT_VERSION,
      );
  }
  if (!slot.provider) throw providerNotRunning(kind, slot.id);
  return slot.provider;
}
