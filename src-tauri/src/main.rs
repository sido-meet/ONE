#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod core_link;
mod plugin;

use std::time::Duration;

use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem},
    AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const PET: &str = "pet";
const BUBBLE: &str = "bubble";
const SUMMARY: &str = "summary";
const MAIN: &str = "main";
const BEFORE_QUIT: &str = "one:before-quit";
const GAP: i32 = 12;
/// 摘要条收起来时的高度。展开时是 EXPANDED_HEIGHT，面板自己排版。
const SUMMARY_COLLAPSED_HEIGHT: f64 = 96.0;
const SUMMARY_EXPANDED_HEIGHT: f64 = 420.0;
const SUMMARY_WIDTH: f64 = 360.0;
/// Menu item ids. A menu entry without a handler is a button that silently does
/// nothing, so the ids are constants and `menu_action` has to answer for all of
/// them (see the test of the same name).
const LAUNCH_DESKTOP: &str = "launch_desktop";
const LAUNCH_PET: &str = "launch_pet";
const RESTART_CORE: &str = "restart_core";
const PET_BUBBLE: &str = "pet_bubble";
const PET_SUMMARY: &str = "pet_summary";
const PET_SHOW: &str = "pet_show";
const QUIT: &str = "quit";
/// 插件页面菜单项的前缀，后面紧跟寻址键。菜单是每次右键现搭的，所以这些 id
/// 不在常量表里：`menu_action` 靠前缀认出它们，页面由本体与宿主商定，壳不写死。
const PLUGIN_ITEM: &str = "plugin:";

/// What a menu entry does. Clients never spawn each other: launching and asking
/// the pet to do something both go through core, the only thing that knows what
/// is installed and who is connected.
#[derive(Debug, PartialEq, Eq)]
enum MenuAction {
    Launch(&'static str),
    RestartCore,
    PetCapability(&'static str),
    OpenPlugin(String),
    OpenSummary,
    Quit,
}

fn menu_action(id: &str) -> Option<MenuAction> {
    if let Some(provider) = id.strip_prefix(PLUGIN_ITEM) {
        return Some(MenuAction::OpenPlugin(provider.to_string()));
    }
    Some(match id {
        LAUNCH_DESKTOP => MenuAction::Launch("desktop"),
        LAUNCH_PET => MenuAction::Launch("pet"),
        RESTART_CORE => MenuAction::RestartCore,
        PET_BUBBLE => MenuAction::PetCapability(CAP_BUBBLE_OPEN),
        PET_SUMMARY => MenuAction::OpenSummary,
        PET_SHOW => MenuAction::PetCapability(CAP_WINDOW_SHOW),
        QUIT => MenuAction::Quit,
        _ => return None,
    })
}
/// If the host window cannot answer, quitting must not hang the app.
const QUIT_GRACE: Duration = Duration::from_millis(3000);
/// Kept in sync with packages/contracts/src/wire.ts.
const WIRE_VERSION: u32 = 3;

/// 能力名只说做什么，不带实现前缀（ADR-017）。以前是 pet.bubble.open，换实现
/// 就得改调用方；现在由寻址键决定谁提供，壳和界面共用同一份字符串，
/// 由 `capability_names_match_the_contract` 测试守住一致性。
const CAP_STATE_SUMMARY: &str = "state.summary";
const CAP_BUBBLE_OPEN: &str = "bubble.open";
const CAP_WINDOW_SHOW: &str = "window.show";
const CAP_WINDOW_HIDE: &str = "window.hide";
const CAP_CLIENT_LAUNCH: &str = "client.launch";

/// A client is a presentation form, not a different program. The same binary
/// starts as the pet (default) or as the desktop; core owns all the state.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ClientKindArg {
    Pet,
    Desktop,
}

impl ClientKindArg {
    /// 两种传法：命令行参数给已构建的二进制，环境变量给 tauri dev。
    /// 后者是因为 Tauri CLI 会把 `--` 之后的参数错位给 cargo，参数传不进去。
    fn parse() -> Self {
        Self::of_arg(std::env::args().nth(1).as_deref()).unwrap_or_else(|| {
            match std::env::var("ONE_CLIENT").as_deref() {
                Ok("desktop") => Self::Desktop,
                _ => Self::Pet,
            }
        })
    }

    fn of_arg(arg: Option<&str>) -> Option<Self> {
        match arg {
            Some("--client=desktop") | Some("desktop") => Some(Self::Desktop),
            Some("--client=pet") | Some("pet") => Some(Self::Pet),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Pet => "ONE 宠物",
            Self::Desktop => "ONE 桌面端",
        }
    }

    fn wire_name(self) -> &'static str {
        match self {
            Self::Pet => "pet",
            Self::Desktop => "desktop",
        }
    }

