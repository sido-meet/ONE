use std::collections::HashMap;
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Pipes::PeekNamedPipe;
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_TERMINATE,
};

/// ONE 本体在 Windows 上是命名管道，不是端口。WebView 不能直接开套接字，
/// 因此这一层是 webview 与本体之间唯一可信的桥：客户端仍然拿不到套接字。
pub const PIPE_PATH: &str = r"\\.\pipe\one-core";
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
const RECONNECT_DELAY: Duration = Duration::from_millis(700);
/// 读端绝不能停在 ReadFile 里。写入句柄是 `try_clone()` 出来的，而 Windows 上的
/// try_clone 走 DuplicateHandle：两个句柄指向同一个文件对象，同步 I/O 在文件对象
/// 上是串行化的。只要读取线程挂在 ReadFile 等数据，写端的 write_all 就只能排队，
/// 而本体在收到第一帧之前不会主动说话（见 core/src/pipe.ts）—— 两边就此互等死锁。
/// 所以先问"还有多少字节可读"，没有就让出文件对象，写端才有机会把帧送出去。
const POLL_MIN: Duration = Duration::from_millis(2);
const POLL_MAX: Duration = Duration::from_millis(50);
/// 启动本体时不要给它分配控制台窗口，见 start_core。
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// 同一根管道要同时供本体、宠物和桌面端使用，所以路径不随客户端变化。
const CORE_ENTRY: &str = "core/src/index.ts";
/// 可分发产物的目录名与清单文件名。清单是壳的唯一依据：靠猜会猜错。
const RUNTIME_DIR: &str = "dist-runtime";
const RUNTIME_MANIFEST: &str = "core-runtime.json";
/// 结束本体后等它真的走掉的上限。管道要等进程彻底退出才释放，「重新启动」紧接着
/// 起新本体时抢的就是它；但也不能无限等 —— 退不出去时要有话说，而不是把应用卡死。
const CORE_STOP_GRACE: Duration = Duration::from_millis(3000);
const CORE_STOP_POLL: Duration = Duration::from_millis(20);

// ───────────────────────── 本体进程的生死 ─────────────────────────
//
// 壳拉起本体，本体是壳的子进程；于是**壳也就该是唯一决定它什么时候结束的一方**。
//
// 这条以前是缺的，而缺的时候看不出问题：壳退出后本体确实消失了。查下来那不是设计，
// 是巧合 —— 壳把 stderr 接成管道，壳一死管道就断，本体正好要往 stderr 写一行
// 「参与者断开」，于是撞上 EPIPE 崩掉。**它能不能退，取决于那一刻它恰好要不要说话。**
// 实机对照过：本体单独跑（stderr 不经壳转发）时客户端断开后它一直活着。
//
// 顺带修好一个点了没反应的按钮：「重新启动 ONE 本体」原来只是再 spawn 一个，
// 那个新的撞上 EADDRINUSE 立刻退出，界面上什么也不变。

/// 壳自己拉起来的那个本体的 pid。只记 pid 不记 `Child`：等待线程要独占 Child 才能
/// `wait()`，而「退出时杀掉它」发生在另一条线程上 —— 记所有权就等于两边抢。
pub struct CoreProcess(Mutex<Option<u32>>);

impl CoreProcess {
    pub fn new() -> Self {
        CoreProcess(Mutex::new(None))
    }

    fn get(&self) -> Option<u32> {
        *self.0.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn set(&self, pid: u32) {
        *self.0.lock().unwrap_or_else(|error| error.into_inner()) = Some(pid);
    }

    fn take(&self) -> Option<u32> {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
    }
}

/// `GetExitCodeProcess` 对「还活着」的进程返回这个值。真值不重要，重要的是它不等于
/// 任何一个真实的退出码。
const STILL_ACTIVE: u32 = 259;

/// 这个 pid 上的进程还在跑吗。
///
/// **不能只看 `OpenProcess` 能不能开。** 进程被杀之后、父进程还没回收它之前，它会以
/// 「已终止但对象还在」的状态留着，句柄照样开得到 —— 于是「杀掉了」会被读成「还活着」。
/// 实机抓到的：终止后 5 秒里 `OpenProcess` 次次都成功，于是 stop_core 每次都以为没杀掉。
/// 退出码才是判据：终止之后它给的是退出码，不再是 STILL_ACTIVE。
fn alive(pid: u32) -> bool {
    // SAFETY: 句柄用完立刻关，不跨线程传递；`code` 由调用方提供且有效。
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            // 句柄都拿不到：进程不存在，或者权限不够 —— 两种都不该由我们去补刀。
            return false;
        }
        let mut code: u32 = 0;
        let known = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        known != 0 && code == STILL_ACTIVE
    }
}

/// 结束进程。返回有没有真的下过手。
fn terminate(pid: u32) -> bool {
    // SAFETY: 同上；TerminateProcess 要求 PROCESS_TERMINATE 权限，所以这里单独开一次。
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return false;
        }
        let killed = TerminateProcess(handle, 0);
        CloseHandle(handle);
        killed != 0
    }
}

/// 收掉壳拉起来的本体。**只杀本体自己**：提供方是它以 detached 起的，而且管道一断
/// 它们会自己退场（`packages/provider-local/src/main.ts`）。本体去管别人的孩子是越界。
pub fn stop_core(app: &AppHandle) {
    let Some(state) = app.try_state::<CoreProcess>() else {
        return;
    };
    let Some(pid) = state.take() else {
        return;
    };
    if !alive(pid) {
        // 它自己先走了（比如本体认不出管道被别人占了而退出）。这不是错误，也不用报。
        return;
    }
    if !terminate(pid) {
        eprintln!("one: 没能结束本体（pid {pid}），它可能会留在后台占着管道");
        return;
    }
    let deadline = Instant::now() + CORE_STOP_GRACE;
    while alive(pid) && Instant::now() < deadline {
        thread::sleep(CORE_STOP_POLL);
    }
    if alive(pid) {
        eprintln!("one: 本体（pid {pid}）没有在期限内退出，管道可能被它占着");
    }
}

