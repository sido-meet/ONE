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
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::Pipes::PeekNamedPipe;

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
        }
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

/// 启动本体。宠物是默认安装的那个客户端，但两端都需要它活着。
pub fn start_core() -> Result<(), String> {
    // 打包后的 exe 可能在任意目录启动，因此不依赖当前工作目录。
    let root = repo_root()?;
    let script = root.join(CORE_ENTRY);
    if !script.exists() {
        return Err(format!("找不到本体入口：{}", script.display()));
    }
    thread::spawn(move || {
        let mut command = std::process::Command::new("node");
        command
            .arg(&script)
            .current_dir(&root)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());
        // 客户端本身是 GUI 子系统（不弹控制台），而 node 是控制台程序：父进程
        // 没有控制台时，Windows 会给它新分配一个，于是每开一次宠物就闪一个黑框。
        // CREATE_NO_WINDOW 让本体在后台安静地跑，日志仍然走 stderr 转发。
        command.creation_flags(CREATE_NO_WINDOW);
        let Ok(mut child) = command.spawn() else {
            eprintln!("one: 启动本体失败：node 不可用");
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
        let _ = child.wait();
    });
    Ok(())
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

    fn link() -> std::sync::Arc<CoreLink> {
        std::sync::Arc::new(CoreLink {
            role: "pet".into(),
            provider: "pet".into(),
            label: "ONE 宠物".into(),
            capabilities: Vec::new(),
            wire_version: 3,
            core_version: Mutex::new(None),
            writer: Mutex::new(None),
            connected: Mutex::new(false),
            shell_pending: Mutex::new(HashSet::new()),
            shell_seq: Mutex::new(0),
            waiting: Mutex::new(HashMap::new()),
            last_frames: Mutex::new(Vec::new()),
        })
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