    /// What this client offers to the others through core. These names are the
    /// only contract between two clients; core matches them as plain strings.
    ///
    /// 宠物和桌面端共用同一批名字（都有 `window.show`）却不冲突，因为它们是
    /// 两个不同的寻址键。名字里不出现"是谁提供的"，换实现不用改调用方。
    fn capabilities(self) -> &'static [&'static str] {
        match self {
            Self::Pet => &[
                CAP_STATE_SUMMARY,
                CAP_BUBBLE_OPEN,
                CAP_WINDOW_SHOW,
                CAP_WINDOW_HIDE,
            ],
            Self::Desktop => &[
                CAP_STATE_SUMMARY,
                CAP_WINDOW_SHOW,
                CAP_WINDOW_HIDE,
                CAP_CLIENT_LAUNCH,
            ],
        }
    }

    /// The window this client opens for itself. One client, one window; the pet
    /// is the only one that also owns the conversation strip.
    fn primary_window(self) -> &'static str {
        match self {
            Self::Pet => PET,
            Self::Desktop => MAIN,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

fn clamp(value: i32, min: i32, max: i32) -> i32 {
    if max < min {
        return min;
    }
    value.max(min).min(max)
}

/// 附属窗口落在宠物的哪一侧。两者不是随手定的：对话条是被叫出来才出现的，
/// 贴着宠物下方最不挡事；摘要条是常驻的「今天有什么」，压在宠物上面才不会被
/// 宠物本体挡住，而宠物在屏幕角落时上面往往更空。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    Below,
    Above,
}

/// 把一个附属窗口摆到宠物旁边：先落在偏好的一侧，放不下就翻到另一侧，
/// 两边都放不下才夹回工作区里。水平方向永远居中于宠物。
///
/// 这条规则是 D06 布局仲裁的共同底座：四个窗口共用它，才不会出现「对话条会
/// 翻面而摘要条不会」这种各写一份、慢慢走偏的情况。
fn place_beside(
    pet: Rect,
    target: Rect,
    work: Rect,
    gap: i32,
    prefer: Side,
) -> (i32, i32) {
    let x = clamp(
        pet.x + pet.width / 2 - target.width / 2,
        work.x,
        work.x + work.width - target.width,
    );
    let near = pet.y + pet.height + gap;
    let far = pet.y - target.height - gap;
    let (first, second) = match prefer {
        Side::Below => (near, far),
        Side::Above => (far, near),
    };
    let fits_first = match prefer {
        Side::Below => first <= work.y + work.height - target.height,
        Side::Above => first >= work.y,
    };
    let fits_second = match prefer {
        Side::Below => second >= work.y,
        Side::Above => second <= work.y + work.height - target.height,
    };
    let y = if fits_first {
        first
    } else if fits_second {
        second
    } else {
        // 两侧都放不下（工作区比窗口还矮）：夹进去，别让它跑到屏幕外。
        clamp(first, work.y, work.y + work.height - target.height)
    };
    (x, y)
}

/// Puts the bubble under the pet, flipping above when the bottom edge would
/// leave the monitor work area, and always keeps it inside that work area so it
/// never lands off-screen at high DPI, on a second display, or on negative
/// coordinates.
fn place_bubble(pet: Rect, bubble: Rect, work: Rect, gap: i32) -> (i32, i32) {
    place_beside(pet, bubble, work, gap, Side::Below)
}

/// 宠物所在显示器的可用区。拿不到就退回宠物自己那块：宁可摆在宠物旁边，
/// 也不要因为查不到工作区而停在 (0,0) 压住任务栏。
fn work_area_of(app: &AppHandle, pet: &WebviewWindow, pet_rect: Rect) -> Rect {
    pet.current_monitor()
        .ok()
        .flatten()
        .or(app.primary_monitor().ok().flatten())
        .map(|monitor| {
            let area = monitor.work_area();
            Rect {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width as i32,
                height: area.size.height as i32,
            }
        })
        .unwrap_or(Rect {
            x: pet_rect.x,
            y: pet_rect.y,
            width: pet_rect.width,
            height: pet_rect.height,
        })
}

fn outer_rect(window: &WebviewWindow) -> Option<Rect> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(Rect {
        x: position.x,
        y: position.y,
        width: size.width as i32,
        height: size.height as i32,
    })
}

