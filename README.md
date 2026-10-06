# ONE

**一个对话，任意 Agent，持续拥有自己的数据。**

ONE 是以对话为中心的个人 Agent 桌面环境：宠物作为入口，聊天作为主线，日历、笔记与其他能力围绕对话展开。

当前处于 **0.1 交互原型的第一轮**：桌面三窗口（主窗口 / 宠物 / 小聊天框）、跨窗口权威状态代理、日历与笔记领域契约已经就位。Claude Code、MCode 仍是模拟身份，日历笔记只有契约没有界面，全部数据仅在内存中。**不是完整的 0.1 产品，也没有发布过任何版本。**

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
pnpm desktop:dev    # 桌面开发态：主窗口 + 宠物 + 小聊天框
pnpm desktop:build  # 原生可执行程序（不生成安装包）
```

浏览器打开 `http://127.0.0.1:1420` 时没有 Tauri 环境，只会显示主窗口并在本进程内运行模拟会话。

## 现在可以体验

桌面模式（`pnpm desktop:dev`）：

- 主窗口创建对话、发送消息、看逐步出现的模拟回复、停止、切换 Agent。
- 桌面上出现 128×128 的几何宠物：单击打开小聊天框，右键弹出菜单（打开 ONE / 打开小聊天框 / 隐藏宠物 / 退出），底部拖拽条移动它。
- 在小聊天框里发送消息，展开主窗口看到的是同一个对话、同一段历史、同一个 Run。
- 主窗口侧栏可隐藏/恢复宠物、打开小聊天框；Esc 关闭小聊天框。

只跑 `pnpm dev` 时可以体验主窗口的对话流程。

所有数据仅在内存中；刷新或退出清空，不连接外部服务。Claude Code、MCode 是交互占位，不代表已经接入。日历与笔记已有契约和行为测试，但还没有界面（P04/P05）。DPI、多显示器与拖拽手感尚未实机验收。

## 目录

```text
src/                       Svelte 界面与依赖装配入口
src/windows/               MainWindow / BubbleWindow / PetWindow
src/lib/                   装配点、窗口协议、权威状态代理与代理端
packages/contracts/src/    OneClient、领域契约、输入校验、错误码
packages/mock-runtime/src/  模拟实现与行为测试
src-tauri/                 Rust/Tauri 桌面壳（窗口、菜单、定位算法）
docs/                      开发依据和任务清单
scripts/                   环境检查
.github/workflows/         前端与 native 持续检查
```

当前采用一个包管理入口，packages 先用于模块边界，尚不是独立发布的 workspace 包。真实 Runtime、插件 SDK 和数据库按里程碑创建。

远程仓库为 `git@github.com:sido-meet/ONE.git`，推送触发前端检查。项目尚未选择对外开源许可证，也未配置发布服务。发布前处理名称、包标识、图标、许可证与签名。
