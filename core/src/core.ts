import { ClientError } from '../../packages/contracts/src/index.ts';
import type {
  AgentId,
  CalendarProvider,
  ClientMessage,
  CommandContext,
  ConversationRuntime,
  CoreMessage,
  NotesProvider,
  ParticipantInfo,
  ProviderId,
  ProviderSlot,
  ProposalResolution,
  RosterEntry,
} from '../../packages/contracts/src/index.ts';
import {
  parseCalendarCreate,
  parseCalendarDelete,
  parseCalendarList,
  parseCalendarUpdate,
  parseNotesCreate,
  parseNotesDelete,
  parseNotesGet,
  parseNotesList,
  parseNotesUpdate,
  parseProposalResolve,
  proposalIdempotencyKey,
  resolveProvider,
  settledResolution,
} from '../../packages/contracts/src/index.ts';
import { WIRE_VERSION } from '../../packages/contracts/src/wire.ts';
import { isProviderId } from '../../packages/contracts/src/wire.ts';
import { PAGE_READ_CAPABILITY } from '../../packages/contracts/src/page.ts';
import type { BackupService } from './backup.ts';

/**
 * ONE 本体的会话中枢（ADR-013）。
 *
 * 它持有唯一的会话运行时、执行白名单命令、广播带 revision 的快照，并充当
 * 客户端之间的调用中介：谁申报了什么能力，谁就能通过这里调用谁。传输层
 * （命名管道）不在这层，因此没有 socket 也能测试。
 */
export interface Connection {
  send(message: CoreMessage): void;
  close(): void;
}

/**
 * 本体持有的领域端口（ADR-016）。
 *
 * 是**函数**而不是值：提供方是运行时连上来的进程，在线状态随时会变。把 slot
 * 冻在启动那一刻的话，提供方连上之后仍会被报成「没运行」。每次命令现读一次，
 * 拿到的就是当下的实情。
 *
 * 返回 undefined 表示「没安装」，与「装了没运行」是两种情况，由 resolveProvider
 * 分开报错。
 */
export interface DomainPorts {
  calendar?: () => ProviderSlot<CalendarProvider> | undefined;
  notes?: () => ProviderSlot<NotesProvider> | undefined;
}

export interface CoreOptions {
  version: string;
  /** 已安装的参与者寻址键；默认只装宠物。 */
  installed?: ProviderId[];
  /** 参与者之间互调的等待上限。 */
  capabilityTimeoutMs?: number;
  /** 由宿主注入的启动器；core 不认识任何具体可执行文件。 */
  launchClient?: (provider: ProviderId) => Promise<void> | void;
  /** 领域能力提供方；未给的种类一律按「没安装」处理。 */
  domains?: DomainPorts;
  /**
   * 安装清单变了就告诉宿主，由宿主落盘。
   *
   * 本体**不该知道**清单写在哪个文件、也没有那个必要 —— 它持有的是「装了什么」
   * 这个决定，「记在哪」是宿主与运行环境的事。不接这个回调也不会坏，只是清单
   * 停在进程启动时的样子。
   */
  onInstalledChange?: (ids: ProviderId[]) => void;
  /**
   * 备份服务（ADR-029）。**是函数而不是值**：备份服务要拿 core 自己的 `invoke` 去问
   * 参与者，而 core 此刻还没建好 —— 与 `domains` 同一个套路，装配点后填。
   */
  backup?: () => BackupService | undefined;
}

interface Session {
  info: ParticipantInfo;
  connection: Connection;
  connectedAt: string;
  waiting: Map<
    string,
    // 拒绝时带的是 ClientError 而不是字符串：码要一路送到界面，否则"没这个文件"
    // 与"里面坏了"在用户那里长得一模一样（ADR-016）。
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >;
}

const CAPABILITY_TIMEOUT_MS = 5000;

