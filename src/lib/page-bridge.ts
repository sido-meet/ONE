import { ClientError } from '../../packages/contracts/src/index.ts';
import type {
  CommandContext,
  ProviderId,
  Snapshot,
} from '../../packages/contracts/src/index.ts';
import {
  PAGE_DOMAIN_COMMANDS,
  PAGE_PROTOCOL,
  parsePageRequest,
} from '../../packages/contracts/src/page.ts';
import type { CoreClient } from './core-link';

/**
 * 宿主这一侧的插件页面桥（ADR-018）。
 *
 * 页面跑在不透明来源里，没有 Node、没有文件、没有网络，唯一能说话的地方就是
 * `postMessage`。这个模块就是那头的接线盒：把页面的能力请求换成本体命令送出去，
 * 再把回执原样送回去。
 *
 * 三处不能省的判断：
 *
 * - **只认自己那个 iframe**。不透明来源下 `event.origin` 是 `null`，靠来源区分
 *   谁是谁根本不成立，只能靠 iframe 自己的句柄。认错了窗口，A 插件就能替 B
 *   插件发请求。
 * - **能力名换成命令名**。页面说的是 `calendar.remove`，本体收的是 `calendarDelete`；
 *   而且换完之后输入会**再过一遍本体边界的校验**（ADR-016）。直接按能力名转发会
 *   绕过那一次校验。
 * - **命令上下文由宿主给**。页面不填 `workspaceId`、也不填 `source`：那是可信边界
 *   上的事，页面填了也不算数。
 */

export interface PluginPageBridge {
  dispose(): void;
}

/**
 * 桥只需要能收消息与退订。刻意不写成 `Window`：那样测试就得伪造整个 Window，
 * 于是测试替实现操心起来。这里要的结构刚好够用，`window` 本身也满足它。
 */
export interface MessageHost {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void;
}

/** 页面用能力名说话，宿主在这里翻译成本体命令；表之外的能力一律不存在。 */
function commandFor(capability: string): string | undefined {
  return (PAGE_DOMAIN_COMMANDS as Record<string, string | undefined>)[
    capability
  ];
}

/**
 * 页面命令的上下文。个人单机目前只有一个工作区，取快照里的第一个；快照还没到就
 * 退回 `personal` —— 与命令行用的是同一个键，否则同一条笔记在两处会各存一份。
 */
export function pageCommandContext(snapshot: Snapshot): CommandContext {
  return {
    requestId: `page-${crypto.randomUUID()}`,
    workspaceId: snapshot.workspaces[0]?.id ?? 'personal',
    source: 'ui',
  };
}

export function attachPluginPage(options: {
  link: CoreClient;
  /** 窗口绑定的寻址键。页面报什么都不作数。 */
  provider: ProviderId;
  frame: HTMLIFrameElement;
  /** 消息来源。默认就是本窗口；测试里换成假的，逻辑一字不改。 */
  host?: MessageHost;
}): PluginPageBridge {
  const { link, frame } = options;
  // window 的 addEventListener 是一组重载，TypeScript 挑不出「只收 message」
  // 那一支；这里的转换说的是重载形状，不是行为。
  const host: MessageHost = options.host ?? (window as unknown as MessageHost);

  const reply = (
    id: string,
    response: { ok: true; value: unknown } | { ok: false; message: string },
  ) => {
    // 不透明来源没有可写的 targetOrigin，只能用 '*'；地址仍然靠上面的句柄限定。
    frame.contentWindow?.postMessage(
      { protocol: PAGE_PROTOCOL, id, ...response },
      '*',
    );
  };

  const handle = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow) return;
    const request = parsePageRequest(event.data);
    if (!request) return;
    const command = commandFor(request.capability);
    if (!command) {
      reply(request.id, { ok: false, message: '这个页面不能调用这项能力' });
      return;
    }
    void link
      .callCommand(command, [pageCommandContext(link.snapshot()), request.args])
      .then(
        (value) => reply(request.id, { ok: true, value }),
        (cause: unknown) =>
          reply(request.id, {
            ok: false,
            message:
              cause instanceof ClientError || cause instanceof Error
                ? cause.message
                : '本体处理失败',
            // 错误码一起给。页面要靠它分「这条被别人改过了」与「日历源没连上」——
            // 这两件事要给的界面完全不同：前者得把用户打的字留在框里，后者只提示重试。
            ...(cause instanceof ClientError ? { code: cause.code } : {}),
            // 冲突时服务器当前是第几版：说「被别人改过了」而不说改成什么了，
            // 用户没法决定是放弃自己的还是再看看对方的。
            ...(typeof conflictVersion(cause) === 'number'
              ? { currentVersion: conflictVersion(cause) }
              : {}),
          }),
      );
  };

  /** 只认 CONFLICT 的 details.currentVersion，别的一律不给。 */
  const conflictVersion = (cause: unknown): number | undefined => {
    if (!(cause instanceof ClientError) || cause.code !== 'CONFLICT')
      return undefined;
    const value = cause.details?.['currentVersion'];
    return typeof value === 'number' ? value : undefined;
  };

  host.addEventListener('message', handle);
  return {
    dispose: () => host.removeEventListener('message', handle),
  };
}
