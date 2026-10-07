use std::collections::HashMap;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{
    http::{header, Response, StatusCode},
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use crate::core_link::CoreLink;
use crate::frames;

/**
 * 插件页面托管（ADR-018）。
 *
 * 插件是两件货：数据接口与自带页面。这一模块只管**容器**：把 `one-plugin://` 的
 * 资源请求转交给插件进程取回、把页面放进窗口。它不理解页面里的任何一个字，也不
 * 该理解 —— 界面归插件是已接受的代价（换 Outlook 实现，日历长得不一样）。
 *
 * 三条边界写死在这里：
 *
 * 1. **窗口与 provider 一一绑定**（`PluginWindows`）。绑定记在壳手里，不采信页面
 *    自报的身份；页面根本没有身份字段可填。
 * 2. **页面拿不到本体**。壳替它转发，每个请求都回本体重新核对名册（ADR-016）。
 * 3. **页面崩溃不留白屏**。插件不在场、页面取不到、路径不合法，一律回一个说得清
 *    原因的文字页面，而不是让 iframe 空着。
 */

pub const SCHEME: &str = "one-plugin";
/// 窗口标签带这个前缀，后面的部分就是寻址键。
pub const WINDOW_PREFIX: &str = "plugin-";

/// 取页面要走一次管道往返：本体→插件→本体。比界面的 8 秒短一点，留出余量。
const PAGE_TIMEOUT: Duration = Duration::from_secs(6);
const ROSTER_TIMEOUT: Duration = Duration::from_millis(1500);

/**
 * 插件页面的 CSP —— 「页面没有 Node、没有文件系统、没有网络」这句话真正落地的地方。
 *
 * `default-src 'none'` 一刀切掉外部资源与一切连接，`script-src` / `style-src` 只放
 * 行内联（页面因此必须是自包含单文件），`form-action 'none'` 断掉表单外发。
 * `frame-ancestors` 只认宿主自己的两种来源：发布版的 `tauri.localhost` 与开发版的
 * `127.0.0.1:1420`。少了这一条，别的页面可以把它套进自己的 iframe 去探资源。
 */
pub const PAGE_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors http://tauri.localhost http://127.0.0.1:1420";

/// 寻址键守卫，必须与 packages/contracts/src/wire.ts 的 isProviderId 一致：
/// 小写字母开头，点或连字符分段。它是 URL 里的第一段，放开大写或斜杠就等于把
/// 目录结构交给了一个 URL。
pub fn is_provider_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 128 || !bytes[0].is_ascii_lowercase() {
        return false;
    }
    let mut previous_separator = false;
    for &byte in &bytes[1..] {
        if byte == b'.' || byte == b'-' {
            if previous_separator {
                return false;
            }
            previous_separator = true;
            continue;
        }
        if !(byte.is_ascii_lowercase() || byte.is_ascii_digit()) {
            return false;
        }
        previous_separator = false;
    }
    !previous_separator
}

/// 一个资源请求解析出来的归属：哪个插件的哪个文件。
#[derive(Debug, PartialEq, Eq)]
pub struct PluginTarget {
    pub provider: String,
    pub path: String,
}

/// `one-plugin://localhost/<provider>/<entry>` —— 主机名固定 localhost，因为
/// Windows 上 WebView2 不认非标准协议，wry 会先改写成
/// `http://one-plugin.localhost/...` 再拦截；路径原样保留，所以寻址键只能放路径里。
pub fn parse_plugin_uri(uri: &str) -> Result<PluginTarget, String> {
    let rest = uri
        .strip_prefix(&format!("{SCHEME}://"))
        .ok_or("这不是插件地址")?;
    let (host, path) = rest.split_once('/').ok_or("插件地址里没有资源名")?;
    if !host.eq_ignore_ascii_case("localhost") {
        return Err("插件地址的主机名只能是 localhost".into());
    }
    if path.contains('?') || path.contains('#') {
        return Err("插件地址不接受查询串或片段".into());
    }
    if path.contains('\\') || path.contains("..") {
        return Err("插件地址不接受 .. 或反斜杠".into());
    }
    let (provider, file) = path.split_once('/').unwrap_or((path, ""));
    if !is_provider_id(provider) {
        return Err(format!("{provider} 不是合法的寻址键"));
    }
    if file.is_empty() {
        return Err("插件地址里没有资源名".into());
    }
    Ok(PluginTarget {
        provider: provider.to_string(),
        path: file.to_string(),
    })
}

