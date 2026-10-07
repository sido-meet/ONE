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

启动本体有两种方式（ADR-021）：仓库里跑源码（开发用，系统 `node`），或用 `pnpm core:package` 产出的随包运行时（发布用，自带 `node.exe`，机器上没装 node 也能跑）。壳**优先找产物**，找不到才回退源码；两处都没有时它会停下来说清找过哪儿，而不是表现成「本体没接上」。

源码路径靠 `ONE_REPO_ROOT`（或从编译期的 `CARGO_MANIFEST_DIR` 向上找到 `core/src/index.ts`）定位。客户端种类有两种传法：已构建的 exe 用 `--client=pet`，`tauri dev` 用 `ONE_CLIENT=pet`（Tauri CLI 会把 `--client=` 错位传给 cargo）。`ONE_CORE_RUNTIME` 可以显式指定产物目录，联调时用得上。

## 双击就能用：不需要先开终端

`one-desktop.exe` 自己会拉起本体，**本体再把已安装的提供方与可视客户端拉起来**。因此正常使用不需要任何终端，也不需要设环境变量。

装一次提供方（只需一次，之后双击即可）：

```powershell
node core\src\index.ts install local.calendar local.notes   # 或 pnpm core:cli install …
```

清单落在用户数据目录：`%APPDATA%\ONE\data\installed.json`（Linux/macOS 是 `~/.local/share/ONE/data`），可用 `ONE_DATA_DIR` 改。查当前清单：`pnpm core:cli installed`。卸掉同理 `uninstall`。

**本体自己也可以当入口**，`ONE_LAUNCH_CLIENT=pet`（或 `desktop`）让它起来之后顺手把可视客户端带出来。客户端自己不会设这个变量，所以不会互相拉起、不会递归。已经在场的同类客户端不重复拉 —— 一个寻址键只能有一个参与者在跑（ADR-017）。

三件曾经把用户逼进终端的事，都已经不在了：

| 曾经                                    | 现在                                                                  |
| --------------------------------------- | --------------------------------------------------------------------- |
| 双击启动时没有环境变量 → 日历压根没装上 | 清单落盘，本体启动时读它并自动拉起提供方                              |
| 拉起提供方会闪一个黑色控制台窗口        | `spawn` 带 `windowsHide: true` —— Windows 上「后台」不只是 `detached` |
| 本体与提供方各按自己的位置算「根」      | 共用 `packages/hostpaths` 的 `dataDir()`，同一个应用只有一处数据      |

`ONE_INSTALLED` 仍在，但降级成**给验收脚本用的显式覆盖**（优先级：环境变量 > 清单文件 > 只装宠物）。

数据目录从仓库内的 `.one/data` 挪到了用户数据目录。旧的开发期验收数据留在 `.one/data-legacy`，没有迁移代码 —— 那是验收里的测试垃圾，不是用户数据。

```powershell
pnpm core            # 只启动 ONE 本体
pnpm core:cli list   # 用命令行客户端看本体持有的状态与名册
pnpm core:package    # 打出本体的可分发产物到 dist-runtime/（node.exe + core + 清单）
pnpm pet:dev         # 宠物客户端（tauri dev）
pnpm desktop:dev     # 桌面端客户端（tauri dev）
pnpm desktop:build   # 原生可执行程序（release），会重新嵌入前端资源
pnpm client:pet      # 跑已构建的宠物客户端
Set-Location src-tauri; cargo test   # 窗口定位、菜单接线、帧边界等 Rust 单测
```

**发布版必须用 `pnpm desktop:build`。** `cargo build --release` 不会重新嵌入前端资源，会得到一个打开就是"无法访问此页面"的程序。`scripts/client.mjs` 会先确保本体在运行、再拉起客户端。

## 无头验收 P04 的日程闭环

宠物窗口可能被别的东西盖住、无边框置顶窗口又常常拿不到键盘焦点，因此提议的确认与拒绝在命令行也做得到（ADR-022：只在界面上能点的按钮，等于给卡住的时候留了一条死路）。本体自身不依赖图形界面就能用，正是这条命令行存在的理由。

```powershell
# 1. 宠物端 + 真实提供方（本体走 dist-runtime 里的自带 node）
$env:ONE_INSTALLED = "pet,local.calendar,local.notes"
Start-Process src-tauri\target\release\one-desktop.exe -ArgumentList "--client=pet","--open-bubble"

# 2. 聊天里说一句话 → 本体起草一条待确认的日程
node .one/run-cli.mjs .one\out.json send welcome 明天下午三点安排面试
node .one/run-cli.mjs .one\out.json proposal list

# 3. 确认两次：第一次 applied:true，第二次 applied:false 且 entityId 相同，
#    日历里仍只有一条 —— 这就是「重复确认不重复创建」的真机证据
node .one/run-cli.mjs .one\out.json proposal confirm <id>
node .one/run-cli.mjs .one\out.json proposal confirm <id>
node .one/run-cli.mjs .one\out.json calendar list '{"rangeStart":"...","rangeEnd":"...","timeZone":"Asia/Shanghai"}'
```

