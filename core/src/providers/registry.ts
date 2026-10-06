import type {
  CalendarProvider,
  CommandContext,
  DomainAction,
  DomainKind,
  NotesProvider,
  ParticipantInfo,
  ProviderId,
  ProviderSlot,
} from '../../../packages/contracts/src/index.ts';
import { DOMAIN_ACTIONS } from '../../../packages/contracts/src/index.ts';
import type { Core } from '../core.ts';

/**
 * 领域提供方的注册表（ADR-016）。
 *
 * 本体持有它、裁决它。提供方是本体外的独立进程：连上来就是「就绪」，断线就是
 * 「装了没运行」，没登记就是「没安装」—— 三种情况给三种不同的引导。
 *
 * 要紧的一句是**本体是唯一调用方**：宠物、桌面端、命令行都不直接找提供方，
 * 请求先到本体，由本体经端口转过去。所以提供方只实现自己的数据接口，不必知道
 * 谁在用，也不必自带会话与权限体系。
 *
 * 端口是**每次调用现读**的。提供方的在线状态随时会变，把 slot 冻在启动那一刻的
 * 话，提供方连上之后仍然会被报成「没运行」—— 那正是本体不该犯的错。
 */

export interface ProviderDeclaration {
  id: ProviderId;
  kind: DomainKind;
  /** 本体已知它缺哪些权限；本体据此报 PERMISSION_DENIED，不采信提供方自述。 */
  missingPermissions?: readonly string[];
}

const ACTIONS = DOMAIN_ACTIONS;
type Action = DomainAction;

export function createProviderRegistry(
  core: Core,
  declarations: readonly ProviderDeclaration[],
): {
  calendar: () => ProviderSlot<CalendarProvider> | undefined;
  notes: () => ProviderSlot<NotesProvider> | undefined;
  installed: () => readonly ProviderDeclaration[];
} {
  const byKind = new Map<DomainKind, ProviderDeclaration>();
  for (const declaration of declarations) {
    if (!byKind.has(declaration.kind))
      byKind.set(declaration.kind, declaration);
  }

  /**
   * 远端代理：端口的一次调用就是一次经本体的能力转发。本体进程里不留任何日历
   * 或笔记实体 —— 它们都在提供方那边（ADR-016 第 6 点）。
   */
  const portFor = (kind: DomainKind, target: ProviderId) =>
    Object.fromEntries(
      ACTIONS.map((action) => [
        action,
        (context: CommandContext, input: unknown): Promise<unknown> =>
          core.invoke(target, `${kind}.${action}`, { context, input }),
      ]),
    ) as unknown as CalendarProvider & NotesProvider;

  const slotFor = (kind: DomainKind) => {
    const declaration = byKind.get(kind);
    // 没登记就等于没安装。这与「装了没运行」是两种情况，界面的引导不同。
    if (!declaration) return undefined;
    const session = core
      .roster()
      .find(
        (entry: ParticipantInfo) =>
          entry.role === 'provider' && entry.provider === declaration.id,
      );
    if (!session)
      return {
        id: declaration.id,
        kind,
        status: 'stopped' as const,
        ...(declaration.missingPermissions
          ? { missingPermissions: declaration.missingPermissions }
          : {}),
      };
    // 提供方少申报了这类能力里的任何一个动作，本体都不放行：宁可报「没授权」，
    // 也不能把一个残缺的提供方当成完整的用，那会让调用在半路才失败。
    const missing = ACTIONS.filter(
      (action: Action) => !session.capabilities.includes(`${kind}.${action}`),
    );
    if (missing.length)
      return {
        id: declaration.id,
        kind,
        status: 'denied' as const,
        missingPermissions: missing.map((action) => `${kind}.${action}`),
      };
    return {
      id: declaration.id,
      kind,
      status: 'ready' as const,
      provider: portFor(kind, declaration.id),
    };
  };

  return {
    calendar: () => slotFor('calendar') as ProviderSlot<CalendarProvider>,
    notes: () => slotFor('notes') as ProviderSlot<NotesProvider>,
    installed: () => [...declarations],
  };
}
