# 数据模型与接口契约

## 命名与范围

统一用 Conversation 表示用户的一条对话；Session 只在泛称或外部 externalSessionId 中使用。Workspace 是环境与数据归属，Run 是某个 Agent 的一次执行，AgentBinding 是对话与外部 Agent 会话的映射。

聊天类型位于 `packages/contracts/src/index.ts`，错误码在 `errors.ts`，日历与笔记契约及其运行时校验在 `domain.ts`。下列 Artifact、ToolCall、权限和存储定义仍是下一阶段的设计，不代表已有 API。

```mermaid
erDiagram
  Workspace ||--o{ Conversation : contains
  Conversation ||--o{ Run : executes
  Conversation ||--o{ AgentBinding : maps
  Conversation ||--o{ DurableEvent : records
  Workspace ||--o{ Note : owns
  Workspace ||--o{ CalendarEvent : owns
  Run ||--o{ ToolCall : invokes
  Run ||--o{ Artifact : produces
```

## 核心对象

| 对象                        | 必要字段                                                                           | 约束                                       |
| --------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------ |
| Workspace                   | id, name, rootUri?                                                                 | 个人空间可以没有文件目录；文件访问另需授权 |
| Conversation                | id, workspaceId, title, agentId, createdAt                                         | 不随 Agent 切换而改变 id                   |
| Run                         | id, conversationId, agentId, status                                                | agentId 在运行期间不可变                   |
| AgentBinding                | id, conversationId, agentId, externalSessionId?, lastProjectedSeq                  | provider/session 版本与有效性探测后续增加  |
| DurableEvent                | id, schemaVersion, conversationId, seq, createdAt, type, payload                   | seq 在对话内唯一递增，类型可判别           |
| Note（已实现类型）          | id, workspaceId, title, body, version, sourceConversationId?, createdAt, updatedAt | 乐观锁冲突不覆盖                           |
| CalendarEvent（已实现类型） | id, workspaceId, title, startsAt, endsAt, timeZone, version, sourceConversationId? | endsAt > startsAt；时区用 IANA 名称        |
| Artifact（计划）            | id, runId, uri, mimeType, digest, createdAt                                        | 内容存在受控文件目录，引用校验与权限检查   |
| ToolCall（计划）            | id, runId, name, args, idempotencyKey, status, result?                             | 敏感参数脱敏；实际效果必须可审计           |

消息和 Agent 切换目前位于事件的判别联合中，并非通用 `payload: any`。日期以带偏移的 RFC3339/ISO 时间存储；显示按用户时区转换。全天日程以后用单独的日期字段，避免强行按午夜 UTC 表示。

## 已实现：会话运行时（ConversationRuntime）

会话、Agent、Run 全在这一层，与领域能力无关。原 `OneClient` 同时挂着日历与笔记命令，换一个日历实现就等于把会话状态机一起换掉，因此已按 ADR-016 拆开。

| 方法               | 输入 / 输出                    | 语义                                   |
| ------------------ | ------------------------------ | -------------------------------------- |
| getSnapshot        | → Snapshot                     | 同步返回副本，调用方修改不影响内部状态 |
| subscribe          | callback → unsubscribe         | 订阅快照变化，第一次由调用方读取       |
| createConversation | title? → Conversation          | 个人空间创建，默认 Chat Agent          |
| changeAgent        | conversationId, agentId → void | 运行中 BUSY，同 Agent 为无操作         |
| sendMessage        | conversationId, text → Run     | 先提交用户消息与启动事件，再模拟回复   |
| cancelRun          | runId → void                   | 已结束则无操作；未知 Run 为 NOT_FOUND  |
| dispose            | → void                         | 释放计时器与订阅，调用方不再使用该实例 |

`Snapshot` **不再含** `notes` / `calendarEvents`：领域数据归提供方，挂在会话快照里意味着每次广播都捎带一次全量日历。

## 已实现：领域端口（CalendarProvider / NotesProvider）

`packages/contracts/src/provider.ts`。本体是唯一调用方；宠物、桌面端、命令行经本体的 `domains` 转发调用（见 `src/lib/core-link.ts`）。

端口签名的输入是**已解析类型**（`CalendarCreateInput`、`NormalizedCalendarListInput` 等），不再是 `unknown`。校验只在本体边界发生一次，由 `domain.ts` 的 `parseXxx` 完成；提供方收到的一定是可信输入，它自己不再校验。这样「谁负责校验」收敛到唯一一处，换实现时不会漏也不会重复。未在白名单内的命令在本体侧直接拒绝。