对话条在露出卡片时换高（`resize_bubble` 三档：平时 168 / 结果卡 208 / 带按钮 262）。**改的是窗口高度而不是界面的一个类** —— 界面自己加 class 的话，被切掉的是输入框，看起来就像「ONE 不能打字了」；改完必须重新仲裁整组附属窗口（ADR-020）。

## 无头验收 P05 的笔记闭环

除了上面几条，笔记这一路还多一条 `conversation`：以前只能**发**不能**读**，窗口被盖住时「ONE 到底回了什么」只能靠猜 —— 而「差一句就说差哪一句」那两条提示正是被猜没的。

```powershell
node .one/run-cli.mjs .one\out.json send welcome 今天天气不错
node .one/run-cli.mjs .one\out.json send welcome 记一下
node .one/run-cli.mjs .one\out.json send welcome 下午三点安排面试
node .one/run-cli.mjs .one\out.json send welcome 记一下：客户要求下周给报价，口头说的没有邮件

# 读回来说过的话：闲聊走通用模拟回复，「记一下」与「下午三点安排面试」
# 各自说清差哪一句 —— 这三条用界面是验证不到的
node .one/run-cli.mjs .one\out.json conversation welcome

# 确认两次看幂等，再拒一条看「零写入 + 原因可见」
node .one/run-cli.mjs .one\out.json proposal confirm <id>
node .one/run-cli.mjs .one\out.json proposal confirm <id>
node .one/run-cli.mjs .one\out.json proposal reject <id> 随口说说，不用记
node .one/run-cli.mjs .one\out.json notes list '{"limit":10}'

# 笔记绝不串进日历：日历里应当一条不多
node .one/run-cli.mjs .one\out.json calendar list '{"rangeStart":"2026-09-01T00:00:00+08:00","rangeEnd":"2026-12-01T00:00:00+08:00","timeZone":"Asia/Shanghai"}'
```

**命令行也能把笔记编辑的整条路验完**（插件页面被盖住拿不到焦点时的死路，与提议同一理由）：

```powershell
# 列表只有摘要，正文要单独取 —— 页面点「编辑」走的就是这一步
node .one/run-cli.mjs .one\out.json notes list '{"limit":10}'
node .one/run-cli.mjs .one\out.json notes get '{"id":"<id>"}'

# 用过期版本改：应当被拒，且回执里带得上「对方现在第几版」
node .one/run-cli.mjs .one\out.json notes update '{"id":"<id>","expectedVersion":1,"patch":{"body":"x"},"idempotencyKey":"k1"}'
```

`notes get` 不是多余的：列表按契约剥掉正文，没有它就拿不到一条能编辑的笔记。它也是核对「冲突到底有没有被静默写进去」最快的办法 —— 撞完冲突后再 `get` 一次，看版本号和正文是不是还是别人写的那一版。

七条容易踩的：

- **`send` 之间要隔几秒。** 单对话同时只允许一个写入 Run，连着发会拿到 `BUSY` —— 那不是失败，是排队规则。
- **`calendar list` 的三个字段都是必填**（`rangeStart` / `rangeEnd` / `timeZone`），少一个就是一条 `VALIDATION` 报错。`timeZone` 要填 IANA 名（`Asia/Shanghai`），不是 `+08:00`。
- **读回来的是** `{"role":"user"|"assistant","content":"…"}` **的数组**，按时间顺序。`notes list` / `calendar list` 的返回包在 `value.items` 里。
- **插件页面里别写 `<form>`。** 沙箱 iframe 只有 `allow-scripts`，没有 `allow-forms`，浏览器会在触发 `submit` 事件之前就把提交挡掉：按钮点了没反应，控制台也不报错。提交走显式按钮 + 页面自己校验（ADR-018 第 5 条）。
- **截图里有 ≠ 工作过。** 「加入日程」「记下来」这两个按钮从第一天起就没提交成功过，两轮验收都只拍了界面就记成 ✅。凡是能落到数据里的操作，验完都要用命令行读回来对账（`calendar list` / `notes get`），对不上就是没跑通。
- **界面上正常 ≠ 点了有反应。** 这一轮挖出的四处「点了没反应」在截图里全都看着正常：桌面端菜单栏那四个字画在那儿，合成点击、按住不放、键盘 Alt + 方向键，三种办法都开不出下拉；本体名册里多出来的提供者更是一行错误都没有 —— 日历读得出来，只是改了不动。验收清单要列的是**逐个按钮点过去**，不是逐屏截图。
- **窗口菜单栏的顶层必须是 `Submenu`。** muda 只给子菜单插 `MF_POPUP`，普通 `MenuItem` 插的是 `MF_STRING`；菜单栏上的项不是弹窗就点不动。弹出菜单（宠物右键）反过来用普通项才对 —— 同一份 `Menu` 用在哪，决定了它该由什么组成。

**`.one/` 里的验收脚本已被 gitignore。** `run-cli.mjs` 只是把 `core/src/cli.ts` 用管道驱动一遍（PowerShell 自己发命名管道帧很别扭），逻辑都在本体里。