/// 「重新启动 ONE 本体」。先真的停掉再起 —— 只起不停的那个会立刻 EADDRINUSE 作废，
/// 于是这个按钮从上线起就没做过任何事。
pub fn restart_core(app: &AppHandle) -> Result<(), String> {
    stop_core(app);
    start_core(app)
}

/// 本体该怎么起来。这是 R02 之后**唯一**一处决定本体进程的东西。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreRuntime {
    /// 发布产物：自带 node，指哪跑哪，不依赖机器上有没有装 node。
    Bundled { node: PathBuf, entry: PathBuf, root: PathBuf },
    /// 开发环境：仓库里跑源码，用系统 node。开发时这条路才真的好用 ——
    /// 改一行源码就能生效，不用重新打包。
    Source { node: String, entry: PathBuf, root: PathBuf },
}

/// 本体不可用的原因。**要原样透给用户**，不能压成一句「没接上」——
/// 「产物缺失」和「node 没装」该做的事完全不同（ADR-021）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreUnavailable {
    /// 既没有产物，也不是在仓库里 —— 缺了一个该由构建补上的东西。
    NoRuntime { searched: Vec<PathBuf> },
    /// 找到了产物目录但清单不完整：构建没跑完或被人动过。
    BrokenManifest { at: PathBuf, reason: String },
}

impl CoreUnavailable {
    /// 用户会看到的一句话。**「找过哪儿」要真的列出来**：漏打包的机器上，
    /// 只说「找不到本体」等于让用户猜；只列源码路径又会让人以为是源码坏了。
    fn describe(&self) -> String {
        match self {
            CoreUnavailable::NoRuntime { searched } => {
                let mut text = String::from("找不到 ONE 本体：既没有可分发产物，也没有源码。找过：");
                if searched.is_empty() {
                    text.push_str("（没有任何可查的位置）");
                } else {
                    for path in searched {
                        text.push(' ');
                        text.push_str(&path.display().to_string());
                        text.push('；');
                    }
                }
                text.push_str("在 ONE 仓库里运行 pnpm core:package 生成产物");
                text
            }
            CoreUnavailable::BrokenManifest { at, reason } => {
                format!(
                    "本体产物不可用（{}）：{reason}。请重新运行 pnpm core:package",
                    at.display()
                )
            }
        }
    }
}

/// 从清单读出一个可用的本体运行时。清单字段是**敌意输入**：它由构建写出，也可能
/// 被改坏，因此路径必须在产物目录之内，不能让它指向别处。
fn read_manifest(root: &std::path::Path) -> Result<CoreRuntime, CoreUnavailable> {
    let broken = |reason: &str| CoreUnavailable::BrokenManifest {
        at: root.to_path_buf(),
        reason: reason.to_string(),
    };
    let text = std::fs::read_to_string(root.join(RUNTIME_MANIFEST))
        .map_err(|error| broken(&format!("读不到清单：{error}")))?;
    let value: Value = serde_json::from_str(&text).map_err(|error| broken(&format!("清单不是合法 JSON：{error}")))?;
    let node = value.get("nodeExe").and_then(Value::as_str).unwrap_or_default();
    let entry = value.get("entry").and_then(Value::as_str).unwrap_or_default();
    if node.is_empty() || entry.is_empty() {
        return Err(broken("清单缺 nodeExe 或 entry"));
    }
    let inside = |relative: &str| -> Result<PathBuf, CoreUnavailable> {
        let full = root.join(relative);
        // 清单里的路径必须在产物目录之内。清单来自磁盘，磁盘上的东西不可信。
        let relative_to_root = full
            .strip_prefix(root)
            .map_err(|_| broken("清单里的路径跑出了产物目录"))?;
        if relative_to_root.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::RootDir
            )
        }) {
            return Err(broken("清单里的路径含有 .. 或盘符"));
        }
        Ok(full)
    };
    let node_path = inside(node)?;
    if !node_path.is_file() {
        return Err(broken("清单指向的 node 不存在"));
    }
    let entry_path = inside(entry)?;
    if !entry_path.is_file() {
        return Err(broken("清单指向的本体入口不存在"));
    }
    Ok(CoreRuntime::Bundled {
        node: node_path,
        entry: entry_path,
        root: root.to_path_buf(),
    })
}

/// 找一个能跑本体的运行时：先找发布产物，再找开发仓库。
///
/// 发布版**不会**静默退回系统 node —— 漏打包的机器必须在界面上看见原因，
/// 而不是表现成「本体没接上」然后把问题藏到用户查不到的地方（ADR-021）。
pub fn find_core() -> Result<CoreRuntime, CoreUnavailable> {
    let mut roots = Vec::new();
    // 产物：跟着 exe 走，也允许显式指定（Tauri 打包时资源目录名可能带版本）。
    if let Ok(explicit) = std::env::var("ONE_CORE_RUNTIME") {
        roots.push(PathBuf::from(explicit));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
            if let Some(up) = dir.parent() {
                roots.push(up.to_path_buf());
            }
        }
    }
    find_core_in_with(&roots, repo_root)
}