四类不可用必须彼此可分，`resolveProvider` 统一翻译（ADR-016）：

| 情况         | code                | details.providerProblem.reason                            |
| ------------ | ------------------- | --------------------------------------------------------- |
| 根本没安装   | `UNAVAILABLE`       | `not-installed`（附带怎么装的引导）                       |
| 装了但没运行 | `UNAVAILABLE`       | `not-running`（说的是连接不上，不是功能不存在）           |
| 装了但没授权 | `PERMISSION_DENIED` | `not-authorized`，`missing` 列出缺哪几项权限              |
| 版本对不上   | `CONFLICT`          | `version-conflict`，带 `providerVersion` 与 `coreVersion` |

`reason` 是结构化的，文案会改它不会；界面靠它分流，不靠解析中文字符串。命令派发顺序是**先解析提供方、再校验输入**：提供方不可用时校验参数没有意义，报 VALIDATION 反而误导。

`ClientError` 的 code：VALIDATION、NOT_FOUND、BUSY、DISPOSED、CONFLICT、UNAVAILABLE、PERMISSION_DENIED、TIMEOUT、INTERNAL。RATE_LIMITED 仍待真实适配层能抛出时再加。

**接口演进约束**：当前 getSnapshot 同步是 UI 本地缓存接口。未来 IPC Client 要先异步握手加载缓存，再进入 ready；网络请求不得伪装成同步读取。扩展 `connect()/connectionState` 时一起更新 Mock 和契约测试，不承诺完全无需改 UI。

## 已实现：插件页面契约（ADR-018）

`packages/contracts/src/page.ts`。协议标记 `one.plugin.v1`，页面与宿主之间只有 `postMessage` 一条路。

| 消息         | 字段                                  | 谁发        | 说明                                                 |
| ------------ | ------------------------------------- | ----------- | ---------------------------------------------------- |
| PageRequest  | `protocol, id, capability, args`      | 页面 → 宿主 | `capability` 是能力名（`calendar.list`），不是命令名 |
| PageResponse | `protocol, id, ok, value? / message?` | 宿主 → 页面 | 失败必须给 `message`，不许用空结果冒充成功           |

三条不能省的约束：

- **能力名 → 命令名由宿主翻译**（`PAGE_DOMAIN_COMMANDS`）。`calendar.remove` 对应的本体命令是 `calendarDelete`，靠改写字符串得到的是另一个不存在的命令；而且翻译之后输入会**再过一次本体边界的校验**（ADR-016），直接按能力名转发会绕过那一次。
- **页面没有身份字段。** 上下文 `workspaceId` / `source` 由宿主补，页面报了也不作数。宿主靠**窗口绑定**知道这个窗口属于哪个提供方（ADR-018 第 3 条）。
- **页面路径受守卫**（`isPagePath`）：相对、无 `..`、无反斜杠，入口非法就当没申报 —— 宿主会把它拼进 `one-plugin://` 地址，坏路径必须在协议解析那一层挡住。

协议本身随 wire v3 走：参与者在 `hello.client.view` 里申报入口，宿主用 `page.read` 向本体要资源。**为什么升版本而不是加个可选字段**：v2 的本体会静默丢掉这个字段，于是页面永远打不开而没有任何一方报错 —— 那正是版本守卫要挡住的情况。

## 已实现：摘要条契约（ADR-019）

摘要条**不新增任何协议**。它只用三样已存在的东西，这是有意的 —— 四态与在场判断本来就该由本体和名册表达，界面自己发明一套只会多一处能说谎的地方。

| 用到的                           | 从哪来                                         | 摘要条拿它做什么               |
| -------------------------------- | ---------------------------------------------- | ------------------------------ |
| `call` 命令帧                    | `calendarList` / `notesList`（已有白名单命令） | 经本体取数，不自己连提供方     |
| `details.providerProblem.reason` | 领域调用失败时的结构化原因（已有）             | 四态分流，不解析中文字符串     |
| `roster.connected[].view`        | 名册里自带页面的申报（v3 已有）                | 判定「打开××页面」按钮能不能点 |
| `state.revision`                 | 本体每帧状态带的版本号（已有）                 | 摘要底下写「本体状态 #7」      |

