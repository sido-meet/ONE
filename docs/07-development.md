# 开发环境与日常工作

## 本机检查记录 · 2026-10-06

| 项目                   | 检查结果                                                                 |
| ---------------------- | ------------------------------------------------------------------------ |
| 系统/目录              | Windows，E:\Projects\ONE                                                 |
| Node.js                | 22.23.1                                                                  |
| npm / pnpm             | 10.9.8 / 11.18.0                                                         |
| Git                    | 2.48.1.windows.1                                                         |
| Rust / Cargo           | 1.99.0 / 1.99.0（rustup，host x86_64-pc-windows-msvc）                   |
| WebView2               | 注册表发现 Runtime 154.0.4258.53                                         |
| Visual C++ Build Tools | Build Tools 2022 17.14.41，含 MSVC 14.44.35207 与 Windows SDK 10.0.26100 |

安装记录：`rustup-init.exe -y --default-toolchain stable`（官方入口 win.rustup.rs）；`winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`。安装器提示需重启以完成安装；实测未重启即可编译，重启后建议再跑一次 `pnpm env:check`。

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

desktop:build 当前只构建可执行程序，不生成安装包。Tauri 标识 `dev.one.local` 为开发占位，bundle.active 为 false，尚无发布图标和签名。`src-tauri/Cargo.lock` 已在首次成功 native 构建后生成并提交，native 依赖版本已锁定。

应用图标是脚本生成的占位标记（`src-tauri/icons/source.png` 为 1024×1024 源图，`pnpm exec tauri icon src-tauri/icons/source.png` 生成其余尺寸），不是品牌资产，发布前需替换并记录作者与授权。

壳按客户端种类动态建窗：`pet`（128×128 透明置顶）、`bubble`（380×168 无边框透明置顶，初始隐藏）、`main`（1200×820，仅桌面端客户端）。`tauri.conf.json` 的 `app.windows` 为空数组，窗口在 `setup` 里按客户端种类创建，两种客户端加载同一份前端。窗口动作只能通过 `invoke` 调用壳命令，能力文件只开放事件收发。

启动本体需要 `ONE_REPO_ROOT`（或从编译期的 `CARGO_MANIFEST_DIR` 向上找到 `core/src/index.ts`），本体用系统里的 `node` 跑源码。0.1 用 `ONE_INSTALLED` 环境变量代替安装器，默认 `pet`。客户端种类有两种传法：已构建的 exe 用 `--client=pet`，`tauri dev` 用 `ONE_CLIENT=pet`（Tauri CLI 会把 `--client=` 错位传给 cargo）。

```powershell
pnpm core            # 只启动 ONE 本体
pnpm core:cli list   # 用命令行客户端看本体持有的状态与名册
pnpm pet:dev         # 宠物客户端（tauri dev）
pnpm desktop:dev     # 桌面端客户端（tauri dev）
pnpm desktop:build   # 原生可执行程序（release），会重新嵌入前端资源
pnpm client:pet      # 跑已构建的宠物客户端
Set-Location src-tauri; cargo test   # 窗口定位、菜单接线、帧边界等 Rust 单测
```

**发布版必须用 `pnpm desktop:build`。** `cargo build --release` 不会重新嵌入前端资源，会得到一个打开就是"无法访问此页面"的程序。`scripts/client.mjs` 会先确保本体在运行、再拉起客户端。

## 改管道代码前必读

壳与本体之间是 Windows 命名管道。写入句柄由 `File::try_clone()` 得到，而 Windows 上 `try_clone` 走 `DuplicateHandle`：两个句柄指向同一个文件对象，同步 I/O 在文件对象上串行化。**只要读取线程停在 `ReadFile` 里等数据，写端就永远发不出去** —— 而本体在收到第一帧之前不会主动说话，所以握手会静默卡死，症状是"名册里没有这个客户端，但管道明明连上了"。现在的读端用 `PeekNamedPipe` 轮询，没有数据就让出文件对象（`src-tauri/src/core_link.rs`）。改这块之前先读那里的注释。

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
| cargo test      | 壳层 Rust 单测（窗口定位算法）      |

## 开发习惯

- 推荐编辑器装 Svelte 与 Rust 支持；不强依赖具体 IDE。
- Git 默认 main 分支，功能分支建议 feature/任务简名。远程仓库 origin 为 `git@github.com:sido-meet/ONE.git`，推送会触发前端 CI（仅前端检查，不含 native 构建）。是否提交与推送由开发者决定，不做自动推送。
- 提交说明描述用户可见变化；PR 写问题、行为变化、验证和限制。
- 新增目录只在有实现时创建，不预造几十个空包。
- .env 不提交；.env.example 只放字段说明。VITE_ 变量会进入前端，不能存模型密钥。
- 浏览器演示数据刷新即丢；不要拿它保存真实资料。
- 远程 CI 有两条：前端 `verify`，native 壳在 Windows runner 上跑 `cargo test` 与 `cargo check`。推送不等于本地验收通过。

## 常见故障

依赖装不上：确认 Node 版本、registry 和网络；不要通过关闭全部安全校验解决。页面空白：先 pnpm check 和 pnpm build，再检查浏览器错误。Tauri 无法运行：先 pnpm env:check，再核实 MSVC/SDK，最后看 native 构建错误。端口冲突：统一 devUrl 与 Vite 端口。数据消失：当前内存模拟的预期行为，0.2 才持久化。
