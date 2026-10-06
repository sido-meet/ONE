# 开发环境与日常工作

## 本机检查记录 · 2026-10-06

| 项目                   | 检查结果                                      |
| ---------------------- | --------------------------------------------- |
| 系统/目录              | Windows，E:\Projects\ONE                      |
| Node.js                | 22.23.1                                       |
| npm / pnpm             | 10.9.8 / 11.18.0                              |
| Git                    | 2.48.1.windows.1                              |
| Rust / Cargo           | PATH 和默认 cargo/bin 下未找到                |
| WebView2               | 注册表发现 Runtime 154.0.4258.53              |
| Visual C++ Build Tools | Tauri CLI 未检测到包含 MSVC 和 SDK 的有效安装 |

## 浏览器原型

```powershell
cd E:\Projects\ONE
pnpm install --frozen-lockfile
pnpm dev
```

访问 `http://127.0.0.1:1420`。Vite 仅监听本机，固定端口避免 Tauri devUrl 不匹配。端口占用时先确认已有进程，不随意结束其他服务；也可临时换端口做浏览器预览，但桌面 devUrl 要同步调整。

Node 版本需符合 package.json。依赖精确版本固定在 package.json，传递依赖在 pnpm-lock.yaml。TypeScript 固定 5.9.3 是为了满足当前 svelte-check 的兼容范围，而非追求 registry 最高版本。

若未安装 pnpm，可用 `npm install --global pnpm@11.18.0`。升级依赖时在单独变更中运行全部检查，不混用 npm/yarn 生成其他锁文件。

## Windows 桌面环境

按 [Tauri 官方前置要求](https://tauri.app/start/prerequisites/) 安装：

1. Visual Studio Build Tools：选择“使用 C++ 的桌面开发”，包含 MSVC 和 Windows SDK。
2. Rust：从 [rustup 官方安装入口](https://rustup.rs/) 安装 stable MSVC 工具链；安装后重开终端。
3. WebView2 Runtime：本机已检测到；新机器需再次检查。

验证 `rustc --version`、`cargo --version`，然后：

```powershell
pnpm desktop:dev
pnpm desktop:build
```

desktop:build 当前只构建可执行程序，不生成安装包。Tauri 标识 `dev.one.local` 为开发占位，bundle.active 为 false，尚无发布图标和签名。首次成功 native 构建后提交 src-tauri/Cargo.lock；当前没有 Rust 锁文件，native 依赖尚未锁定和实机验证。

最小壳只创建 main 窗口，不包含宠物/托盘/热键插件。不要因为有配置就判定相关桌面功能完成。

## 常用命令

| 命令            | 用途                                |
| --------------- | ----------------------------------- |
| pnpm env:check  | 检查 Node/Git/Rust/Cargo 是否可访问 |
| pnpm check      | Svelte 与 TS 类型/可访问性诊断      |
| pnpm test       | 运行行为测试                        |
| pnpm test:watch | 开发时按需监听测试                  |
| pnpm build      | 生成 dist 前端产物                  |
| pnpm preview    | 本地查看生产产物                    |
| pnpm format     | 统一格式                            |
| pnpm verify     | 类型、测试、构建、格式完整检查      |

## 开发习惯

- 推荐编辑器装 Svelte 与 Rust 支持；不强依赖具体 IDE。
- Git 默认 main 分支，功能分支建议 feature/任务简名。远程仓库 origin 为 `git@github.com:sido-meet/ONE.git`，推送会触发前端 CI（仅前端检查，不含 native 构建）。是否提交与推送由开发者决定，不做自动推送。
- 提交说明描述用户可见变化；PR 写问题、行为变化、验证和限制。
- 新增目录只在有实现时创建，不预造几十个空包。
- .env 不提交；.env.example 只放字段说明。VITE_ 变量会进入前端，不能存模型密钥。
- 浏览器演示数据刷新即丢；不要拿它保存真实资料。
- 远程 CI 配置已准备，仅检查前端，推到远程后才会实际运行；native 构建工作流在 S01 之后补充。

## 常见故障

依赖装不上：确认 Node 版本、registry 和网络；不要通过关闭全部安全校验解决。页面空白：先 pnpm check 和 pnpm build，再检查浏览器错误。Tauri 无法运行：先 pnpm env:check，再核实 MSVC/SDK，最后看 native 构建错误。端口冲突：统一 devUrl 与 Vite 端口。数据消失：当前内存模拟的预期行为，0.2 才持久化。