/// 搜索根显式传进来，便于测试「哪儿都没有」与「产物优先」那两条。`repo` 是仓库查找
/// 函数，测试传自己的实现，因此结果不依赖测试机自己所在的位置。
fn find_core_in_with(
    roots: &[PathBuf],
    repo: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<CoreRuntime, CoreUnavailable> {
    let mut searched = Vec::new();
    for root in roots {
        let candidate = root.join(RUNTIME_DIR);
        searched.push(candidate.clone());
        if candidate.join(RUNTIME_MANIFEST).is_file() {
            return read_manifest(&candidate);
        }
    }
    // 开发环境回退：仓库里跑源码，用系统 node。只有真的找得到源码才走这条。
    match repo() {
        Ok(root) if root.join(CORE_ENTRY).exists() => Ok(CoreRuntime::Source {
            node: "node".to_string(),
            entry: root.join(CORE_ENTRY),
            root,
        }),
        _ => {
            // 产物目录一定要出现在「找过」里。漏打包的机器上，用户能做的第一件事
            // 就是去确认 dist-runtime 在不在 —— 不说，用户就只能猜。
            if !searched.iter().any(|path| path.ends_with(RUNTIME_DIR)) {
                searched.push(PathBuf::from(RUNTIME_DIR));
            }
            searched.push(PathBuf::from(CORE_ENTRY));
            Err(CoreUnavailable::NoRuntime { searched })
        }
    }
}

/// 记下「本体起不来」，并把状态推给**已经挂着**的窗口。
///
/// 三个失败点在同一条纪律下（ADR-021）：找不到运行时、清单坏了、node 拉不起来。
/// 只 `eprintln!` 等于把原因藏进日志 —— 用户界面上仍然只剩「本体没有连接」，
/// 而他真正需要的是「文件被安全软件拦了」还是「漏打包」。`emit` 也是必需的：
/// `RestartCore` 与 `launch_through_core` 都发生在窗口已经画出来之后，只往 link
/// 里存一份，已挂载的窗口不会重画。
fn note_core_problem(app: &AppHandle, text: String) {
    let Some(link) = app.try_state::<CoreLink>() else {
        eprintln!("one: 本体不可用：{text}");
        return;
    };
    link.note_core_problem(text.clone());
    let status = link.status();
    drop(link);
    eprintln!("one: 本体不可用：{text}");
    let _ = app.emit("core:status", status);
}

/// 启动本体。宠物是默认安装的那个客户端，但两端都需要它活着。
///
/// 失败时把原因**存进 link 并通知界面**而不只是打日志：用户也要看见
/// （ADR-021）。收 `AppHandle` 而不是 `&CoreLink`/`State`，是因为下面那条
/// 线程里的 `spawn` 失败也要走同一条通知路径。
pub fn start_core(app: &AppHandle) -> Result<(), String> {
    // 已经有一个**自己拉起来的**本体在跑就别再拉一个：第二个撞上 EADDRINUSE 会立刻
    // 作废退出，界面上什么也不变。菜单里「启动 ONE 宠物」「重新启动 ONE 本体」都走
    // 这里，所以这条不是优化，是别让用户看见一个点了没反应的按钮。
    if let Some(state) = app.try_state::<CoreProcess>() {
        match state.get() {
            Some(pid) if alive(pid) => {
                eprintln!("one: 本体已经在跑（pid {pid}），不再重复拉起");
                return Ok(());
            }
            Some(_) => {
                // 记着的那个自己没了（被人手动结束，或者崩了）：清掉记录，重新拉一个。
                // 这条是用户从「本体不见了」里自己走出来的路。
                eprintln!("one: 之前那个本体已经不在了，重新拉起");
                let _ = state.take();
            }
            None => {}
        }
    }
    // 打包后的 exe 可能在任意目录启动，因此不依赖当前工作目录。
    let runtime = match find_core() {
        Ok(runtime) => runtime,
        Err(reason) => {
            let text = reason.describe();
            note_core_problem(app, text.clone());
            return Err(text);
        }
    };
    let app = app.clone();
    // 用了哪一份 node 必须看得见。「本体没接上」有两种截然不同的成因 ——
    // 产物里的 node 与系统 node —— 只看现象分不出来（ADR-021）。
    eprintln!(
        "one: 本体运行时：{}（{}），工作目录 {}",
        runtime.entry().display(),
        runtime.node().display(),
        runtime.root().display()
    );
    thread::spawn(move || {
        let mut command = std::process::Command::new(&runtime.node());
        command
            .arg(&runtime.entry())
            .current_dir(runtime.root())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());
        // 客户端本身是 GUI 子系统（不弹控制台），而 node 是控制台程序：父进程
        // 没有控制台时，Windows 会给它新分配一个，于是每开一次宠物就闪一个黑框。
        // CREATE_NO_WINDOW 让本体在后台安静地跑，日志仍然走 stderr 转发。
        command.creation_flags(CREATE_NO_WINDOW);
        let Ok(mut child) = command.spawn() else {
            // 找得到文件却拉不起来，通常是安全软件把它隔离了，或者权限被改。
            // 这两种都不该表现成「本体没有连接」。
            note_core_problem(
                &app,
                format!(
                    "本体拉不起来：{} 存在但无法执行。检查安全软件是否隔离了它，\
                     或换一个位置后重试「重启本体」",
                    runtime.node().display()
                ),
            );
            return;
        };
        // 本体是常驻进程：必须边跑边转发它的输出，等它退出才读等于什么都看不到。
        if let Some(stderr) = child.stderr.take() {
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        eprintln!("one: 本体：{line}");
                    }
                }
            });
        }
        // 记下 pid，退出时由壳来结束它（见本文件「本体进程的生死」）。
        if let Some(state) = app.try_state::<CoreProcess>() {
            state.set(child.id());
        }
        let _ = child.wait();
    });
    Ok(())
}

impl CoreRuntime {
    pub fn node(&self) -> PathBuf {
        match self {
            CoreRuntime::Bundled { node, .. } => node.clone(),
            CoreRuntime::Source { node, .. } => PathBuf::from(node),
        }
    }

    pub fn entry(&self) -> PathBuf {
        match self {
            CoreRuntime::Bundled { entry, .. } | CoreRuntime::Source { entry, .. } => {
                entry.clone()
            }
        }
    }

    /// 本体进程的工作目录。产物里是产物根（相对路径才指得对），开发时是仓库根。
    pub fn root(&self) -> PathBuf {
        match self {
            CoreRuntime::Bundled { root, .. } | CoreRuntime::Source { root, .. } => {
                root.clone()
            }
        }
    }
}

/// What this process is, and whether ONE 本体 answered. The renderer asks for
/// this instead of guessing from the URL: both clients load the same page.
///
/// `role` is a label the core never special-cases; `provider` is the addressing
/// key other participants use to reach us (ADR-017).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    pub connected: bool,
    pub role: String,
    pub provider: String,
    pub label: String,
    pub capabilities: Vec<String>,
    pub wire_version: u32,
    pub core_version: Option<String>,
    /// 本体起不来时的原因，直接显示给用户；起得来就是 None。
    pub core_problem: Option<String>,
}