`CoreClient.revision()` 是新增的**读取口**（没收到过状态帧时是 `-1`，不是 `0`）。`client_identity.summaryExpanded` 也是新增的**询问**：展开与否由窗口高度决定，高度只有壳知道，界面不自己记一份。

**摘要条是只读窗口但会发命令**：`windowRole: 'view'`，不握手、走 `core_replay` 拿状态与名册，取数仍走正常的 `call` 帧。`core_replay` 只重放 `welcome` / `state` / `roster` 三帧，命令回执绝不重放。

**工作区键与插件页面共用**（`summaryCommandContext` 与 `pageCommandContext` 都退回 `personal`）：同一个键，否则同一条日程会在命令行、插件页面、摘要条三处各存一份。

## 下一步领域命令草案

统一命令信封：`{ requestId, workspaceId, source: 'ui' | 'agent', runId?, expectedVersion?, input }`。修改命令接受 idempotencyKey；命令来源在可信边界标记，不相信客户端自报权限。

| 命令            | 核心输入                                           | 输出 / 校验                       |
| --------------- | -------------------------------------------------- | --------------------------------- |
| calendar.list   | rangeStart, rangeEnd, timeZone                     | 范围内条目，分页游标              |
| calendar.create | title, startsAt, endsAt, timeZone, idempotencyKey  | CalendarEvent；时间有效、时长为正 |
| calendar.update | id, expectedVersion, patch, idempotencyKey         | 新版本；冲突返回 CONFLICT         |
| calendar.delete | id, expectedVersion, idempotencyKey                | 删除结果与审计引用                |
| notes.list      | query?, cursor?, limit                             | 摘要列表，不默认加载全部正文      |
| notes.create    | title, body, sourceConversationId?, idempotencyKey | Note                              |
| notes.update    | id, expectedVersion, patch, idempotencyKey         | Note 新版本                       |
| notes.delete    | id, expectedVersion, idempotencyKey                | 删除结果                          |

P03 把此草案写成 TypeScript 类型和运行时校验 schema。TypeScript 只负责编译期，IPC/MCP 输入必须在入口做运行时校验。UI 与 MCP 都调用同一领域方法，时间校验和幂等规则不能复制两套。

已实现：输入 schema 拒绝未知字段、要求带偏移的 RFC3339 时间、校验 IANA 时区与正时长；幂等以 `(workspaceId, idempotencyKey)` 为键保存请求摘要与结果，同键同输入回放原结果、同键异输入报 CONFLICT。笔记列表只返回摘要，正文不默认加载。删除返回 `auditRef`，0.1 的审计条目仅存在内存中。

## 事件与 Run 状态

当前 durable：message.created、agent.changed、run.started、run.finished。当前 token 增量体现在 Snapshot.drafts；EphemeralEvent 类型预留，尚未提供独立事件订阅接口。

后续 durable：tool.requested、permission.resolved、tool.completed/failed、artifact.created、conversation.summarized。后续 ephemeral：message.delta、progress、typing、stdout.delta（有缓冲上限）。不收集隐藏 chain-of-thought。

目标 Run：queued → running ↔ awaiting_permission → completed / cancelled / failed / interrupted。当前 Mock 只用 running/completed/cancelled；failed 类型保留待故障模拟。终态不能回到 running；重试创建新 Run，并用 retryOf 关联旧 Run。

## 持久化计划（0.2）

SQLite 表：workspaces、conversations、runs、agent_bindings、conversation_events、notes、calendar_events、artifacts、command_receipts、schema_migrations。

- conversation_events 唯一索引 `(conversation_id, seq)`；外键开启；同事务写投影与事件。
- command_receipts 唯一 `(workspace_id, idempotency_key)`，保存请求摘要与结果；同键不同请求拒绝。
- 笔记和日程用 version 做并发控制；runs 加 status 与更新时间索引。
- 不在大历史中重复存二进制文件；附件放应用数据目录，用摘要关联。
- 数据位置由平台 appDataDir 获取，不写代码仓库；迁移前备份、失败回滚。
- v1 导出 JSON 带 schemaVersion 和相对附件路径；导入校验大小、路径穿越和未知字段。
- 自动摘要不覆盖原消息；记录生成范围与来源 seq。用户可纠正摘要。

这里是数据设计，尚未创建数据库或迁移脚本，R01 开发时需要从实际查询和恢复用例形成可执行 schema。