/**
 * 窗口标签：Tauri 只允许字母数字与 `- / : _`，而寻址键里有 `.`。直接拿寻址键当
 * 标签会直接建不出窗口（`Window labels must only include alphanumeric…`）。
 *
 * 编码要**可逆且不撞车**：`.` 换 `_`、`-` 换 `--`。寻址键本身不含下划线，所以这个
 * 映射是一一对应的 —— 少了可逆性，`a.b` 与 `a_b`…（不可能）与 `a-b` 就会抢同一个
 * 窗口，而窗口是谁的这件事不能靠运气（ADR-018 第 3 条）。
 */
pub fn window_label(provider: &str) -> String {
    let mut encoded = String::with_capacity(provider.len());
    for character in provider.chars() {
        match character {
            '.' => encoded.push('_'),
            '-' => encoded.push_str("--"),
            other => encoded.push(other),
        }
    }
    format!("{WINDOW_PREFIX}{encoded}")
}

/// 窗口 → 寻址键。宿主靠它知道「这个窗口属于谁」，页面说什么都不作数。
#[derive(Default)]
pub struct PluginWindows(Mutex<HashMap<String, String>>);

impl PluginWindows {
    pub fn bind(&self, label: &str, provider: &str) {
        self.0
            .lock()
            .unwrap()
            .insert(label.to_string(), provider.to_string());
    }

    pub fn forget(&self, label: &str) {
        self.0.lock().unwrap().remove(label);
    }

    pub fn provider_of(&self, label: &str) -> Option<String> {
        self.0.lock().unwrap().get(label).cloned()
    }
}

pub fn binding_for(app: &AppHandle, label: &str) -> Option<String> {
    app.try_state::<PluginWindows>()
        .and_then(|windows| windows.provider_of(label))
}

fn text_page(status: StatusCode, body: &str) -> Response<Vec<u8>> {
    build(status, "text/plain; charset=utf-8", body)
}

fn build(status: StatusCode, mime: &str, body: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        // 页面资源不缓存：插件升级后重新开窗就该是新的，否则用户对着旧界面排查。
        .header(header::CACHE_CONTROL, "no-store")
        .header("Content-Security-Policy", PAGE_CSP)
        .body(body.as_bytes().to_vec())
        .unwrap_or_else(|_| {
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(b"ONE could not build the plugin response".to_vec())
                .expect("a response without headers always builds")
        })
}

/**
 * 应答一次资源请求。返回值直接交给 wry，所以这里已经把「插件不在场」翻译成了一
 * 个能读的页面 —— iframe 里显示"日历源没有连上"，比一块空白有用得多。
 */
fn serve(app: &AppHandle, uri: &str) -> Response<Vec<u8>> {
    // 页面加载失败时用户只看到一块空白或一句看不懂的话；这条日志是唯一的现场。
    eprintln!("one: 插件页面请求 {uri}");
    let target = match parse_plugin_uri(uri) {
        Ok(target) => target,
        Err(message) => return text_page(StatusCode::BAD_REQUEST, &format!("ONE 无法打开这个插件页面：{message}")),
    };
    let Some(link) = app.try_state::<CoreLink>() else {
        return text_page(
            StatusCode::SERVICE_UNAVAILABLE,
            "ONE 本体桥接还没准备好，稍后再试。",
        );
    };
    let frame = frames::page_read(&link.next_shell_request(), &target.provider, &target.path);
    let resource = match link.request(frame, PAGE_TIMEOUT) {
        Ok(value) => value,
        Err(failure) => return text_page(status_for(&failure.code), &failure.message),
    };
    let Some(mime) = resource.get("mime").and_then(Value::as_str) else {
        return text_page(
            StatusCode::BAD_GATEWAY,
            "插件给的页面资源不完整，缺少类型。",
        );
    };
    let Some(content) = resource.get("content").and_then(Value::as_str) else {
        return text_page(
            StatusCode::BAD_GATEWAY,
            "插件给的页面资源不完整，缺少内容。",
        );
    };
    build(StatusCode::OK, mime, content)
}

/// 本体的失败原样翻译成状态码，四类不可用要在界面上分开说（ADR-016）。
fn status_for(code: &str) -> StatusCode {
    match code {
        "NOT_FOUND" => StatusCode::NOT_FOUND,
        "UNAVAILABLE" => StatusCode::SERVICE_UNAVAILABLE,
        "PERMISSION_DENIED" | "CONFLICT" => StatusCode::FORBIDDEN,
        "TIMEOUT" => StatusCode::GATEWAY_TIMEOUT,
        _ => StatusCode::BAD_GATEWAY,
    }
}

/**
 * 注册协议必须在建窗**之前**完成：插件页面一加载就会发资源请求，晚一步的话
 * iframe 拿到的是一次失败导航，用户只看到一块空白。
 *
 * 所以这一步挂在 Builder 上而不是 AppHandle 上 —— AppHandle 已经太晚了。
 */