/// 本体拒绝了一个请求时给出的失败。code 保留下来是为了让调用方把「没运行」「没这个
/// 页面」「版本对不上」翻译成不同的界面，而不是合成一句「出了点问题」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreFailure {
    pub code: String,
    pub message: String,
}

pub struct CoreLink {
    role: String,
    provider: String,
    label: String,
    capabilities: Vec<String>,
    wire_version: u32,
    /// 本体接受握手后回报的版本；未连接时为 None，不猜。
    core_version: Mutex<Option<String>>,
    /// **本体起不来的原因**，原样透给界面。`None` 表示没出过错。
    ///
    /// 存起来而不是只打日志，是因为「本体没接上」这句话对用户毫无用处 ——
    /// 他需要知道是「漏打包」还是「node 没装」还是「产物坏在哪儿」（ADR-021）。
    core_problem: Mutex<Option<String>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    connected: Mutex<bool>,
    /// 菜单动作由壳发起，界面上没有回执框，因此壳自己认领这些 id。
    shell_pending: Mutex<HashSet<String>>,
    shell_seq: Mutex<u64>,
    /// 壳自己发起、要等回执的请求（取插件页面、查名册）。回执由读线程投递，
    /// 所以这里只能放一个发送端：放不下的调用会立刻看到失败，而不是等一个
    /// 永远不会来的回执。
    waiting: Mutex<HashMap<String, mpsc::Sender<Result<Value, CoreFailure>>>>,
    /// 本体最近发过的 welcome / state / roster，供后开的只读窗口重放。
    last_frames: Mutex<Vec<String>>,
}

impl CoreLink {
    pub fn status(&self) -> CoreStatus {
        CoreStatus {
            connected: *self.connected.lock().unwrap(),
            role: self.role.clone(),
            provider: self.provider.clone(),
            label: self.label.clone(),
            capabilities: self.capabilities.clone(),
            wire_version: self.wire_version,
            core_version: self.core_version.lock().unwrap().clone(),
            core_problem: self.core_problem.lock().unwrap().clone(),
        }
    }

    /// 记下本体起不来的原因。它会**一直留着**直到本体真的连上一次 ——
    /// 静默清掉的话，用户盯着「没接上」两个字永远不知道自己该去做什么。
    pub fn note_core_problem(&self, problem: String) {
        eprintln!("one: 本体不可用：{problem}");
        *self.core_problem.lock().unwrap() = Some(problem);
    }

    /// A request id the shell owns, so its outcome is not silently dropped.
    pub fn next_shell_request(&self) -> String {
        let mut seq = self.shell_seq.lock().unwrap();
        *seq += 1;
        let id = format!("shell-{}", *seq);
        self.shell_pending.lock().unwrap().insert(id.clone());
        eprintln!("one: 壳发起 {id}");
        id
    }

    /**
     * 发一帧并等它的回执。菜单与自定义协议要用它 —— 那两处都在 webview 之外，
     * 没有界面可以渲染一个 Promise，只能同步拿到结果或者拿到一句失败。
     *
     * 阻塞的是调用方那一根线程（协议处理器、菜单处理），读管道的那根不受影响：
     * 它把回执投进 channel，这里醒来。两处共用同一个 id 前缀 `shell-`，因此不会
     * 和界面的请求撞号。
     */
    pub fn request(&self, frame: Value, timeout: Duration) -> Result<Value, CoreFailure> {
        let Some(id) = frame.get("id").and_then(Value::as_str).map(str::to_string) else {
            return Err(CoreFailure {
                code: "VALIDATION".into(),
                message: "壳发起的请求必须带 id".into(),
            });
        };
        let (sender, receiver) = mpsc::channel();
        {
            let mut waiting = self.waiting.lock().unwrap();
            // 同一个 id 已经有主人在等：撞号说明有 bug，宁可立刻失败也别丢掉两份回执。
            if waiting.contains_key(&id) {
                return Err(CoreFailure {
                    code: "CONFLICT".into(),
                    message: format!("请求 {id} 已经在等待回执"),
                });
            }
            waiting.insert(id.clone(), sender);
        }
        if let Err(error) = send(self, &frame) {
            self.forget(&id);
            return Err(CoreFailure {
                code: "UNAVAILABLE".into(),
                message: error,
            });
        }
        let outcome = receiver.recv_timeout(timeout);
        self.forget(&id);
        match outcome {
            Ok(answer) => answer,
            Err(_) => Err(CoreFailure {
                code: "TIMEOUT".into(),
                message: "ONE 本体没有回应，请确认它还在运行".into(),
            }),
        }
    }

    fn forget(&self, id: &str) {
        self.waiting.lock().unwrap().remove(id);
    }

    /// A departing core must not leave a caller waiting past its own timeout.
    fn fail_all(&self, code: &str, message: &str) {
        let waiting: Vec<mpsc::Sender<Result<Value, CoreFailure>>> = {
            let mut guard = self.waiting.lock().unwrap();
            guard.drain().map(|(_, sender)| sender).collect()
        };
        for sender in waiting {
            let _ = sender.send(Err(CoreFailure {
                code: code.to_string(),
                message: message.to_string(),
            }));
        }
    }

    /// Reports the outcome of a shell-initiated request once, then forgets it.
    fn log_shell_result(&self, line: &str) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if value.get("t").and_then(Value::as_str) != Some("result") {
            return;
        }
        let Some(id) = value.get("id").and_then(Value::as_str) else {
            return;
        };
        if !self.shell_pending.lock().unwrap().remove(id) {
            return;
        }
        if value.get("ok").and_then(Value::as_bool) == Some(true) {
            eprintln!(
                "one: 本体已处理 {id}：{}",
                value.get("value").unwrap_or(&Value::Null)
            );
        } else {
            let message = value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("未知错误");
            eprintln!("one: 本体拒绝了 {id}：{message}");
        }
    }
}