export function createCore(runtime: ConversationRuntime, options: CoreOptions) {
  const sessions = new Map<string, Session>();
  const installed = new Set<ProviderId>(options.installed ?? ['pet']);
  const domains = options.domains ?? {};
  let revision = 0;

  /**
   * 装上/卸下，并**告诉宿主清单变了**。
   *
   * 本体不负责把清单写到磁盘 —— 它不该知道文件在哪、也没有那个必要。宿主把
   * `onInstalledChange` 接上，由它落盘。这条分工是「本体持有安装清单」的形状：
   * 本体持有**决定**，宿主持有**记录**。
   *
   * 改了就得立刻广播名册：界面上「未安装」的入口与「装了没运行」的说法是两回事，
   * 改完不广播，界面会一直停在旧的那一边。
   */
  const markInstalled = (provider: ProviderId) => {
    if (installed.has(provider)) {
      // **已经在装，但仍然要落盘。** 进程里的清单和磁盘上的清单是两回事：
      // 环境变量可以临时把它们都装上，而文件里一个字都没有 —— 这时候跳过写入，
      // 下一次不带环境变量的启动就又回到了「什么都没装」。
      options.onInstalledChange?.([...installed]);
      return;
    }
    installed.add(provider);
    options.onInstalledChange?.([...installed]);
    pushRoster();
  };
  const unmarkInstalled = (provider: ProviderId) => {
    // `pet` 是本体自己的脸，不是插件：卸掉它等于界面都不出现。
    if (!installed.has(provider) || provider === 'pet') return;
    installed.delete(provider);
    options.onInstalledChange?.([...installed]);
    pushRoster();
  };

  /** 只把**认识的**寻址键挑出来。不认识的不在这里报错，交给调用方比数量。 */
  const providerIdList = (raw: unknown): ProviderId[] => {
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (item): item is ProviderId =>
        typeof item === 'string' && isProviderId(item),
    );
  };

  /**
   * 可选文本参数。**`null` 是管道里「没有值」的写法。**
   *
   * `JSON.stringify([undefined])` 得到的是 `"[null]"` —— 管道传不了 `undefined`。
   * 而 `function f(x = '默认')` 只对 `undefined` 生效，对 `null` 不生效，于是
   * `x.trim()` 抛异常。实测后果：桌面端「开始新对话」一点就是
   * 「ONE 内部出了点问题」，对话根本没建出来。
   *
   * 默认参数在这里是个陷阱：它让人以为「不传就安全」。可选参数在本体边界一律
   * 显式归一，别指望下游的默认值。
   */
  const optionalText = (raw: unknown): string | undefined =>
    typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;

  /**
   * 名册是「参与者」而不是「客户端」：呈现形式与领域提供方都能查得到。
   * 但界面不要把提供方画成宠物 —— 两者的图标与可用操作不同（ADR-017）。
   */
  const roster = (): RosterEntry[] =>
    [...sessions.values()].map((session) => ({
      ...session.info,
      connectedAt: session.connectedAt,
    }));

  const broadcast = (message: CoreMessage) => {
    sessions.forEach((session) => session.connection.send(message));
  };

  /**
   * 寻址键全局唯一，因此一个键至多一个会话。名册、名册校验与页面请求都靠它，
   * 不各写一份查找逻辑 —— 几份查找迟早会在边界情况上分叉。
   */
  const sessionsByProvider = (provider: ProviderId): Session | undefined =>
    [...sessions.values()].find(
      (session) => session.info.provider === provider,
    );

  const pushState = () => {
    revision += 1;
    broadcast({ t: 'state', revision, snapshot: runtime.getSnapshot() });
  };

  const pushRoster = () => {
    broadcast({
      t: 'roster',
      participants: roster(),
      installed: [...installed],
    });
  };

  const contextOf = (args: unknown[]) => args[0] as CommandContext;

  /**
   * 确认一条待写入的提议：本体是唯一动手的人（ADR-016/022）。
   *
   * 四件事按顺序发生，顺序本身就是行为：
   *
   * 1. 先看这条提议**在不在** —— 不在就是 NOT_FOUND，不能凭空造一条。
   * 2. 已经解决过的**直接回既有结果**，不再写第二次。这是「重复确认不重复创建」
   *    的定义；返回 `applied: false` 让界面能说清「已经建过了」，而不是假装
   *    又干了一遍。两次确认并发到达时由提供方的幂等键兜底（键由提议 id 派生），
   *    因此这里不需要锁 —— 拦住重复的是数据，不是时序。
   * 3. 拒绝**不碰提供方**：数据一个字节都不变，界面照实说「没写进去」。
   * 4. 确认才写。工作区取自**提议自己**而不是客户端上报的值：客户端只是
   *    一块屏幕，它没有资格决定写进谁的空间。
   */
  const resolveProposal = async (args: unknown[]) => {
    const input = parseProposalResolve(args[0]);
    const proposal = runtime
      .getSnapshot()
      .proposals.find((item) => item.id === input.proposalId);
    if (!proposal)
      throw new ClientError('NOT_FOUND', '找不到这条提议', {
        proposalId: input.proposalId,
      });
    if (proposal.status !== 'pending') return settledResolution(proposal);

    const at = new Date().toISOString();
    if (input.decision === 'reject') {
      const resolution: ProposalResolution = {
        proposalId: input.proposalId,
        applied: true,
        status: 'rejected',
        reason: input.reason,
        at,
      };
      await runtime.settleProposal(input.proposalId, resolution);
      return resolution;
    }

    // 可用性先于输入校验，与其他领域命令同一顺序（见 resolveProvider）。
    const context: CommandContext = {
      requestId: `proposal-${input.proposalId}`,
      workspaceId: proposal.workspaceId,
      source: 'ui',
    };
    const idempotencyKey = proposalIdempotencyKey(proposal.id);
    const sourceConversationId = proposal.sourceConversationId;

    // **按提议自己的 domain 分派**。写成「一律走日历」的话，一条笔记提议会被
    // 静默地写成一条日程：字段对不上，provide 方要么报错要么写出一个空标题的
    // 日程，而用户看到的是「成功」。判别联合在这里必须收拢，不能靠调用方。
    const entityId =
      proposal.domain === 'calendar'
        ? (
            await resolveProvider(domains.calendar?.(), 'calendar').create(
              context,
              parseCalendarCreate({
                ...proposal.draft,
                sourceConversationId,
                idempotencyKey,
              }),
            )
          ).id
        : (
            await resolveProvider(domains.notes?.(), 'notes').create(
              context,
              parseNotesCreate({
                ...proposal.draft,
                sourceConversationId,
                idempotencyKey,
              }),
            )
          ).id;

    const resolution: ProposalResolution = {
      proposalId: input.proposalId,
      applied: true,
      status: 'created',
      entityId,
      at,
    };
    await runtime.settleProposal(input.proposalId, resolution);
    return resolution;
  };

  /**
   * Whitelisted dispatch: the name arrives over the wire and is never trusted.
   *
   * 领域命令的顺序是「先解析提供方，再校验输入」：提供方不可用时校验参数没有
   * 意义，用户根本没机会把参数填对，报 VALIDATION 反而误导。可用性、授权与
   * 版本由 resolveProvider 统一翻译成本体裁决过的四种语义（ADR-016）。
   */
  const commands: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    createConversation: (...args) =>
      runtime.createConversation(optionalText(args[0])),
    changeAgent: (...args) =>
      runtime.changeAgent(args[0] as string, args[1] as AgentId),
    sendMessage: (...args) =>
      runtime.sendMessage(args[0] as string, args[1] as string),
    cancelRun: (...args) => runtime.cancelRun(args[0] as string),
    proposalResolve: (...args) => resolveProposal(args),
    /**
     * 备份三件事（ADR-029）。
     *
     * 走本体是有原因的，不只是「顺手」：数据分两个库、两个进程，只有本体能同时看到
     * 两边。客户端与插件页面都拿不到这一组命令 —— 前者只在命令白名单里，后者只认
     * `calendar.*` / `notes.*`。
     */
    dataExport: async (file) => {
      const service = options.backup?.();
      if (!service) throw new ClientError('UNAVAILABLE', '备份服务还没就绪');
      return service.exportTo(String(file ?? ''));
    },
    dataImport: async (file) => {
      const service = options.backup?.();
      if (!service) throw new ClientError('UNAVAILABLE', '备份服务还没就绪');
      return service.importFrom(String(file ?? ''));
    },
    dataForgetConversation: async (...args) => {
      const service = options.backup?.();
      if (!service) throw new ClientError('UNAVAILABLE', '备份服务还没就绪');
      const id = String(args[0] ?? '');
      service.forget(id);
      // 删完要让界面知道：留下来的名字还挂在侧栏上，用户会以为没删掉。
      pushState();
      return { forgotten: id };
    },
    dataExportDir: async () => options.backup?.()?.exportDir() ?? '',
    /**
     * 装上/卸下提供方。这是 0.1 的「安装器」：清单落盘由宿主做，本体只改决定。
     *
     * 认不出来的寻址键直接报 VALIDATION，不静默丢掉 —— 敲错一个 id 却显示
     * 「装好了」，用户等会儿打开日历发现还是没有，比报错难查得多。
     */
    installProviders: async (...args) => {
      const ids = providerIdList(args[0]);
      if (ids.length !== (args[0] as unknown[])?.length)
        throw new ClientError('VALIDATION', '有不认识的寻址键，没装成');
      ids.forEach((id) => markInstalled(id));
      return { installed: [...installed] };
    },
    uninstallProviders: async (...args) => {
      const ids = providerIdList(args[0]);
      if (ids.length !== (args[0] as unknown[])?.length)
        throw new ClientError('VALIDATION', '有不认识的寻址键，没卸成');
      ids.forEach((id) => unmarkInstalled(id));
      return { installed: [...installed] };
    },
    /**
     * 列出提议。界面靠快照里的 `proposals` 就够了，这条是给命令行与排障用的 ——
     * 它读的是**同一份**状态，不是另一处拷贝。
     */
    listProposals: async () =>
      runtime.getSnapshot().proposals.map((item) => ({
        id: item.id,
        domain: item.domain,
        status: item.status,
        // 两个域都有标题：写成只取日历那条，笔记在命令行里就成了一行空白的条目。
        title: item.draft.title,
        ...(item.domain === 'calendar'
          ? { startsAt: item.draft.startsAt }
          : { body: item.draft.body.slice(0, 120) }),
      })),
    /**
     * 读一段对话的往来的话。界面看得到，但这是本体持有的权威状态 —— 没有它，
     * 宠物窗口被别的东西盖住时（无边框置顶窗口常常还拿不到键盘焦点），
     * 「ONE 到底回了我什么」就只能靠猜。
     *
     * 读的是同一份快照，不是另一处拷贝。
     */
    conversationHistory: async (...args) => {
      const id = args[0] as string;
      const snapshot = runtime.getSnapshot();
      const conversation = snapshot.conversations.find(
        (item) => item.id === id,
      );
      if (!conversation) throw new ClientError('NOT_FOUND', '找不到这个对话');
      return {
        conversation: {
          id: conversation.id,
          title: conversation.title,
          agentId: conversation.agentId,
        },
        messages: snapshot.events
          .filter((event) => event.conversationId === id)
          .filter(
            (
              event,
            ): event is Extract<typeof event, { type: 'message.created' }> =>
              event.type === 'message.created',
          )
          .map((event) => ({
            role: event.message.role,
            content: event.message.content,
          })),
      };
    },
    calendarList: (...args) =>
      resolveProvider(domains.calendar?.(), 'calendar').list(
        contextOf(args),
        parseCalendarList(args[1]),
      ),
    calendarCreate: (...args) =>
      resolveProvider(domains.calendar?.(), 'calendar').create(
        contextOf(args),
        parseCalendarCreate(args[1]),
      ),
    calendarUpdate: (...args) =>
      resolveProvider(domains.calendar?.(), 'calendar').update(
        contextOf(args),
        parseCalendarUpdate(args[1]),
      ),
    calendarDelete: (...args) =>
      resolveProvider(domains.calendar?.(), 'calendar').remove(
        contextOf(args),
        parseCalendarDelete(args[1]),
      ),
    notesList: (...args) =>
      resolveProvider(domains.notes?.(), 'notes').list(
        contextOf(args),
        parseNotesList(args[1]),
      ),
    notesGet: (...args) =>
      resolveProvider(domains.notes?.(), 'notes').get(
        contextOf(args),
        parseNotesGet(args[1]),
      ),
    notesCreate: (...args) =>
      resolveProvider(domains.notes?.(), 'notes').create(
        contextOf(args),
        parseNotesCreate(args[1]),
      ),
    notesUpdate: (...args) =>
      resolveProvider(domains.notes?.(), 'notes').update(
        contextOf(args),
        parseNotesUpdate(args[1]),
      ),
    notesDelete: (...args) =>
      resolveProvider(domains.notes?.(), 'notes').remove(
        contextOf(args),
        parseNotesDelete(args[1]),
      ),
  };

  const describe = (error: unknown) =>
    error instanceof ClientError
      ? {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        }
      : { code: 'INTERNAL' as const, message: '核心执行该命令时出错' };

  const handleCall = async (
    session: Session,
    id: string,
    cmd: string,
    args: unknown[],
  ) => {
    const method = commands[cmd];
    if (!method) {
      session.connection.send({
        t: 'result',
        id,
        ok: false,
        error: { code: 'VALIDATION', message: `核心未提供命令 ${cmd}` },
      });
      return;
    }
    try {
      session.connection.send({
        t: 'result',
        id,
        ok: true,
        value: await method(...args),
      });
    } catch (error) {
      session.connection.send({
        t: 'result',
        id,
        ok: false,
        error: describe(error),
      });
    }
  };

  /** 参与者之间的调用：core 只转发，结果由被调用方自己给出。 */
  const handleCapabilityCall = (
    requester: Session,
    id: string,
    target: ProviderId,
    capability: string,
    args: unknown,
  ) => {
    const respond = (message: CoreMessage) =>
      requester.connection.send(message);
    const found = sessionsByProvider(target);
    if (!found) {
      respond({
        t: 'result',
        id,
        ok: false,
        error: { code: 'NOT_FOUND', message: `${target} 没有在运行` },
      });
      return;
    }
    if (!found.info.capabilities.includes(capability)) {
      respond({
        t: 'result',
        id,
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: `${target} 没有提供 ${capability}`,
        },
      });
      return;
    }
    const timer = setTimeout(() => {
      found.waiting.delete(id);
      respond({
        t: 'result',
        id,
        ok: false,
        error: { code: 'TIMEOUT', message: `${target} 没有回应 ${capability}` },
      });
    }, options.capabilityTimeoutMs ?? CAPABILITY_TIMEOUT_MS);
    found.waiting.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        respond({ t: 'result', id, ok: true, value });
      },
      reject: (message) => {
        clearTimeout(timer);
        respond({
          t: 'result',
          id,
          ok: false,
          error: describe(message),
        });
      },
    });
    found.connection.send({ t: 'invoke', id, capability, args });
  };

  /**
   * 本体自己发起的能力调用（ADR-016）。领域端口的远端实现靠它把请求转给管道
   * 另一端的提供方 —— 本体仍然是唯一调用方，只不过这次它代表自己说话，
   * 而不是替某个客户端转发。寻址、能力检查与超时都与 handleCapabilityCall
   * 同一套，免得两条路给出不同的失败语义。
   */
  const invoke = (
    target: ProviderId,
    capability: string,
    args?: unknown,
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const found = sessionsByProvider(target);
      if (!found) {
        reject(new ClientError('UNAVAILABLE', `${target} 没有在运行`));
        return;
      }
      if (!found.info.capabilities.includes(capability)) {
        reject(
          new ClientError('NOT_FOUND', `${target} 没有提供 ${capability}`),
        );
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        found.waiting.delete(id);
        reject(new ClientError('TIMEOUT', `${target} 没有回应 ${capability}`));
      }, options.capabilityTimeoutMs ?? CAPABILITY_TIMEOUT_MS);
      found.waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (message) => {
          clearTimeout(timer);
          // 目标报的码原样带走：界面上"日历源没授权"与"日历源崩了"必须分开。
          reject(
            message instanceof ClientError
              ? message
              : new ClientError(
                  'INTERNAL',
                  message instanceof Error
                    ? message.message
                    : '目标客户端处理失败',
                ),
          );
        },
      });
      found.connection.send({ t: 'invoke', id, capability, args });
    });

  /**
   * 取插件页面的一段资源（ADR-018）。
   *
   * 宿主不给插件页面发请求，只来这里要：要来的路径仍然按提供方申报的入口与
   * `page.read` 能力核对过才转发。三道闸门缺一不可 ——
   *
   * - 目标必须在场：没运行就报「没有在运行」，不是「没这个文件」；
   * - 目标必须**自己申报过页面**：没申报的参与者即使会答 `page.read` 也不放行，
   *   否则任何客户端都能借它当文件服务器；
   * - 目标必须提供 `page.read`：它没这个能力的话这次调用必然失败，不如本体先说。
   *
   * 本体自己不改写内容，只是转交 —— 页面长什么样归插件（ADR-018 已接受的代价）。
   */
  const handlePageRead = async (
    session: Session,
    id: string,
    provider: ProviderId,
    path: string,
  ) => {
    const respond = (message: CoreMessage) => session.connection.send(message);
    const found = sessionsByProvider(provider);
    if (!found) {
      respond({
        t: 'result',
        id,
        ok: false,
        error: { code: 'UNAVAILABLE', message: `${provider} 没有在运行` },
      });
      return;
    }
    if (!found.info.view) {
      respond({
        t: 'result',
        id,
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: `${provider} 没有自带页面`,
        },
      });
      return;
    }
    if (!found.info.capabilities.includes(PAGE_READ_CAPABILITY)) {
      respond({
        t: 'result',
        id,
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: `${provider} 没有提供 ${PAGE_READ_CAPABILITY}`,
        },
      });
      return;
    }
    try {
      respond({
        t: 'result',
        id,
        ok: true,
        value: await invoke(provider, PAGE_READ_CAPABILITY, { path }),
      });
    } catch (error) {
      respond({
        t: 'result',
        id,
        ok: false,
        error: describe(error),
      });
    }
  };

  const handleLaunch = async (id: string, provider: ProviderId) => {
    const running = [...sessions.values()].some(
      (session) => session.info.provider === provider,
    );
    const respond = (message: CoreMessage) => broadcast(message);
    if (running) {
      respond({ t: 'result', id, ok: true, value: { alreadyRunning: true } });
      return;
    }
    if (!installed.has(provider)) {
      respond({
        t: 'result',
        id,
        ok: false,
        error: { code: 'NOT_FOUND', message: `${provider} 还没有安装` },
      });
      return;
    }
    if (!options.launchClient) {
      respond({
        t: 'result',
        id,
        ok: false,
        error: { code: 'UNAVAILABLE', message: '当前核心没有配置启动器' },
      });
      return;
    }
    try {
      await options.launchClient(provider);
      respond({ t: 'result', id, ok: true, value: { launched: provider } });
    } catch (error) {
      respond({ t: 'result', id, ok: false, error: describe(error) });
    }
  };

  /** 被调用的参与者回执，转交给最初发起调用的人。 */
  const handleCapabilityResult = (
    session: Session,
    id: string,
    message: Extract<ClientMessage, { t: 'capability.result' }>,
  ) => {
    const waiting = session.waiting.get(id);
    if (!waiting) return;
    session.waiting.delete(id);
    if (message.ok) {
      waiting.resolve(message.value);
      return;
    }
    // 对方报了码就照传。丢掉码的话，提供方的「没这个文件」到壳那里会变成
    // 「内部错误」，界面上就只能给一句没法排查的话（ADR-016）。
    //
    // `details` 一起带走：冲突时对方现在到第几版全靠它。丢了它，界面上那句
    // 「被改过了」就没有版本号，用户无从判断自己那份还值不值得留。
    waiting.reject(
      new ClientError(
        message.code ?? 'INTERNAL',
        message.message || '目标客户端处理失败',
        message.details,
      ),
    );
  };

  const handleMessage = (session: Session, message: ClientMessage) => {
    switch (message.t) {
      case 'ping':
        session.connection.send({ t: 'pong' });
        return;
      case 'call':
        void handleCall(session, message.id, message.cmd, message.args);
        return;
      case 'capability.call':
        handleCapabilityCall(
          session,
          message.id,
          message.target,
          message.capability,
          message.args,
        );
        return;
      case 'capability.result':
        handleCapabilityResult(session, message.id, message);
        return;
      case 'clients.list':
        session.connection.send({
          t: 'result',
          id: message.id,
          ok: true,
          value: { installed: [...installed], connected: roster() },
        });
        return;
      case 'clients.launch':
        void handleLaunch(message.id, message.provider);
        return;
      case 'page.read':
        void handlePageRead(
          session,
          message.id,
          message.provider,
          message.path,
        );
        return;
      default:
        return;
    }
  };

  /**
   * Every frame passes the parser before it gets here, so a malformed or
   * version-mismatched client is refused outright instead of half-handled.
   */
  const connect = (connection: Connection, hello: ClientMessage) => {
    if (hello.t !== 'hello') {
      connection.send({ t: 'rejected', message: '第一帧必须是 hello' });
      connection.close();
      return null;
    }
    if (hello.v !== WIRE_VERSION) {
      connection.send({
        t: 'rejected',
        message: `协议版本不兼容：客户端 ${hello.v}，核心 ${WIRE_VERSION}`,
      });
      connection.close();
      return null;
    }
    const session: Session = {
      info: {
        id: crypto.randomUUID(),
        role: hello.client.role,
        provider: hello.client.provider,
        label: hello.client.label,
        capabilities: hello.client.capabilities,
        ...(hello.client.view ? { view: hello.client.view } : {}),
      },
      connection,
      connectedAt: new Date().toISOString(),
      waiting: new Map(),
    };
    sessions.set(session.info.id, session);
    // 连上来不等于"已安装"：安装清单只由宿主和 markInstalled 决定。
    connection.send({
      t: 'welcome',
      v: WIRE_VERSION,
      clientId: session.info.id,
      coreVersion: options.version,
    });
    pushState();
    pushRoster();
    return session;
  };

  /** A departing participant must not leave others waiting on its answers. */
  const disconnect = (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    session.waiting.forEach((entry) =>
      entry.reject(`${session.info.provider} 已断开`),
    );
    sessions.delete(id);
    pushRoster();
  };

  const unsubscribe = runtime.subscribe(() => pushState());

  return {
    connect,
    disconnect,
    handleMessage,
    unsubscribe,
    roster,
    invoke,
    installed: () => [...installed],
    markInstalled,
    unmarkInstalled,
    snapshot: () => ({ revision, snapshot: runtime.getSnapshot() }),
  };
}

export type Core = ReturnType<typeof createCore>;