pub fn install(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_asynchronous_uri_scheme_protocol(SCHEME, move |ctx, request, responder| {
        let handle = ctx.app_handle().clone();
        // 必须另起线程：这一段在等本体与插件的往返，堵住它等于堵住所有资源请求。
        thread::spawn(move || {
            let uri = request.uri().to_string();
            responder.respond(serve(&handle, &uri));
        });
    })
}

/// 本体那份「装了什么」。菜单里每一项存在与否都由它决定（ADR-018 的分工）。
///
/// 与 `connected_views` 走同一根管道、同一份真相，所以两次问不会给出互相矛盾的答案。
pub fn installed_ids(app: &AppHandle) -> Vec<String> {
    let Some(link) = app.try_state::<CoreLink>() else {
        return Vec::new();
    };
    let frame = frames::clients_list(&link.next_shell_request());
    let Ok(list) = link.request(frame, ROSTER_TIMEOUT) else {
        return Vec::new();
    };
    list.get("installed")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// 已连上、并且自己申报了页面的参与者。菜单要靠它才知道能开哪些窗口 —— 宿主是唯一
/// 知道「装了什么、谁在跑」的地方（ADR-018 的分工）。
pub fn connected_views(app: &AppHandle) -> Vec<(String, String)> {
    let Some(link) = app.try_state::<CoreLink>() else {
        return Vec::new();
    };
    let frame = frames::clients_list(&link.next_shell_request());
    let Ok(list) = link.request(frame, ROSTER_TIMEOUT) else {
        return Vec::new();
    };
    let Some(participants) = list.get("connected").and_then(Value::as_array) else {
        return Vec::new();
    };
    participants
        .iter()
        .filter(|entry| entry.get("view").is_some())
        .filter_map(|entry| {
            let provider = entry.get("provider")?.as_str()?.to_string();
            let label = entry
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or(&provider)
                .to_string();
            Some((provider, label))
        })
        .collect()
}

/// 已经开着的插件页面窗口。布局仲裁要用它们当障碍物：别的窗口摆到插件页面上面，
/// 插件页面就点不到了（D06）。
pub fn open_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .filter(|window| window.label().starts_with(WINDOW_PREFIX))
        .collect()
}