/// One frame is one line, and nothing goes on the wire that the core would only
/// have to reject. `slot` is None exactly when 本体 is not connected.
pub fn write_frame(slot: &mut Option<Box<dyn Write + Send>>, frame: &Value) -> Result<(), String> {
    let target = slot.as_mut().ok_or("ONE 本体没有连接，请稍后重试")?;
    let mut line = serde_json::to_string(frame).map_err(|error| error.to_string())?;
    line.push('\n');
    if line.len() > MAX_FRAME_BYTES {
        return Err("这一帧超过本体允许的上限".into());
    }
    target
        .write_all(line.as_bytes())
        .and_then(|()| target.flush())
        .map_err(|error| format!("向本体发送失败：{error}"))
}

fn send(link: &CoreLink, frame: &Value) -> Result<(), String> {
    let mut guard = link.writer.lock().map_err(|error| error.to_string())?;
    write_frame(&mut guard, frame)
}

/// 把 webview 的命令转成协议帧发给本体；本体只认白名单命令。
pub fn send_frame(link: &CoreLink, frame: Value) -> Result<(), String> {
    send(link, &frame)
}

/// 只读窗口没有自己的握手，靠重放本体最近几帧拿到状态与名册。
///
/// 一个客户端进程只有一次握手（ADR-013：客户端是进程，窗口只是它的屏幕），
/// 所以后开的窗口必须从壳这里补上它错过的那几帧 —— 否则它会永远停在
/// "正在连接"，而本体明明是通的。
#[tauri::command]
pub fn core_replay(
    app: AppHandle,
    window: WebviewWindow,
    link: State<'_, CoreLink>,
) -> Result<(), String> {
    let frames = link.last_frames.lock().map_err(|error| error.to_string())?;
    for frame in frames.iter() {
        let _ = app.emit_to(window.label(), "core:message", frame.clone());
    }
    Ok(())
}

/// 记住本体最近发过的握手、状态与名册，供后开的窗口重放。其它帧不进这里：
/// 重放一条命令的回执会让界面以为那个请求是自己发的。
fn remember_frame(link: &CoreLink, line: &str) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return;
    };
    let kind = value.get("t").and_then(Value::as_str).unwrap_or("");
    if !matches!(kind, "welcome" | "state" | "roster") {
        return;
    }
    let Ok(mut frames) = link.last_frames.lock() else {
        return;
    };
    frames.retain(|item| {
        serde_json::from_str::<Value>(item)
            .ok()
            .and_then(|item| item.get("t").and_then(Value::as_str).map(str::to_string))
            != Some(kind.to_string())
    });
    frames.push(line.to_string());
}

/// 菜单在 webview 之外，所以壳自己也要能向本体发帧：拉起另一个客户端只能
/// 走本体，壳不直接 spawn 客户端进程。
pub fn send_command(app: &AppHandle, frame: Value) -> Result<(), String> {
    let link = app.try_state::<CoreLink>().ok_or("本体桥接还没准备好")?;
    send(&link, &frame)
}

fn note_core_version(link: &CoreLink, line: &str) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return;
    };
    if value.get("t").and_then(Value::as_str) != Some("welcome") {
        return;
    }
    if let Some(version) = value.get("coreVersion").and_then(Value::as_str) {
        *link.core_version.lock().unwrap() = Some(version.to_string());
    }
    // 本体真的接上了，之前记下的「起不来」到此作废。留着的话，界面上会一边
    // 显示「已连接」一边显示「漏打包」，两句话互相打架。
    *link.core_problem.lock().unwrap() = None;
}

/// 本体来的每一行都原样转给 webview，由它自己解释；壳只顺手认领自己发起的请求。
fn forward_line(app: &AppHandle, line: &str) {
    if let Some(link) = app.try_state::<CoreLink>() {
        note_core_version(&link, line);
        link.log_shell_result(line);
        deliver_shell_answer(&link, line);
        remember_frame(&link, line);
    }
    let _ = app.emit("core:message", line.to_string());
}

/// 把回执交给在等它的那根线程。id 不在册就说明这是界面的请求，原样走事件流 ——
/// 两边共用同一根管道，靠 id 前缀区分是谁的。
fn deliver_shell_answer(link: &CoreLink, line: &str) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return;
    };
    if value.get("t").and_then(Value::as_str) != Some("result") {
        return;
    }
    let Some(id) = value.get("id").and_then(Value::as_str) else {
        return;
    };
    let Some(sender) = link.waiting.lock().unwrap().remove(id) else {
        return;
    };
    let answer = if value.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(value.get("value").cloned().unwrap_or(Value::Null))
    } else {
        let error = value.get("error");
        Err(CoreFailure {
            code: error
                .and_then(|error| error.get("code"))
                .and_then(Value::as_str)
                .unwrap_or("INTERNAL")
                .to_string(),
            message: error
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("本体处理失败")
                .to_string(),
        })
    };
    // 对方可能已经超时走了；发不出去不是错误，回执本身已经用完。
    let _ = sender.send(answer);
}