**点菜单的脚本有两个，别混用。** 宠物右键菜单是**弹出**菜单，`real-tap.ps1` 直接点就行；桌面端那圈是**菜单栏**，Win32 的跟踪菜单不响应「按下、松开」—— 那等于开了又关，界面上什么也没发生，而且菜单看起来完全正常。要用 `menubar-click.ps1`（按下顶层项 → 滑到第 N 项 → 松开选中）。`pet-tap.ps1` 会在点之前先确认目标点真的落在 `#32768` 弹窗上，确认不过就不点：宠物是 136×128，菜单第 3~5 项恰好落在它的客户区里，点歪了就是点中宠物本身，截图上还看不出差别。`<select>` 下拉（Agent 选择器）是独立弹窗，`PrintWindow` 拍不到，要用 `screen.ps1` 抓屏幕上那块矩形。

**`dist-runtime/` 里有 80MB 以上的 `node.exe`，已 gitignore，不要提交。** 重新打包前先关掉上一轮起着的宠物与本体：那份 `node.exe` 正被进程锁着，否则打包会失败（脚本会直接告诉你原因，不会甩一坨 EIO 栈）。要验证产物路径，把 `dist-runtime` 放到 exe 旁边即可 —— 壳启动时第一件事就是打一行日志，说明本体实际用的是哪份 node：

```
one: 本体运行时：…\dist-runtime\core/src/index.ts（…\dist-runtime\node.exe），工作目录 …\dist-runtime
```

## 调试插件页面

```powershell
$env:ONE_REPO_ROOT = "E:\Projects\ONE"
src-tauri\target\release\one-desktop.exe --client=pet --open-plugin=local.calendar
```

`--open-plugin=<provider>` 启动即开一个插件页面窗口，不必靠鼠标（实机验收靠它）。页面能不能加载出来全看壳的标准错误，三行依次出现就是通的：

```
one: 插件页面请求 one-plugin://localhost/local.calendar/index.html
one: 壳发起 shell-1
one: 本体已处理 shell-1：{"content":"<!doctype html>…"}
```

少了第一行，问题在 WebView 侧（地址前缀或 CSP）；少了第三行，问题在提供方那边。抓窗口内容用 `.one/capture-window.ps1`（`PrintWindow` 直接抓窗口客户区，屏幕上被游戏挡住也拍得到）。

## 调试摘要条

```powershell
$env:ONE_REPO_ROOT = "E:\Projects\ONE"
src-tauri\target\release\one-desktop.exe --client=pet --open-summary --expand-summary
```

`--open-summary` 启动即亮出摘要条，`--expand-summary` 直接展开（360×96 → 360×420）。

**为什么需要这两个参数**：桌面上有置顶程序时合成点击打不到宠物窗口，而无边框置顶窗口在 Windows 上还常常拿不到键盘焦点（Tab / Enter 同样进不去）。摘要条的收起/刷新按钮因此**无法用合成输入驱动**，验收只能走启动参数。`--expand-summary` 顺带证明高度那条路是通的（窗口真的变成 420 高），从而把「输入没送达」与「命令没实现」分开。

**一次只开一个 `one-desktop`。** 同一根管道只有一次握手，第二个实例成了孤儿，它发的命令永远没人应答，回的是 `INTERNAL` 的「目标客户端处理失败」—— 那句话会把「插件不在场」说成「本体坏了」。验收要串行。

摘要条是只读窗口（`windowRole: 'view'`），靠 `core_replay` 拿状态与名册，**但它仍然发命令**（`calendarList` / `notesList`），因此它能不能取到数完全取决于本体在不在。抓它用：

```powershell
pwsh -NoProfile -File .one\capture-window.ps1 -Out "E:\Projects\ONE\.one\summary.png"
pwsh -NoProfile -File .one\list-windows.ps1        # 列出窗口位置尺寸到文件
```

`.one` 下的验收脚本一律**写文件不打印**：PowerShell 捕获子进程输出会按 GBK 解释 UTF-8 字节，中文全变乱码，那不是程序的错。读文件用 read 工具。

## 调试附属窗口布局

```powershell
src-tauri\target\release\one-desktop.exe --client=pet --open-summary --expand-summary --open-bubble
```

三个参数一起用，**三块同时在场** —— 那是不互相遮挡唯一有意义的时刻（只开一个时它无处可撞）。看窗口落在哪：

```powershell
pwsh -NoProfile -File .one\list-windows.ps1        # 位置尺寸写文件
node .one\drag-pet.mjs .one\drag.txt 300 200      # 把宠物挪到 (300,200) 并看跟随结果
```

`drag-pet.mjs` 用系统 API 移动宠物窗口，触发的是**和鼠标拖动完全相同**的 `WindowEvent::Moved` 路径 —— 所以它验的是跟随本身，不受「置顶程序吃掉合成点击」影响。

**跟随坏掉时先看日志**：`one: 宠物移动了，重新摆附属窗口` 这行出现却没有后续，说明后台线程退出了 —— 曾经就是这个 bug（`if !settled { break }` 把「还没停」当成了「退出」）。

拖动跟随是 60ms 一查、140ms 静止判定，拖完约 0.2 秒落定。`drag-pet.mjs` 内部已经等了 900ms。

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