/// 开一个插件页面窗口。同一个提供方永远只有一个窗口：窗口与 provider 一一对应，
/// 重复点菜单只是把它叫到前面，不会开出第二块屏幕。
pub fn open(app: &AppHandle, provider: &str) -> Result<Value, String> {
    if !is_provider_id(provider) {
        return Err(format!("{provider} 不是合法的寻址键"));
    }
    let label = window_label(provider);
    if let Some(existing) = app.get_webview_window(&label) {
        existing.show().map_err(|error| error.to_string())?;
        existing.unminimize().map_err(|error| error.to_string())?;
        existing.set_focus().map_err(|error| error.to_string())?;
        eprintln!("one: {provider} 的页面窗口已经在，直接叫到前面");
        return Ok(json!({ "label": label, "provider": provider, "reused": true }));
    }
    app.try_state::<PluginWindows>()
        .ok_or("插件窗口还没准备好")?
        .bind(&label, provider);
    WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(provider)
        .inner_size(520.0, 620.0)
        .min_inner_size(360.0, 320.0)
        .build()
        .map_err(|error| {
            // 建不出来就不能留一条绑定，否则下一次同名窗口会以为已经开过了。
            if let Some(windows) = app.try_state::<PluginWindows>() {
                windows.forget(&label);
            }
            error.to_string()
        })?;
    eprintln!("one: 已开 {provider} 的页面窗口（{label}）");
    Ok(json!({ "label": label, "provider": provider, "reused": false }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_keys_match_the_contract() {
        // 字面量写死：Rust 无法 import TS，改错一边就会红。
        // 必须与 packages/contracts/src/wire.ts 的 isProviderId 完全一致。
        for good in ["pet", "local.calendar", "local.notes", "a1", "x-y.z"] {
            assert!(is_provider_id(good), "{good} 应当是合法寻址键");
        }
        for bad in [
            "",
            "Local",
            "1local",
            "local/calendar",
            "local calendar",
            "local..calendar",
            ".local",
            "local.",
            "-local",
            "local_calendar",
            "本地",
        ] {
            assert!(!is_provider_id(bad), "{bad} 不该被当成寻址键");
        }
        assert!(!is_provider_id(&"a".repeat(129)));
    }

    #[test]
    fn reads_a_page_url_the_way_the_host_writes_it() {
        let target = parse_plugin_uri("one-plugin://localhost/local.calendar/calendar.html")
            .expect("插件地址应当被认出来");
        assert_eq!(target.provider, "local.calendar");
        assert_eq!(target.path, "calendar.html");
    }

    #[test]
    fn accepts_nested_paths_but_not_traversal() {
        let nested = parse_plugin_uri("one-plugin://localhost/local.notes/views/day.html")
            .expect("子目录页面应当被认出来");
        assert_eq!(nested.path, "views/day.html");
        for bad in [
            "one-plugin://localhost/local.calendar/../secrets.json",
            "one-plugin://localhost/local.calendar/..\\secrets.json",
            "one-plugin://localhost/Local.Calendar/calendar.html",
            "one-plugin://evil/local.calendar/calendar.html",
            "one-plugin://localhost/local.calendar",
            "one-plugin://localhost/local.calendar/calendar.html?x=1",
            "one-plugin://localhost/local.calendar/calendar.html#a",
            "http://localhost/local.calendar/calendar.html",
        ] {
            assert!(
                parse_plugin_uri(bad).is_err(),
                "{bad} 不该被当成插件地址"
            );
        }
    }

    #[test]
    fn a_plugin_page_cannot_load_anything_over_the_network() {
        // 这是 ADR-018「页面没有网络」的执行处。CSP 改松了，这条会红。
        assert!(PAGE_CSP.contains("default-src 'none'"));
        assert!(!PAGE_CSP.contains("connect-src"));
        assert!(!PAGE_CSP.contains("*"));
        // 页面必须自包含：放行任何外部资源就得靠网络，而网络是被 default-src 挡掉的。
        assert!(PAGE_CSP.contains("script-src 'unsafe-inline'"));
        assert!(PAGE_CSP.contains("style-src 'unsafe-inline'"));
    }

    #[test]
    fn only_the_host_own_origins_may_frame_a_plugin_page() {
        // 少了 frame-ancestors，别的页面就能把它套进自己的 iframe 去探资源存在性。
        let ancestors = PAGE_CSP
            .split_once("frame-ancestors ")
            .expect("CSP 里必须有 frame-ancestors")
            .1;
        assert_eq!(
            ancestors, "http://tauri.localhost http://127.0.0.1:1420",
            "只认宿主自己的两种来源"
        );
    }

    #[test]
    fn provider_failures_keep_their_meaning_in_the_status_code() {
        assert_eq!(status_for("NOT_FOUND"), StatusCode::NOT_FOUND);
        assert_eq!(status_for("UNAVAILABLE"), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(status_for("PERMISSION_DENIED"), StatusCode::FORBIDDEN);
        assert_eq!(status_for("CONFLICT"), StatusCode::FORBIDDEN);
        assert_eq!(status_for("TIMEOUT"), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(status_for("INTERNAL"), StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn a_plugin_window_is_named_after_its_provider() {
        // 标签就是绑定：页面对自己是谁没有发言权，宿主靠窗口知道。
        assert_eq!(window_label("local.calendar"), "plugin-local_calendar");
        let windows = PluginWindows::default();
        windows.bind("plugin-local_calendar", "local.calendar");
        assert_eq!(
            windows.provider_of("plugin-local_calendar").as_deref(),
            Some("local.calendar")
        );
        windows.forget("plugin-local_calendar");
        assert!(windows.provider_of("plugin-local_calendar").is_none());
    }

    #[test]
    fn window_labels_are_legal_and_still_distinguish_providers() {
        // Tauri 拒收带 `.` 的标签（实机踩到：窗口根本建不出来），所以要编码；
        // 编码又不能把两个寻址键挤到同一个窗口上。
        const ALLOWED: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/:_";
        for provider in [
            "local.calendar",
            "local.notes",
            "a-b",
            "a.b-c",
            "a--b",
            "x",
            "y-z.w",
        ] {
            let label = window_label(provider);
            assert!(
                label.chars().all(|character| ALLOWED.contains(character)),
                "{label} 含有 Tauri 不收的字符"
            );
        }
        let labels = [
            window_label("a-b"),
            window_label("a.b"),
            window_label("a--b"),
            window_label("a.b-c"),
        ];
        let unique: std::collections::HashSet<&String> = labels.iter().collect();
        assert_eq!(unique.len(), labels.len(), "两个寻址键抢到了同一个窗口");
    }

    #[test]
    fn every_failure_answers_with_a_readable_page_instead_of_nothing() {
        // 插件不在场 / 路径不合法 / 资源不完整：三种都必须是 4xx/5xx 加一句中文，
        // iframe 里显示得出原因，而不是留一块空白。
        let bad = text_page(StatusCode::BAD_REQUEST, "ONE 无法打开这个插件页面：路径不合法");
        assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
        assert_eq!(bad.headers()[header::CONTENT_TYPE], "text/plain; charset=utf-8");
        assert!(bad.headers().contains_key("Content-Security-Policy"));

        let missing = text_page(StatusCode::SERVICE_UNAVAILABLE, "日历源没有连上");
        assert_eq!(missing.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(!missing.body().is_empty());
    }
}