use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
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
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    pub connected: bool,
    pub kind: String,
    pub label: String,
    pub capabilities: Vec<String>,
    pub wire_version: u32,
    pub core_version: Option<String>,
}

pub struct CoreLink {
    kind: String,
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
}

impl CoreLink {
    pub fn status(&self) -> CoreStatus {
        CoreStatus {
            connected: *self.connected.lock().unwrap(),
            kind: self.kind.clone(),
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
        id
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
    }
    let _ = app.emit("core:message", line.to_string());
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
    kind: &str,
    label: &str,
    capabilities: &[&str],
    wire_version: u32,
) {
    app.manage(CoreLink {
        kind: kind.to_string(),
        label: label.to_string(),
        capabilities: capabilities.iter().map(|item| item.to_string()).collect(),
        wire_version,
        core_version: Mutex::new(None),
        writer: Mutex::new(None),
        connected: Mutex::new(false),
        shell_pending: Mutex::new(HashSet::new()),
        shell_seq: Mutex::new(0),
    });
    spawn_pipe_reader(app.clone());
}

#[cfg(test)]
mod tests {
    use super::*;
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