/// 不阻塞地问一句管道里还有多少字节。没有数据时立即返回，而不是等。
fn bytes_available(pipe: &File) -> std::io::Result<u32> {
    let mut available: u32 = 0;
    // SAFETY: PeekNamedPipe 不写入任何缓冲区；空指针表示"这次不关心那个结果"。
    let ok = unsafe {
        PeekNamedPipe(
            pipe.as_raw_handle() as HANDLE,
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut available,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(available)
}

fn repo_root() -> Result<PathBuf, String> {
    if let Ok(configured) = std::env::var("ONE_REPO_ROOT") {
        let path = PathBuf::from(configured);
        if path.join(CORE_ENTRY).exists() {
            return Ok(path);
        }
    }
    // 编译期就知道仓库长什么样：打包后的 exe 也在 src-tauri 里，可以从它反推。
    let from_build = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|parent| parent.to_path_buf())
        .ok_or("无法推断仓库根目录")?;
    if from_build.join(CORE_ENTRY).exists() {
        return Ok(from_build);
    }
    if let Ok(current) = std::env::current_dir() {
        for parent in current.ancestors() {
            if parent.join(CORE_ENTRY).exists() {
                return Ok(parent.to_path_buf());
            }
        }
    }
    Err(format!(
        "找不到 ONE 仓库：请设置 ONE_REPO_ROOT，期望其中存在 {CORE_ENTRY}"
    ))
}


fn spawn_pipe_reader(app: AppHandle) {
    thread::spawn(move || loop {
        // std 的命名管道类型仍未稳定，这里用同步句柄：行协议不需要 overlapped。
        match OpenOptions::new().read(true).write(true).open(PIPE_PATH) {
            Ok(mut pipe) => {
                eprintln!("one: 已连上 ONE 本体的命名管道");
                let Some(link) = app.try_state::<CoreLink>() else {
                    return;
                };
                let writer = pipe
                    .try_clone()
                    .map(BufWriter::new)
                    .ok()
                    .map(|buffer| Box::new(buffer) as Box<dyn Write + Send>);
                if writer.is_none() {
                    eprintln!("one: 管道写入端拿不到，本体收不到任何东西");
                }
                *link.connected.lock().unwrap() = true;
                *link.writer.lock().unwrap() = writer;
                let status = link.status();
                drop(link);
                let _ = app.emit("core:status", status);

                // 逐行读：自己控制缓冲区，才能说清楚是"读错了"还是"本体关了"。
                // 按字节攒、按行解码 —— 一个 UTF-8 字符完全可能被切成两次读取。
                let mut buffer: Vec<u8> = Vec::new();
                let mut chunk = vec![0u8; 8192];
                let mut idle = POLL_MIN;
                let ending;
                loop {
                    match bytes_available(&pipe) {
                        Ok(0) => {
                            thread::sleep(idle);
                            idle = (idle * 2).min(POLL_MAX);
                            continue;
                        }
                        Ok(available) => {
                            idle = POLL_MIN;
                            if available as usize > MAX_FRAME_BYTES || buffer.len() > MAX_FRAME_BYTES {
                                ending = "本体发来超长帧".to_string();
                                break;
                            }
                            let want = (available as usize).min(chunk.len());
                            match pipe.read(&mut chunk[..want]) {
                                Ok(0) => {
                                    ending = "本体关闭了连接".to_string();
                                    break;
                                }
                                Ok(count) => buffer.extend_from_slice(&chunk[..count]),
                                Err(error) => {
                                    ending = format!("读取失败：{error}");
                                    break;
                                }
                            }
                        }
                        Err(error) => {
                            // 本体关掉连接时这里就是断点，不用等一次超时的读。
                            ending = format!("读取失败：{error}");
                            break;
                        }
                    }
                    while let Some(index) = buffer.iter().position(|byte| *byte == b'\n') {
                        let line: Vec<u8> = buffer.drain(..=index).collect();
                        let text = String::from_utf8_lossy(&line[..line.len() - 1]);
                        let text = text.trim();
                        if text.is_empty() {
                            continue;
                        }
                        forward_line(&app, text);
                    }
                }
                eprintln!("one: 与 ONE 本体的连接结束：{ending}");

                if let Some(link) = app.try_state::<CoreLink>() {
                    *link.connected.lock().unwrap() = false;
                    *link.writer.lock().unwrap() = None;
                    *link.core_version.lock().unwrap() = None;
                    link.shell_pending.lock().unwrap().clear();
                    // 还在等回执的调用不能陪着一起等超时：连接已经断了。
                    link.fail_all("UNAVAILABLE", "ONE 本体没有连接");
                    let status = link.status();
                    let _ = app.emit("core:status", status);
                }
            }
            Err(_) => thread::sleep(RECONNECT_DELAY),
        }
    });
}

pub fn start_bridge(
    app: &AppHandle,
    role: &str,
    provider: &str,
    label: &str,
    capabilities: &[&str],
    wire_version: u32,
) {
    app.manage(CoreLink {
        role: role.to_string(),
        provider: provider.to_string(),
        label: label.to_string(),
        capabilities: capabilities.iter().map(|item| item.to_string()).collect(),
        wire_version,
        core_version: Mutex::new(None),
        core_problem: Mutex::new(None),
        writer: Mutex::new(None),
        connected: Mutex::new(false),
        shell_pending: Mutex::new(HashSet::new()),
        shell_seq: Mutex::new(0),
        waiting: Mutex::new(HashMap::new()),
        last_frames: Mutex::new(Vec::new()),
    });
    spawn_pipe_reader(app.clone());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实起一个会待着不走的进程，用来验「结束它」这件事真的结束了。
    /// 用真进程而不是桩：这里错的正是「以为结束了其实没结束」，桩不会露馅。
    fn spawn_idle() -> std::process::Child {
        let mut command = std::process::Command::new("powershell");
        command
            .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
            .creation_flags(CREATE_NO_WINDOW);
        command.spawn().expect("起一个待着的进程")
    }

    #[test]
    fn a_pid_that_never_existed_is_not_alive() {
        // 「探不到」与「还在」必须分得开，否则 stop_core 会去杀一个已经走了的 pid。
        assert!(!alive(u32::MAX - 1));
        assert!(!terminate(u32::MAX - 1));
    }

    #[test]
    fn terminating_a_process_really_ends_it() {
        let mut child = spawn_idle();
        let pid = child.id();
        assert!(alive(pid), "刚起来就该是活的");
        assert!(terminate(pid), "有权限就该杀得掉");
        // 进程真正消失之前，管道还没释放，「重新启动」紧接着起新的就会撞上它。
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive(pid) && Instant::now() < deadline {
            thread::sleep(CORE_STOP_POLL);
        }
        assert!(!alive(pid), "杀完就该不在了");
        let _ = child.wait();
    }

    #[test]
    fn the_recorded_pid_is_taken_out_exactly_once() {
        // stop_core 是幂等的：退出钩子与「重新启动」都会调它，第二次不能再杀一遍。
        let state = CoreProcess::new();
        assert_eq!(state.get(), None);
        state.set(4242);
        assert_eq!(state.get(), Some(4242));
        assert_eq!(state.take(), Some(4242));
        assert_eq!(state.take(), None);
    }

    /// 临时目录建在目标目录旁边（Windows 允许跨卷创建，这里同卷最省事）。
    /// 名字带测试用途与随机尾巴，并发跑时不互相踩。
    fn temp_dir(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "one-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&base).expect("建临时目录");
        base
    }

    fn write_file(path: &std::path::Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("建上级目录");
        }
        std::fs::write(path, bytes).expect("写临时文件");
    }

    fn link() -> std::sync::Arc<CoreLink> {
        std::sync::Arc::new(CoreLink {
            role: "pet".into(),
            provider: "pet".into(),
            label: "ONE 宠物".into(),
            capabilities: Vec::new(),
            wire_version: 4,
            core_version: Mutex::new(None),
        core_problem: Mutex::new(None),
            writer: Mutex::new(None),
            connected: Mutex::new(false),
            shell_pending: Mutex::new(HashSet::new()),
            shell_seq: Mutex::new(0),
            waiting: Mutex::new(HashMap::new()),
            last_frames: Mutex::new(Vec::new()),
        })
    }

    #[test]
    fn the_shell_and_the_contract_agree_on_the_wire_version() {
        // 协议版本在 wire.ts 与 main.rs 各有一份。注释说「保持同步」是没用的 ——
        // 真同步要靠这条测试去读那一份真的文件。
        //
        // 不同步的后果不是报错：本体按 v4 的版本表拒掉一个报 v3 的客户端，
        // 界面上只写「协议版本不兼容」，没人知道该改哪个数字。
        let source = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("仓库根目录")
                .join("packages/contracts/src/wire.ts"),
        )
        .expect("读得到 wire.ts");
        let declared = source
            .lines()
            .find_map(|line| {
                let rest = line.trim().strip_prefix("export const WIRE_VERSION =")?;
                rest.trim().trim_end_matches(';').trim().parse::<u32>().ok()
            })
            .expect("wire.ts 里写着 WIRE_VERSION");
        assert_eq!(declared, crate::WIRE_VERSION, "壳与契约的协议版本不一致");
    }

    #[test]
    fn a_bundled_manifest_names_the_node_and_the_entry() {
        // 产物目录里放一个能过的清单：壳据此启动，全程不猜。
        let root = temp_dir("r02-ok");
        write_file(&root.join("node.exe"), b"MZ");
        write_file(&root.join("core/src/index.ts"), b"// core");
        write_file(
            &root.join(RUNTIME_MANIFEST),
            br#"{"nodeExe":"node.exe","entry":"core/src/index.ts","node":"v22.0.0"}"#,
        );
        let CoreRuntime::Bundled { node, entry, root: found } = read_manifest(&root).unwrap()
        else {
            panic!("清单完整时应当认成产物");
        };
        assert!(node.ends_with("node.exe"), "启动的是产物自带的 node，不是系统 node");
        assert!(entry.ends_with(r"core\src\index.ts"));
        assert_eq!(found, root);
    }

    #[test]
    fn a_manifest_cannot_point_the_shell_outside_its_own_directory() {
        // 清单来自磁盘，磁盘上的东西不可信：路径跑出产物目录一律拒绝。
        let root = temp_dir("r02-escape");
        write_file(&root.join("node.exe"), b"MZ");
        write_file(&root.join(RUNTIME_MANIFEST), br#"{"nodeExe":"..\\..\\evil.exe","entry":"core/src/index.ts"}"#);
        let reason = read_manifest(&root).expect_err("跑出产物目录的路径必须被拒");
        assert!(matches!(reason, CoreUnavailable::BrokenManifest { .. }));
    }

    #[test]
    fn an_incomplete_manifest_says_which_part_is_missing() {
        // 构建没跑完、或产物被人动过 —— 说清缺什么，别压成一句「没接上」。
        let cases: [(&str, &[u8]); 3] = [
            ("r02-no-node", br#"{"entry":"core/src/index.ts"}"#),
            ("r02-no-entry", br#"{"nodeExe":"node.exe"}"#),
            ("r02-bad-json", b"not json at all"),
        ];
        for (name, body) in cases {
            let root = temp_dir(name);
            write_file(&root.join("node.exe"), b"MZ");
            write_file(&root.join("core/src/index.ts"), b"// core");
            write_file(&root.join(RUNTIME_MANIFEST), body);
            let reason = read_manifest(&root).expect_err("残缺的清单必须被拒");
            assert!(matches!(reason, CoreUnavailable::BrokenManifest { .. }), "{name}");
        }
    }

    #[test]
    fn a_manifest_pointing_at_a_missing_node_is_refused() {
        // 清单说 node 在，可文件没了：这时启动会失败，而失败会表现成「本体没接上」，
        // 跟「漏打包」混成一句话。构建期就拒掉。
        let root = temp_dir("r02-gone");
        write_file(&root.join("core/src/index.ts"), b"// core");
        write_file(&root.join(RUNTIME_MANIFEST), br#"{"nodeExe":"node.exe","entry":"core/src/index.ts"}"#);
        assert!(matches!(
            read_manifest(&root),
            Err(CoreUnavailable::BrokenManifest { .. })
        ));
    }

    #[test]
    fn no_runtime_anywhere_reports_where_it_looked() {
        // 一台没跑过 core:package、又不在仓库里的机器：用户要知道去找过哪儿、
        // 该做什么，而不是只看见「本体没接上」。
        // 搜索根显式给空、仓库查找显式给 None，因此不依赖测试机自己所在的位置。
        let reason = find_core_in_with(&[], || Err("测试：这台机器不在仓库里".into()))
            .expect_err("哪儿都没有就是没有");
        let text = reason.describe();
        assert!(text.contains("pnpm core:package"), "得告诉用户怎么办：{text}");
        assert!(text.contains(RUNTIME_DIR), "得说清找过哪儿：{text}");
    }

    #[test]
    fn a_bundled_runtime_wins_over_the_development_sources() {
        // 产物优先：真到用户机器上时根本没有仓库可回退，这条路必须是常态而不是
        // 兜底。开发机上也可能编过一份，用它才不会让本地行为与发布版分叉。
        let root = temp_dir("r02-priority");
        write_file(&root.join(RUNTIME_DIR).join("node.exe"), b"MZ");
        write_file(
            &root.join(RUNTIME_DIR).join("core/src/index.ts"),
            b"// bundled",
        );
        write_file(
            &root.join(RUNTIME_DIR).join(RUNTIME_MANIFEST),
            br#"{"nodeExe":"node.exe","entry":"core/src/index.ts"}"#,
        );
        let found = find_core_in_with(&[root], || Err("测试：不该走到回退".into()))
            .expect("产物应当被认出来");
        assert!(
            matches!(found, CoreRuntime::Bundled { .. }),
            "有产物就不该回退到源码"
        );
    }

    #[test]
    fn a_missing_manifest_falls_through_to_the_development_sources() {
        // 目录在、清单不在 = 构建没跑完。这时开发机该继续用源码而不是报错 ——
        // 开发时反复跑 core:package 是常事，报错只会让人烦。
        let root = temp_dir("r02-fallthrough");
        std::fs::create_dir_all(root.join(RUNTIME_DIR)).unwrap();
        write_file(&root.join(CORE_ENTRY), b"// core");
        let found = find_core_in_with(&[], || Ok(root.clone()))
            .expect("应当回退到源码");
        assert!(matches!(found, CoreRuntime::Source { .. }));
        assert_eq!(found.node(), PathBuf::from("node"), "开发时用系统 node");
    }

    #[test]
    fn the_runtime_points_at_its_own_directory_so_relative_imports_resolve() {
        // 本体的 import 全是相对的（`../../packages/...`），工作目录与入口的相对位置
        // 错了就找不到 contracts —— 而那个错会表现成「本体崩了」。
        let root = temp_dir("r02-relative");
        write_file(&root.join("node.exe"), b"MZ");
        write_file(&root.join("core/src/index.ts"), b"// core");
        write_file(&root.join(RUNTIME_MANIFEST), br#"{"nodeExe":"node.exe","entry":"core/src/index.ts"}"#);
        let CoreRuntime::Bundled { entry, root: found, .. } = read_manifest(&root).unwrap() else {
            panic!("应当认成产物");
        };
        assert!(entry.starts_with(&found), "入口必须相对产物根");
    }

    #[test]
    fn only_the_frames_a_late_window_needs_are_kept_for_replay() {
        // 只读窗口靠重放起步：welcome、状态、名册缺一不可，而命令回执绝对不能
        // 重放 —— 界面会以为那个请求是自己发的。
        let link = link();
        remember_frame(&link, r#"{"t":"welcome","v":3,"clientId":"a","coreVersion":"test"}"#);
        remember_frame(&link, r#"{"t":"state","revision":1,"snapshot":{}}"#);
        remember_frame(&link, r#"{"t":"roster","participants":[],"installed":[]}"#);
        remember_frame(&link, r#"{"t":"result","id":"r1","ok":true}"#);
        remember_frame(&link, r#"{"t":"invoke","id":"r2","capability":"x"}"#);

        let frames = link.last_frames.lock().unwrap();
        let kinds: Vec<String> = frames
            .iter()
            .map(|frame| {
                serde_json::from_str::<Value>(frame).unwrap()["t"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(kinds, vec!["welcome", "state", "roster"]);
    }

    #[test]
    fn a_replayed_state_replaces_the_previous_one() {
        // 名册与状态每次都重放最新的：缓存旧的那份会让后开的窗口对着过期世界
        // 画界面，而它自己又没有理由收到下一次。
        let link = link();
        remember_frame(&link, r#"{"t":"state","revision":1,"snapshot":{}}"#);
        remember_frame(&link, r#"{"t":"state","revision":2,"snapshot":{}}"#);
        let frames = link.last_frames.lock().unwrap();
        assert_eq!(frames.len(), 1);
        assert!(frames[0].contains("\"revision\":2"));
    }
    use serde_json::json;
    use std::sync::Arc;

    /// Collects whatever the bridge would have put on the wire.
    #[derive(Clone, Default)]
    struct Wire(Arc<Mutex<Vec<u8>>>);

    impl Write for Wire {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Wire {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    fn call_frame() -> Value {
        json!({ "t": "call", "id": "1", "cmd": "sendMessage", "args": ["c", "hi"] })
    }

    #[test]
    fn refuses_to_queue_a_frame_while_core_is_absent() {
        let mut writer: Option<Box<dyn Write + Send>> = None;
        let error = write_frame(&mut writer, &call_frame()).unwrap_err();
        assert!(error.contains("没有连接"));
    }

    #[test]
    fn writes_exactly_one_line_per_frame_so_the_core_can_split_them() {
        let wire = Wire::default();
        let mut writer: Option<Box<dyn Write + Send>> = Some(Box::new(wire.clone()));
        write_frame(&mut writer, &call_frame()).expect("写入成功");
        let text = wire.text();
        assert!(text.ends_with('\n'), "帧必须自带换行：{text:?}");
        assert_eq!(text.matches('\n').count(), 1, "一个帧只能占一行：{text:?}");
        assert!(text.trim_end().starts_with('{'));
    }

    #[test]
    fn rejects_a_frame_larger_than_the_core_limit_without_sending_it() {
        let wire = Wire::default();
        let mut writer: Option<Box<dyn Write + Send>> = Some(Box::new(wire.clone()));
        let huge = json!({
            "t": "call",
            "id": "1",
            "cmd": "sendMessage",
            "args": ["c", "a".repeat(MAX_FRAME_BYTES)],
        });
        let error = write_frame(&mut writer, &huge).unwrap_err();
        assert!(error.contains("上限"));
        assert!(wire.text().is_empty(), "超限的帧不能有部分内容上线");
    }
}
