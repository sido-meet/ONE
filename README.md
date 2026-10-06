# ONE

**一个对话，任意 Agent，持续拥有自己的数据。**

ONE 是以对话为中心的个人 Agent 桌面环境：宠物作为入口，聊天作为主线，日历、笔记与其他能力围绕对话展开。

当前处于 **0.1 交互原型的第一轮**：**ONE 本体（core）已经是独立进程**，宠物与桌面端是对等的可插拔客户端，默认安装宠物、桌面端可选。宠物端交互已经实机跑通：接入本体、单击呼出对话条、发消息、拖拽、右键菜单。桌面端本轮退回精简版，只保证能接上本体、状态诚实。回复仍来自内存模拟运行时，**没有连接任何模型或真实 Agent，也没有发布过任何版本。**

## 先看哪里

| 你想做什么                     | 打开                                         |
| ------------------------------ | -------------------------------------------- |
| 第一次接手，知道先做什么       | [从这里开始](docs/00-start-here.md)          |
| 确认产品做什么、暂缓什么       | [产品需求](docs/01-product.md)               |
| 设计页面、宠物、交互和异常状态 | [交互与视觉设计](docs/02-experience.md)      |
| 理解模块、进程和技术选型       | [系统架构](docs/03-architecture.md)          |
| 定义对象、接口、事件和存储     | [数据与接口契约](docs/04-contracts.md)       |
| 规划 Agent、MCP 和插件         | [接入与权限](docs/05-integrations.md)        |
| 按顺序领任务开发               | [路线与任务清单](docs/06-roadmap.md)         |
| 安装环境和启动项目             | [开发手册](docs/07-development.md)           |
| 判断功能是否做完               | [测试与发布](docs/08-quality.md)             |
| 理解为什么这么选               | [架构决策](docs/09-decisions.md)             |
| 查看依据、假设和待验证项       | [来源与待决策](docs/10-sources-and-risks.md) |
| 核对本次准备的完成情况         | [初始化交付记录](docs/11-initialization.md)  |

## 启动

需要 Node.js 22.12+（22 系列）或 24+，项目固定使用 pnpm 11.18.0。

```powershell
cd E:\Projects\ONE
pnpm install --frozen-lockfile
pnpm dev
```

打开终端显示的本地地址，默认 `http://127.0.0.1:1420`。

```powershell
pnpm verify         # 类型、行为测试、构建、格式
pnpm env:check      # 环境检查
pnpm core           # 只启动 ONE 本体
pnpm core:cli list  # 命令行客户端：看本体持有的状态与客户端名册
pnpm pet:dev        # 宠物客户端（开发态）
pnpm desktop:dev    # 桌面端客户端（开发态）
pnpm desktop:build  # 原生可执行程序（会重新嵌入前端资源，不生成安装包）
```

浏览器打开 `http://127.0.0.1:1420?client=pet` 时没有 Tauri 壳，界面仍然完整：这时 ONE 本体跑在同一个 JS 进程里，不是假数据模式。

## 现在可以体验

宠物端（`pnpm pet:dev` 或 `pnpm client:pet`）：

- 桌面上是 128×128 的透明置顶宠物。本体没连上时会画成虚线圆并写明原因，不假装正常。
- 单击宠物呼出对话条：上方一朵状态云（正在思考 / 60 字截断的回答），下方一条输入条。
- 对话条里发消息能看到状态云变化；Esc 或 ✕ 收起。模拟回复会明说是模拟回复。
- 底部握把拖动移动宠物，Shift + 方向键微调；位置不会被拖到屏幕外。
- 右键宠物：打开 ONE 桌面端 / 重新启动 ONE 本体 / 退出。桌面端和宠物互相请对方做事都经本体转发，不由谁直接拉起谁。

命令行客户端（`pnpm core:cli`）可以看本体持有的状态、谁连上了，也可以直接调用宠物的能力，例如 `pnpm core:cli call pet.bubble.open`。

所有数据仅在内存中；退出清空，不连接外部服务。Claude Code、MCode 是交互占位，不代表已经接入。日历与笔记已有契约和行为测试，但还没有界面（P04/P05）。DPI、多显示器、中文输入法与拖拽手感尚未人工验收。

## 目录

```text
core/src/                ONE 本体：命名管道服务端、权威状态、客户端名册、能力转发
packages/contracts/src/  OneClient、领域契约、输入校验、错误码、线上协议 wire.ts
packages/mock-runtime/src/  模拟实现与行为测试
src/                     Svelte 界面与依赖装配入口
src/windows/             PetWindow / BubbleWindow / MainWindow
src/lib/                 装配点、本体连接、壳边界与代理端
src-tauri/               Rust/Tauri 桌面壳（窗口、菜单、定位、管道桥接）
docs/                    开发依据和任务清单
scripts/                 环境检查、客户端启动器、截图辅助
.github/workflows/       前端与 native 持续检查
```

当前采用一个包管理入口，packages 先用于模块边界，尚不是独立发布的 workspace 包。真实 Runtime、插件 SDK 和数据库按里程碑创建。

远程仓库为 `git@github.com:sido-meet/ONE.git`，推送触发前端检查。项目尚未选择对外开源许可证，也未配置发布服务。发布前处理名称、包标识、图标、许可证与签名。
