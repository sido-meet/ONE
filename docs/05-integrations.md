# Agent、能力与权限设计

## 三种接口各自的用途

- OneClient：ONE 界面的业务接口。
- MCP：把日历、笔记等领域能力暴露给模型/Agent。协议定义 tools/resources/prompts，[官方架构](https://modelcontextprotocol.io/specification/2025-11-25/architecture)。
- Agent Connector：接入完整 Agent，优先探测 ACP，其次官方 SDK，再考虑文档化的进程协议。ACP 处理 Client/Agent 通信，[官方概述](https://agentclientprotocol.com/protocol/v1/overview)。

不假设任何 CLI 自动支持 ACP，不以抓取终端文字作为稳定生产接口。MCode 的具体仓库、产品和协议尚未明确，当前只作显示名称。接入前必须确定项目地址、版本、许可和能力。

## Connector 最小能力草案

`probe()` 返回 protocolVersion、supportsResume、supportsCancel、supportsToolApproval、supportsAttachments；`start(context, input)` 返回标准运行事件；`cancel(runId)` 返回取消确认；`dispose()` 释放子进程和订阅。只有 supportsResume 才允许恢复外部 session。

每个适配器单独维护外部 session ID、最后成功投影 seq 和协议版本。不能复用错误的工作目录或凭据。进程退出、超时、无效事件和版本不兼容转换成 ONE 错误。

## Agent 交接

1. 当前 Run 到终态；确定目标 Agent 与 Workspace。
2. 准备 ContextPacket：用户目标、允许分享的摘要、最近消息、关键工具结果、产物引用、工作目录、已授权范围。
3. 显示“将分享给新 Agent 的内容”，允许用户删除敏感内容或修正摘要。
4. 适配器建立/恢复外部会话，成功才更新 Binding 和 agent.changed。
5. 失败保留旧 Agent，错误可重试；lastProjectedSeq 只在接收成功后推进。

上下文按 token 预算裁剪，保留来源引用和摘要版本；外部工具返回的网页、文件和日志均当作数据，不赋予它们修改系统规则的权力。

## 权限模型

| 能力              | 初始策略                                 | 实施点                 |
| ----------------- | ---------------------------------------- | ---------------------- |
| 读本地笔记/日程   | 当前 Workspace 内，明确授权的 Agent 可读 | Domain + Host          |
| 新建日程/笔记     | 初期展示预览并由用户确认                 | Domain 命令执行前      |
| 修改/删除已有数据 | 展示目标和影响；可用时提供撤销           | 版本校验 + 审计        |
| 读写文件          | 显式授权的目录和动作；解析真实路径       | Native Host            |
| 启动进程          | 已配置可执行文件和受限参数               | Native Host            |
| 联网              | 真实服务需要时按连接配置开放             | 受控 Connector         |
| 密钥              | OS 凭据库或验证过的安全存储              | Native Host，UI 不读回 |

这张表是 ONE 产品安全设计，不是开发助手每一步都要向你请示的规则。

授权记录至少含主体、能力、目标范围、时效（一次/本次运行/记住）、决定、时间、关联 Run。第三方插件不能授予自己权限或替换 Permission Broker。拒绝操作应是明确终态，不自动换工具绕过。

真实工具通过 ONE Host 执行才可完整控制。外部 Agent 若自行访问系统，ONE 的 UI 确认无法约束它，必须验证外部 Agent 的沙箱/授权机制或给出限定支持范围。进程分离本身不是完整安全沙箱。

## 插件路线

0.1–0.4：仅静态装配官方模块。0.5：在真实替换需求下引入 manifest（id/version/apiVersion/entry/provides/requires/permissions），加载前校验依赖和版本，卸载时取消运行、撤销订阅和注册；不开放远程安装入口。

第三方市场需要签名、来源验证、升级策略、撤销权限、隔离与可审计安装流程；Wasm 只能约束宿主提供的能力，并不自动解决所有外部 Agent 安全问题。这些不作为 0.1 前置条件。