fn show_bubble(app: &AppHandle) -> Result<(), String> {
    let bubble = app
        .get_webview_window(BUBBLE)
        .ok_or("bubble window is missing")?;
    bubble.show().map_err(|error| error.to_string())?;
    if let Some(pet) = app.get_webview_window(PET) {
        if let (Some(pet_rect), Some((width, height))) = (
            outer_rect(&pet),
            bubble.outer_size().ok().map(|size| (size.width as i32, size.height as i32)),
        ) {
            if width > 0 && height > 0 {
                let (x, y) = place_bubble(
                    pet_rect,
                    Rect {
                        x: 0,
                        y: 0,
                        width,
                        height,
                    },
                    work_area_of(app, &pet, pet_rect),
                    GAP,
                );
                bubble
                    .set_position(PhysicalPosition::new(x, y))
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    bubble.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

/// 摘要条默认落在宠物上方；上方放不下（比如宠物贴着屏幕顶端）就翻到下方。
/// 焦点不抢：摘要是常驻的，一弹出来就把焦点抢走会让正在输入的对话条失手。
fn show_summary(app: &AppHandle) -> Result<(), String> {
    let summary = app
        .get_webview_window(SUMMARY)
        .ok_or("summary window is missing")?;
    summary.show().map_err(|error| error.to_string())?;
    if let Some(pet) = app.get_webview_window(PET) {
        if let (Some(pet_rect), Some(size)) = (outer_rect(&pet), summary.outer_size().ok())
        {
            let (x, y) = place_beside(
                pet_rect,
                Rect {
                    x: 0,
                    y: 0,
                    width: size.width as i32,
                    height: size.height as i32,
                },
                work_area_of(app, &pet, pet_rect),
                GAP,
                Side::Above,
            );
            summary
                .set_position(PhysicalPosition::new(x, y))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn open_main(app: AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window(MAIN)
        .ok_or("main window is missing")?;
    main.show().map_err(|error| error.to_string())?;
    main.unminimize().map_err(|error| error.to_string())?;
    main.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn hide_main(app: AppHandle) -> Result<(), String> {
    app.get_webview_window(MAIN)
        .ok_or("main window is missing")?
        .hide()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_bubble(app: AppHandle) -> Result<(), String> {
    show_bubble(&app).inspect_err(|error| eprintln!("one: open_bubble failed: {error}"))
}

#[tauri::command]
fn hide_bubble(app: AppHandle) -> Result<(), String> {
    app.get_webview_window(BUBBLE)
        .ok_or("bubble window is missing")?
        .hide()
        .map_err(|error| {
            eprintln!("one: hide_bubble failed: {error}");
            error.to_string()
        })
}

#[tauri::command]
fn open_summary(app: AppHandle) -> Result<(), String> {
    show_summary(&app).inspect_err(|error| eprintln!("one: open_summary failed: {error}"))
}

#[tauri::command]
fn hide_summary(app: AppHandle) -> Result<(), String> {
    app.get_webview_window(SUMMARY)
        .ok_or("summary window is missing")?
        .hide()
        .map_err(|error| error.to_string())
}

/// 摘要条是展开还是收起。**由窗口高度回答**，不另存一份状态：高度是壳唯一
/// 说了算的东西，界面照着它初始化，两边就不会各记一份然后慢慢走偏
/// （D05 实机踩到：壳按参数把窗口撑高了，界面却还画着收起的样子）。
fn summary_is_expanded(app: &AppHandle) -> bool {
    app.get_webview_window(SUMMARY)
        .and_then(|window| window.outer_size().ok())
        .map(|size| size.height as f64 > SUMMARY_COLLAPSED_HEIGHT)
        .unwrap_or(false)
}

/// 展开与收起改的是**窗口高度**，不是界面里的一个类。窗口不够高，面板会被裁掉
/// 一半 —— 而被裁掉的那一半正好是数据，看起来就像「数据丢了」。改完高度要重新
/// 摆一次位置：贴在宠物上方的那条变高之后，底边才是仍然贴着宠物的那个边。
#[tauri::command]
fn resize_summary(app: AppHandle, expanded: bool) -> Result<(), String> {
    let summary = app
        .get_webview_window(SUMMARY)
        .ok_or("summary window is missing")?;
    let height = if expanded {
        SUMMARY_EXPANDED_HEIGHT
    } else {
        SUMMARY_COLLAPSED_HEIGHT
    };
    summary
        .set_size(tauri::LogicalSize::new(SUMMARY_WIDTH, height))
        .map_err(|error| error.to_string())?;
    // 不给焦点：摘要是常驻的，抢焦点会让正在输入的对话条失手。
    let _ = show_summary(&app);
    Ok(())
}

#[tauri::command]
fn hide_pet(app: AppHandle) -> Result<(), String> {
    app.get_webview_window(PET)
        .ok_or("pet window is missing")?
        .hide()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn show_pet(app: AppHandle) -> Result<(), String> {
    app.get_webview_window(PET)
        .ok_or("pet window is missing")?
        .show()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn start_drag(app: AppHandle, window: WebviewWindow) {
    // Window dragging must happen on the thread that owns the window; a command
    // body runs on the async runtime, so hand the drag over to the main thread.
    let handle = window.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if let Err(error) = handle.start_dragging() {
            eprintln!("one: start_dragging failed: {error}");
        }
    }) {
        eprintln!("one: could not schedule start_dragging: {error}");
    }
}

/// Keyboard equivalent of dragging, in logical pixels so the shell converts them.
#[tauri::command]
fn move_window(window: WebviewWindow, dx: f64, dy: f64) -> Result<(), String> {
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    window
        .set_position(PhysicalPosition::new(
            position.x + (dx * scale).round() as i32,
            position.y + (dy * scale).round() as i32,
        ))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn popup_pet_menu(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    if window.label() != PET {
        return Err("only the pet window shows the pet menu".into());
    }
    let menu = pet_menu(&app).map_err(|error| error.to_string())?;
    // TrackPopupMenu 一直阻塞到菜单被关掉，所以这行日志是"菜单正在显示"，
    // 它的下一行才是"菜单已经关掉了"。排查点不到菜单时先看这里。
    eprintln!("one: 宠物菜单已弹出");
    window.popup_menu(&menu).map_err(|error| {
        eprintln!("one: 宠物菜单没能弹出：{error}");
        error.to_string()
    })
}

/// Lets the frontend catch a renamed or missing command instead of silently
/// doing nothing: every invoke that fails is otherwise invisible to the user.
#[tauri::command]
fn shell_commands() -> Vec<&'static str> {
    vec![
        "open_main",
        "hide_main",
        "open_bubble",
        "hide_bubble",
        "open_summary",
        "hide_summary",
        "resize_summary",
        "hide_pet",
        "show_pet",
        "popup_pet_menu",
        "start_drag",
        "move_window",
        "client_identity",
        "core_status",
        "core_send",
        "core_answer",
        "core_start",
        "core_hello",
        "core_replay",
        "open_plugin_page",
        "close_plugin_window",
        "quit_app",
        "force_quit",
        "shell_commands",
    ]
}

/// `--open-plugin=<provider>`：启动后直接开一个插件页面窗口。
/// 传了非法寻址键就当没传 —— 少开一个窗口比开一个带路径的窗口安全。
fn open_plugin_arg() -> Option<String> {
    let raw = std::env::args()
        .find(|arg| arg.starts_with("--open-plugin="))?
        .split_once('=')?
        .1
        .to_string();
    if plugin::is_provider_id(&raw) {
        Some(raw)
    } else {
        None
    }
}

/// `--open-summary`：启动后直接亮出摘要条。摘要条默认不显示（它一上来就抢注意力），
/// 但验收与调试需要一条不靠鼠标的路 —— 桌面上可能有置顶程序把点击吃掉，
/// 而无边框置顶窗口在 Windows 上常常拿不到键盘焦点（Tab / Enter 同样打不进去）。
fn open_summary_arg() -> bool {
    std::env::args().any(|arg| arg == "--open-summary")
}

/// `--expand-summary`：启动时就把摘要条展开。展开要经壳改窗口高度，因此这是一条
/// 不经过界面的独立验证路径：它成立就说明高度那条路是通的，界面点不开就是输入
/// 没送达，而不是命令没实现。
fn expand_summary_arg() -> bool {
    std::env::args().any(|arg| arg == "--expand-summary")
}

/// Which client this process is, and which window is asking. The renderer asks
/// the shell instead of guessing from the URL: both clients load the same page.
#[tauri::command]
fn client_identity(
    app: AppHandle,
    window: WebviewWindow,
    link: State<'_, core_link::CoreLink>,
    client: State<'_, ClientKind>,
) -> Value {
    let status = link.status();
    // 一个客户端进程里有多个窗口，它们共用同一根管道，因此共用同一个会话。
    // 但对话条只是宠物的另一块屏幕：它要状态，不要能力——否则"请宠物打开对话条"
    // 会被同进程的每个窗口各答一次，靠"谁先回"决定结果。
    let is_view = window.label() != client.primary_window;
    // 插件窗口的身份来自壳的绑定表，不来自窗口自己报的什么：页面的沙箱里连
    // 自己的地址都读不到，宿主必须先知道「这个窗口属于谁」（ADR-018）。
    let plugin_provider = plugin::binding_for(&app, window.label());
    json!({
        "role": status.role,
        "provider": status.provider,
        "label": status.label,
        "capabilities": if is_view { Vec::new() } else { status.capabilities.clone() },
        "wireVersion": status.wire_version,
        "window": window.label(),
        "primaryWindow": client.primary_window,
        // 一根管道只有一次握手（ADR-013：客户端是进程，窗口只是屏幕）。
        // 只有主窗口握手，其余窗口向壳要重放 —— 每个窗口各握一次手的话，
        // 本体只认第一次，后来的窗口会永远停在「正在连接」。
        "windowRole": if is_view { "view" } else { "primary" },
        "pluginProvider": plugin_provider,
        "pluginPageBase": plugin_page_base(),
        // 摘要条按窗口高度回答自己是展开还是收起：高度是壳说了算的，界面照着它
        // 初始化。两边各记一份的话，壳按 --expand-summary 撑高之后界面还在画
        // 收起的样子，看起来就像「展开失灵了」。
        "summaryExpanded": summary_is_expanded(&app),
    })
}

#[tauri::command]
fn core_status(link: State<'_, core_link::CoreLink>) -> core_link::CoreStatus {
    link.status()
}

/// 把 webview 的命令转成协议帧发给本体；本体只认白名单命令。
#[tauri::command]
fn core_send(link: State<'_, core_link::CoreLink>, frame: Value) -> Result<(), String> {
    core_link::send_frame(&link, frame)
}

/// 客户端暴露自己的能力，供另一个客户端通过本体调用。
#[tauri::command]
fn core_answer(link: State<'_, core_link::CoreLink>, frame: Value) -> Result<(), String> {
    core_link::send_frame(&link, frame)
}

/// 第一帧由 webview 发送；这里只把它组装出来，握手时机仍由 webview 决定。
#[tauri::command]
fn core_hello(link: State<'_, core_link::CoreLink>) -> Value {
    let status = link.status();
    json!({
        "t": "hello",
        "v": status.wire_version,
        "client": {
            "role": status.role,
            "provider": status.provider,
            "label": status.label,
            "capabilities": status.capabilities,
        },
    })
}

/// 启动本体。宠物是默认安装的那个客户端，但两端都需要它活着。
#[tauri::command]
fn core_start() -> Result<(), String> {
    core_link::start_core()
}

/// 插件页面在 iframe 里要写的地址前缀（ADR-018）。
///
/// Windows 上 WebView2 不认非标准协议，wry 靠拦截 `http://one-plugin.` 开头的请求
/// 来还原（`custom_protocol_workaround`）。iframe 走的是资源请求，拿 `one-plugin://`
/// 的原地址去匹配匹配不上，页面会安静地什么都不显示 —— 所以要直接给改写后的形式。
/// 这件事只有宿主知道该给哪个，所以由壳告诉界面，而不是界面自己猜平台。
fn plugin_page_base() -> &'static str {
    if cfg!(target_os = "windows") {
        "http://one-plugin.localhost"
    } else {
        "one-plugin://localhost"
    }
}

/// 开一个插件页面窗口。同一个提供方只有一个窗口：重复点只是把它叫到前面。
#[tauri::command]
fn open_plugin_page(app: AppHandle, provider: String) -> Result<Value, String> {
    plugin::open(&app, &provider)
}

/// 插件窗口自己的关闭按钮。绑定要一起清掉，否则标签被复用时会带着上个提供方的身份。
#[tauri::command]
fn close_plugin_window(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let label = window.label().to_string();
    window.close().map_err(|error| error.to_string())?;
    if let Some(windows) = app.try_state::<plugin::PluginWindows>() {
        windows.forget(&label);
    }
    Ok(())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    let main = app.get_webview_window(MAIN);
    if let Some(main) = main {
        if main.is_visible().unwrap_or(false) {
            let _ = app.emit_to(MAIN, BEFORE_QUIT, ());
        }
    }
    let fallback = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(QUIT_GRACE);
        fallback.exit(0);
    });
}

#[tauri::command]
fn force_quit(app: AppHandle) {
    app.exit(0);
}

/// 客户端不共用窗口，但都加载同一份前端。窗口不再写死在 tauri.conf.json 里，
/// 因此这里必须显式指向应用入口：`WebviewUrl::default()` 在没有预配置窗口时
/// 不会解析出可用的地址，开发版能开、发布版只会得到一个"无法访问此页面"。
fn app_url() -> WebviewUrl {
    WebviewUrl::App("index.html".into())
}

fn build_pet_windows(app: &AppHandle) -> Result<(), String> {
    let pet = WebviewWindowBuilder::new(app, PET, app_url())
        .title("ONE")
        .inner_size(128.0, 128.0)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .build()
        .map_err(|error| error.to_string())?;
    WebviewWindowBuilder::new(app, BUBBLE, app_url())
        .title("ONE")
        .inner_size(380.0, 168.0)
        .visible(false)
        // 对话条是浮在桌面上的一条，不是窗口：系统标题栏和菜单栏都不该出现，
        // 关闭和移动由条上的 ✕ 与握把负责。
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .build()
        .map_err(|error| error.to_string())?;
    // 摘要条是常驻的一条，默认先不显示：它一上来就抢注意力，而用户可能只是
    // 想跟 ONE 说句话。右键菜单或宠物菜单里再叫出来。
    WebviewWindowBuilder::new(app, SUMMARY, app_url())
        .title("ONE")
        .inner_size(SUMMARY_WIDTH, SUMMARY_COLLAPSED_HEIGHT)
        .visible(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .build()
        .map_err(|error| error.to_string())?;

    if let Ok(Some(monitor)) = pet.primary_monitor() {
        let area = monitor.work_area();
        let size = pet
            .outer_size()
            .map(|value| (value.width as i32, value.height as i32))
            .unwrap_or((128, 128));
        let x = area.position.x + area.size.width as i32 - size.0 - 48;
        let y = area.position.y + area.size.height as i32 - size.1 - 48;
        let _ = pet.set_position(PhysicalPosition::new(x, y));
    }
    Ok(())
}

fn build_desktop_window(app: &AppHandle) -> Result<(), String> {
    WebviewWindowBuilder::new(app, MAIN, app_url())
        .title("ONE")
        .inner_size(1200.0, 820.0)
        .min_inner_size(760.0, 600.0)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn build_windows(app: &AppHandle, client: ClientKindArg) -> Result<(), String> {
    match client {
        ClientKindArg::Pet => build_pet_windows(app),
        ClientKindArg::Desktop => build_desktop_window(app),
    }
}

/// 宠物的菜单只以右键弹窗出现，右键和键盘（菜单键 / Shift+F10）都走这里。
/// 定义一次给两处用，否则两边的清单迟早走偏。
/// 客户端之间不直接 spawn：启动和请宠物做事都经本体，只有本体知道装了什么、
/// 谁连着。
fn pet_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let launch = MenuItem::with_id(app, LAUNCH_DESKTOP, "打开 ONE 桌面端", true, None::<&str>)?;
    // 菜单每次弹出时现问本体「谁带着页面」。宿主是唯一知道装了什么的角色，
    // 所以没装或没运行的插件这里**不会出现** —— 不拿一个点了打不开的入口充数。
    // 三态的引导归摘要条（ADR-018），菜单只负责在场。
    let plugins: Vec<MenuItem<tauri::Wry>> = plugin::connected_views(app)
        .into_iter()
        .map(|(provider, label)| {
            MenuItem::with_id(
                app,
                format!("{PLUGIN_ITEM}{provider}"),
                format!("打开{label}页面"),
                true,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<_>>()?;
    let restart = MenuItem::with_id(app, RESTART_CORE, "重新启动 ONE 本体", true, None::<&str>)?;
    // 摘要条走壳命令而不是能力调用：它是这只宠物自己的另一块屏幕，不是
    // 另一个参与者的事，也没有第二个进程可以回话。
    let summary = MenuItem::with_id(app, PET_SUMMARY, "今天的摘要", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, "退出", true, None::<&str>)?;
    let mut owned = vec![launch];
    owned.extend(plugins);
    owned.push(summary);
    owned.push(restart);
    owned.push(quit);
    let items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = owned
        .iter()
        .map(|item| item as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect();
    Menu::with_items(app, &items)
}

fn desktop_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let launch = MenuItem::with_id(app, LAUNCH_PET, "启动 ONE 宠物", true, None::<&str>)?;
    let bubble = MenuItem::with_id(app, PET_BUBBLE, "呼出宠物对话条", true, None::<&str>)?;
    let show = MenuItem::with_id(app, PET_SHOW, "显示宠物", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, "退出", true, None::<&str>)?;
    Menu::with_items(app, &[&launch, &bubble, &show, &quit])
}

/// Only the window a client owns itself carries the window menu. Setting it on
/// the app would paint a menu bar inside every window — including the pet's
/// conversation strip, which is a floating bar and must stay frameless.
/// 只有带标题栏的窗口才挂窗口菜单。宠物窗口是无边框透明的，Windows 会把菜单栏
/// 直接画进那 128×128 的客户区里，一直压在宠物身上——它没有右键弹窗就够了。
fn install_menu(app: &AppHandle, client: ClientKindArg) -> tauri::Result<()> {
    if matches!(client, ClientKindArg::Pet) {
        return Ok(());
    }
    let window = app.get_webview_window(ClientKind::of(client).primary_window);
    window
        .map(|window| window.set_menu(desktop_menu(app)?).map(|_| ()))
        .unwrap_or(Ok(()))
}

fn shell_request_id(app: &AppHandle) -> String {
    match app.try_state::<core_link::CoreLink>() {
        Some(link) => link.next_shell_request(),
        None => "shell-unavailable".to_string(),
    }
}

fn launch_through_core(app: &AppHandle, kind: &str) {
    if let Err(error) = core_link::start_core() {
        eprintln!("one: 无法启动本体：{error}");
    }
    let frame = json!({ "t": "clients.launch", "id": shell_request_id(app), "kind": kind });
    if let Err(error) = core_link::send_command(app, frame) {
        eprintln!("one: 请本体拉起 {kind} 失败：{error}");
    }
}

fn call_pet_through_core(app: &AppHandle, capability: &str) {
    let frame = json!({
        "t": "capability.call",
        "id": shell_request_id(app),
        "target": "pet",
        "capability": capability,
    });
    if let Err(error) = core_link::send_command(app, frame) {
        eprintln!("one: 请宠物执行 {capability} 失败：{error}");
    }
}

/// The window this client opens for itself. One client, one window; the pet
/// is the only one that also owns the conversation strip.
///
/// `role` 是标签，`provider` 是寻址键（ADR-017）。目前两个呈现形式恰好同名，
/// 但它们是两件事：领域提供方会是 role = "provider"、provider = "local.calendar"。
#[derive(Clone, Copy)]
struct ClientKind {
    role: &'static str,
    provider: &'static str,
    label: &'static str,
    capabilities: &'static [&'static str],
    primary_window: &'static str,
}

impl ClientKind {
    fn of(client: ClientKindArg) -> Self {
        Self {
            role: client.wire_name(),
            provider: client.wire_name(),
            label: client.label(),
            capabilities: client.capabilities(),
            primary_window: client.primary_window(),
        }
    }
}

fn main() {
    let client = ClientKindArg::parse();
    let identity = ClientKind::of(client);

    // 插件页面的自定义协议必须赶在开窗之前注册好：页面一加载就会请求资源，
    // 晚一步的话 iframe 拿到的是一次失败导航，用户只看到一块空白。
    plugin::install(tauri::Builder::default())
        .manage(identity)
        .manage(plugin::PluginWindows::default())
        .setup(move |app| {
            let handle = app.handle().clone();
            // 顺序很重要。先装好本体桥接，再开窗：窗口一创建，页面就会立刻调用
            // 壳命令；发布版资源是内嵌的，加载比开发版快得多，桥接晚一步就
            // 会让界面拿到 "state not managed"，然后整页空白。
            core_link::start_bridge(
                &handle,
                identity.role,
                identity.provider,
                identity.label,
                identity.capabilities,
                WIRE_VERSION,
            );
            // 本体是默认安装的那一半，客户端保证它活着。再往前挪是为了让"先起
            // 后端、再连接、最后才是界面"成立：本体没起来之前就把窗口摆出来，
            // 用户会先看到一个写着"本体未连接"的宠物。
            if let Err(error) = core_link::start_core() {
                eprintln!("one: 本体没有启动，界面会显示未连接：{error}");
            }
            if let Err(error) = build_windows(&handle, client) {
                eprintln!("one: 创建客户端窗口失败：{error}");
                return Err(error.into());
            }
            if let Err(error) = install_menu(&handle, client) {
                eprintln!("one: 安装菜单失败：{error}");
            }
            // `--open-plugin=<provider>` 直接开一个插件页面。调试插件与验收都
            // 需要一条不靠鼠标的路：页面加载成功与否完全体现在下面的日志里。
            if let Some(provider) = open_plugin_arg() {
                if let Err(error) = plugin::open(&handle, &provider) {
                    eprintln!("one: 打开{provider}的页面失败：{error}");
                }
            }
            if open_summary_arg() {
                if let Err(error) = show_summary(&handle) {
                    eprintln!("one: 摘要条没有打开：{error}");
                }
            }
            // 高度必须**在建窗时**就定下来：界面一挂载就问壳自己多高，
            // 之后再改高度的话那一侧要等下一次身份查询才知道。
            if expand_summary_arg() {
                if let Err(error) = resize_summary(handle.clone(), true) {
                    eprintln!("one: 摘要条没有展开：{error}");
                }
            }
            app.on_menu_event(|app, event| match menu_action(event.id().as_ref()) {
                Some(MenuAction::Launch(kind)) => launch_through_core(app, kind),
                Some(MenuAction::RestartCore) => {
                    if let Err(error) = core_link::start_core() {
                        eprintln!("one: 本体没有启动：{error}");
                    }
                }
                Some(MenuAction::PetCapability(capability)) => {
                    call_pet_through_core(app, capability)
                }
                Some(MenuAction::OpenPlugin(provider)) => {
                    if let Err(error) = plugin::open(app, &provider) {
                        eprintln!("one: 打开{provider}的页面失败：{error}");
                    }
                }
                Some(MenuAction::OpenSummary) => {
                    if let Err(error) = show_summary(app) {
                        eprintln!("one: 摘要条没有打开：{error}");
                    }
                }
                Some(MenuAction::Quit) => quit_app(app.clone()),
                None => {}
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_main,
            hide_main,
            open_bubble,
            hide_bubble,
            open_summary,
            hide_summary,
            resize_summary,
            hide_pet,
            show_pet,
            start_drag,
            move_window,
            popup_pet_menu,
            client_identity,
            core_status,
            core_send,
            core_answer,
            core_hello,
            core_start,
            core_link::core_replay,
            open_plugin_page,
            close_plugin_window,
            quit_app,
            force_quit,
            shell_commands
        ])
        .run(tauri::generate_context!())
        .expect("failed to run ONE client");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_under_the_pet() {
        let (x, y) = place_bubble(
            Rect { x: 1000, y: 100, width: 128, height: 128 },
            Rect { x: 0, y: 0, width: 380, height: 168 },
            Rect { x: 0, y: 0, width: 1920, height: 1040 },
            12,
        );
        assert_eq!(x, 874);
        assert_eq!(y, 240);
    }

    #[test]
    fn flips_above_when_the_bottom_edge_would_leave_the_work_area() {
        let (x, y) = place_bubble(
            Rect { x: 900, y: 900, width: 128, height: 128 },
            Rect { x: 0, y: 0, width: 380, height: 168 },
            Rect { x: 0, y: 0, width: 1920, height: 1040 },
            12,
        );
        assert_eq!(x, 774);
        assert_eq!(y, 720);
    }

    #[test]
    fn keeps_the_window_inside_the_work_area_on_a_second_display() {
        let work = Rect { x: 1920, y: -200, width: 1280, height: 1000 };
        let (x, y) = place_bubble(
            Rect { x: 3100, y: 700, width: 128, height: 128 },
            Rect { x: 0, y: 0, width: 380, height: 168 },
            work,
            12,
        );
        assert!(x >= work.x && x + 380 <= work.x + work.width);
        assert!(y >= work.y && y + 168 <= work.y + work.height);
    }

    #[test]
    fn clamps_a_pet_that_was_dragged_off_the_right_edge() {
        let work = Rect { x: 0, y: 0, width: 1280, height: 800 };
        let (x, y) = place_bubble(
            Rect { x: 1260, y: 600, width: 128, height: 128 },
            Rect { x: 0, y: 0, width: 380, height: 168 },
            work,
            12,
        );
        assert_eq!(x, 900);
        assert_eq!(y, 420);
    }

    #[test]
    fn survives_a_work_area_smaller_than_the_bubble() {
        let (x, y) = place_bubble(
            Rect { x: 10, y: 10, width: 128, height: 128 },
            Rect { x: 0, y: 0, width: 380, height: 168 },
            Rect { x: 0, y: 0, width: 320, height: 200 },
            12,
        );
        assert_eq!((x, y), (0, 32));
    }

    #[test]
    fn the_summary_sits_above_the_pet_and_flips_down_when_it_cannot() {
        // 摘要条是常驻的，压在宠物上面才不会被宠物挡住；宠物贴着屏幕顶端时
        // 上方放不下，就得翻到下面，而不是跑到屏幕外。
        let pet = Rect { x: 1000, y: 300, width: 128, height: 128 };
        let summary = Rect { x: 0, y: 0, width: 360, height: 96 };
        let work = Rect { x: 0, y: 0, width: 1920, height: 1040 };
        assert_eq!(
            place_beside(pet, summary, work, 12, Side::Above),
            (884, 192)
        );
        let low = Rect { x: 1000, y: 40, width: 128, height: 128 };
        assert_eq!(
            place_beside(low, summary, work, 12, Side::Above),
            (884, 180),
            "上方 40 - 96 - 12 < 0，应当翻到下面：40 + 128 + 12 = 180"
        );
    }

    #[test]
    fn the_summary_stays_inside_the_work_area_on_a_second_display() {
        let work = Rect { x: 1920, y: -200, width: 1280, height: 1000 };
        let pet = Rect { x: 3100, y: 700, width: 128, height: 128 };
        let summary = Rect { x: 0, y: 0, width: 360, height: 420 };
        let (x, y) = place_beside(pet, summary, work, 12, Side::Above);
        assert!(x >= work.x && x + 360 <= work.x + work.width);
        assert!(y >= work.y && y + 420 <= work.y + work.height);
    }

    #[test]
    fn the_expanded_summary_is_taller_than_the_collapsed_one() {
        // 展开高度不够的话，被裁掉的正好是数据 —— 看起来就像「日程丢了」。
        assert!(SUMMARY_EXPANDED_HEIGHT > SUMMARY_COLLAPSED_HEIGHT);
        // 收起时要放得下一句话加一行凭据，别一打开就是滚动条。
        assert!(SUMMARY_COLLAPSED_HEIGHT >= 80.0);
    }

    #[test]
    fn both_attached_windows_share_one_placement_rule() {
        // 对话条与摘要条是同一类附属窗口，规则只有一份（place_beside）：放得下就在
        // 偏好的一侧，放不下才翻面，两侧都放不下才夹进工作区。
        let strip = Rect { x: 0, y: 0, width: 360, height: 96 };
        let work = Rect { x: 0, y: 0, width: 1920, height: 1040 };
        // 判定看的是**整条放不放得下**：y = 1040 时底边到 1136，超出工作区 96。
        let low = Rect { x: 900, y: 900, width: 128, height: 128 };
        assert_eq!(
            place_beside(low, strip, work, 12, Side::Below).1,
            792,
            "下面放不下（1040 + 96 > 1040），翻到上面"
        );
        assert_eq!(
            place_beside(low, strip, work, 12, Side::Above).1,
            792,
            "摘要条本来就想在上面，不用翻"
        );
        // 宠物在中间偏上时两者才分得开：下面放得下就往下，摘要条仍然往上。
        let mid = Rect { x: 900, y: 300, width: 128, height: 128 };
        assert_eq!(place_beside(mid, strip, work, 12, Side::Below).1, 440);
        assert_eq!(place_beside(mid, strip, work, 12, Side::Above).1, 192);
    }

    #[test]
    fn every_menu_item_the_menus_declare_has_a_handler() {
        // 菜单项加上去却没接线的后果是"点了没反应"，用户看不出是坏了还是没用。
        for id in [
            LAUNCH_DESKTOP,
            LAUNCH_PET,
            RESTART_CORE,
            PET_BUBBLE,
            PET_SUMMARY,
            PET_SHOW,
            QUIT,
        ] {
            assert!(menu_action(id).is_some(), "菜单项 {id} 没有对应动作");
        }
        assert_eq!(menu_action("没有这个菜单项"), None);
    }

    #[test]
    fn a_plugin_menu_item_carries_its_provider_and_nothing_else() {
        // 菜单项 id 里带寻址键：宿主由此知道要开谁的页面，而**不是**页面告诉
        // 宿主的。id 后面多跟一段（比如伪造一个路径）必须被拒绝。
        assert_eq!(
            menu_action("plugin:local.calendar"),
            Some(MenuAction::OpenPlugin("local.calendar".into()))
        );
        assert_eq!(
            menu_action("plugin:local.calendar/../../etc"),
            Some(MenuAction::OpenPlugin("local.calendar/../../etc".into())),
            "menu_action 只做拆前缀，真正的寻址键校验在开窗那一步"
        );
        assert!(matches!(
            menu_action("plugin:"),
            Some(MenuAction::OpenPlugin(ref empty)) if empty.is_empty()
        ));
        // 但开窗那一步必须挡住它，否则就成了路径穿越的入口。
        assert!(!plugin::is_provider_id("local.calendar/../../etc"));
        assert!(!plugin::is_provider_id(""));
    }

    #[test]
    fn capability_names_carry_no_implementation_prefix() {
        // 能力名只说做什么，不说谁提供（ADR-017）：以前是 pet.bubble.open，
        // 换个实现就得改调用方代码。现在由寻址键决定谁提供。
        let pet = ClientKindArg::Pet.capabilities();
        let desktop = ClientKindArg::Desktop.capabilities();
        for name in pet.iter().chain(desktop.iter()) {
            assert!(
                !name.starts_with("pet.") && !name.starts_with("desktop."),
                "{name} 仍带着实现前缀"
            );
            assert!(name.contains('.'), "{name} 应当形如 `bubble.open`");
        }

        // 同一个客户端内部不能重名：本体按字符串匹配，重名会歧义。
        for list in [pet, desktop] {
            let mut sorted = list.to_vec();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(sorted.len(), list.len(), "同一客户端重复声明了能力");
        }

        // 宠物和桌面端声明同名能力是正常的 —— 它们是两个不同的寻址键。
        let shared: Vec<&&str> = pet.iter().filter(|n| desktop.contains(n)).collect();
        assert_eq!(shared.len(), 3, "预期共有三个同名能力");

        // 字面量写死在这里：Rust 无法 import TS，改错一边就会红。
        // 必须与 packages/contracts/src/wire.ts 的 CAPABILITY 完全一致。
        assert_eq!(
            pet,
            &["state.summary", "bubble.open", "window.show", "window.hide"]
        );
        assert_eq!(
            desktop,
            &[
                "state.summary",
                "window.show",
                "window.hide",
                "client.launch"
            ]
        );
    }

    #[test]
    fn each_client_owns_its_own_primary_window() {
        // 客户端互不共享窗口：桌面端没有宠物窗口，宠物也没有主窗口。
        assert_eq!(ClientKindArg::Pet.primary_window(), PET);
        assert_eq!(ClientKindArg::Desktop.primary_window(), MAIN);
    }

    #[test]
    fn the_client_kind_is_carried_by_env_or_arg_not_by_a_url() {
        // tauri dev 传不进命令行参数，所以两种传法必须指向同一个客户端种类。
        assert_eq!(ClientKindArg::of_arg(Some("--client=desktop")), Some(ClientKindArg::Desktop));
        assert_eq!(ClientKindArg::of_arg(Some("desktop")), Some(ClientKindArg::Desktop));
        assert_eq!(ClientKindArg::of_arg(Some("--client=pet")), Some(ClientKindArg::Pet));
        assert_eq!(ClientKindArg::of_arg(Some("whatever")), None);
    }
}
