#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod core_link;
mod frames;
mod layout;
mod plugin;
mod proxy;

use std::sync::Arc;
use std::time::Duration;

use layout::{Placement, Rect, Side};
use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem, Submenu},
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
/// 对话条平时是一条状态云加一条输入条。**有待确认的日程草稿时换高**——
/// 卡片连同两个按钮比状态云高得多，硬塞进 168 会把输入条切掉一半，而切掉的
/// 正好是用户要打字的那一半（实机抓图看到的）。
const BUBBLE_WIDTH: f64 = 380.0;
const BUBBLE_HEIGHT: f64 = 168.0;
/// 露出结果卡时：比平时高一点，因为卡片的「没写进去：……」理由可能要折两行。
const BUBBLE_CARD_HEIGHT: f64 = 208.0;
/// 露出带按钮的待确认卡片时：按钮加一行时间，比结果卡再高一截。
const BUBBLE_ACTION_HEIGHT: f64 = 262.0;
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
const WIRE_VERSION: u32 = 5;

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

/// 附属窗口的跟随节奏（D06）。
///
/// 拖动时每像素都重排会让窗口抖成一片，而只节流不补发的话，松手那一刻的落点会
/// 永远停在半路上。所以：**记下最后一次移动的时刻**，后台每 `POLL_INTERVAL`
/// 看一次，连着 `FOLLOW_SETTLE` 没有新移动就排一次版 —— 拖动途中低频跟随，
/// 停下后必然补上最终位置。
#[derive(Clone, Default)]
struct Follower(Arc<FollowState>);

#[derive(Default)]
struct FollowState {
    last: std::sync::Mutex<Option<std::time::Instant>>,
    waiting: std::sync::atomic::AtomicBool,
}

/// 后台多久看一眼。60ms：短到跟上拖动，长到不会空转。
const POLL_INTERVAL: Duration = Duration::from_millis(60);
/// 手停多久算停了。短到几乎察觉不到，长到不会在缓慢拖动时每动一点就重排一次。
const FOLLOW_SETTLE: Duration = Duration::from_millis(140);

impl Follower {
    fn note(&self) {
        *self.0.last.lock().unwrap() = Some(std::time::Instant::now());
    }

    /// 已经有人在等了吗？**是就别再起一个** —— 每个 `Moved` 事件都来一次，
    /// 不设闸的话拖动一次会起几百个线程。
    fn waiter_running(&self) -> bool {
        self.0
            .waiting
            .swap(true, std::sync::atomic::Ordering::SeqCst)
    }

    /// 手停够了吗？停够了就顺带交出「等待权」，让下一次拖动能再起一个线程。
    fn settle(&self) -> Settle {
        let settled = self
            .0
            .last
            .lock()
            .unwrap()
            .map(|at| at.elapsed() >= FOLLOW_SETTLE)
            .unwrap_or(true);
        if !settled {
            return Settle::Wait;
        }
        *self.0.last.lock().unwrap() = None;
        self.0
            .waiting
            .store(false, std::sync::atomic::Ordering::SeqCst);
        Settle::Now
    }
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
            Rect::new(
                area.position.x,
                area.position.y,
                area.size.width as i32,
                area.size.height as i32,
            )
        })
        .unwrap_or(pet_rect)
}

fn outer_rect(window: &WebviewWindow) -> Option<Rect> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(Rect::new(
        position.x,
        position.y,
        size.width as i32,
        size.height as i32,
    ))
}

/// 附属窗口的**唯一**摆法（D06）。对话条、摘要条、以及用户自己打开的插件页面
/// 都在这里落位，因此不会出现「对话条会避让而摘要条不会」这种各写一份的情况。
///
/// 三步：把可见的附属窗口连同尺寸交给 `layout::arrange` 排（同侧首尾相接，翻面，
/// 夹回工作区）；再把撞上插件页面的挪到候选位置里第一个空着的；最后落位。
/// 插件页面是用户自己放的，**不去动它**，只让别的窗口绕开。
fn relayout(app: &AppHandle) -> Result<(), String> {
    let pet = app
        .get_webview_window(PET)
        .ok_or("pet window is missing")?;
    let pet_rect = outer_rect(&pet).ok_or("pet window has no size yet")?;
    let work = work_area_of(app, &pet, pet_rect);

    // 只有可见的窗口参与排布。隐藏的对话条不该把摘要条挤到别处 —— 它下一刻
    // 可能才被叫出来，而那时它该落在它自己的偏好位置上。
    let mut items = Vec::new();
    let mut plugin_windows = Vec::new();
    for (label, prefer) in [(BUBBLE, Side::Below), (SUMMARY, Side::Above)] {
        let Some(window) = app.get_webview_window(label) else {
            continue;
        };
        if !window.is_visible().unwrap_or(false) {
            continue;
        }
        let Ok(size) = window.outer_size() else {
            continue;
        };
        let (width, height) = (size.width as i32, size.height as i32);
        if width <= 0 || height <= 0 {
            continue;
        }
        items.push(Placement::new(label, width, height, prefer));
    }
    for window in plugin::open_windows(app) {
        if let Some(rect) = outer_rect(&window) {
            plugin_windows.push(rect);
        }
    }

    let planned = layout::arrange(pet_rect, &items, work, GAP);
    let mut placed: Vec<Rect> = Vec::new();
    for target in planned {
        let Some(item) = items
            .iter()
            .find(|candidate| candidate.label == target.label)
        else {
            continue;
        };
        let Some(window) = app.get_webview_window(target.label) else {
            continue;
        };
        // 摆在用户放好的插件页面上，两个都点不到。绕开它，而不是把它挪走 ——
        // 那是用户自己放的位置。
        let mut blockers: Vec<Rect> = plugin_windows.clone();
        blockers.extend(placed.iter().copied());
        let intent = Placement::new(
            target.label,
            item.width,
            item.height,
            item.prefer,
        );
        let at = layout::first_free(
            &layout::candidates_around(pet_rect, &intent, work, GAP),
            &blockers,
            work,
        )
        .unwrap_or(Rect::new(target.x, target.y, item.width, item.height));
        window
            .set_position(PhysicalPosition::new(at.x, at.y))
            .map_err(|error| error.to_string())?;
        placed.push(at);
    }
    Ok(())
}

fn show_bubble(app: &AppHandle) -> Result<(), String> {
    let bubble = app
        .get_webview_window(BUBBLE)
        .ok_or("bubble window is missing")?;
    bubble.show().map_err(|error| error.to_string())?;
    relayout(app)?;
    bubble.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

/// 对话条换高。**和摘要条一样，改的是窗口高度而不是界面的一个类**：
/// 窗口不够高，被切掉的正是内容 —— 而对话条被切掉的那一半恰好是输入框，
/// 看上去就像「ONE 突然不能打字了」。
///
/// 三档而不是一个布尔：待确认卡片带按钮，结果卡不带，两者差着一行。塞进同一
/// 档的话，要么结果卡下面空一大块，要么带按钮那张被切掉 —— 实机两种都拍到过。
///
/// 改完要重新仲裁整组：变高之后它可能占掉摘要条的位置，也可能自己放不下。
/// 只挪自己一个，会留下一个压在它上面的摘要条（ADR-020 的同一条纪律）。
#[tauri::command]
fn resize_bubble(app: AppHandle, mode: String) -> Result<(), String> {
    let height = match mode.as_str() {
        "normal" => BUBBLE_HEIGHT,
        "card" => BUBBLE_CARD_HEIGHT,
        "action" => BUBBLE_ACTION_HEIGHT,
        other => return Err(format!("未知的对话条高度：{other}")),
    };
    let bubble = app
        .get_webview_window(BUBBLE)
        .ok_or("bubble window is missing")?;
    bubble
        .set_size(tauri::LogicalSize::new(BUBBLE_WIDTH, height))
        .map_err(|error| error.to_string())?;
    relayout(&app).inspect_err(|error| eprintln!("one: 改完对话条高度摆不好：{error}"))?;
    Ok(())
}

/// 摘要条落位。焦点不抢：摘要是常驻的，一弹出来就把焦点抢走会让正在输入的
/// 对话条失手。
fn show_summary(app: &AppHandle) -> Result<(), String> {
    app.get_webview_window(SUMMARY)
        .ok_or("summary window is missing")?
        .show()
        .map_err(|error| error.to_string())?;
    relayout(app)
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
///
/// 比的是**物理高度**。`set_size` 收的是逻辑像素而 `outer_size` 回的是物理像素，
/// 直接拿 96 这个逻辑常量去比，150% 的屏上会永远判成「已展开」—— 收起的摘要条
/// 会被画成展开的样子，看着像面板被压扁了。
fn summary_is_expanded(app: &AppHandle) -> bool {
    let Some(window) = app.get_webview_window(SUMMARY) else {
        return false;
    };
    let Ok(size) = window.outer_size() else {
        return false;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    // 两者之间那个 1.5 才是判据：收起是 96，展开是 420，差得很开。
    size.height as f64 > SUMMARY_COLLAPSED_HEIGHT * scale * 1.5
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
    // 重新仲裁整组：变高之后它可能占掉对话条的位置，也可能自己放不下了。
    // 只挪自己一个会留下一个压在它上面的对话条。
    relayout(&app).inspect_err(|error| eprintln!("one: 改完摘要高度摆不好：{error}"))?;
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
fn move_window(app: AppHandle, window: WebviewWindow, dx: f64, dy: f64) -> Result<(), String> {
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    window
        .set_position(PhysicalPosition::new(
            position.x + (dx * scale).round() as i32,
            position.y + (dy * scale).round() as i32,
        ))
        .map_err(|error| error.to_string())?;
    // 键盘移动宠物同样要带附属窗口：方向键连按十下之后，对话条还留在原处，
    // 看着就像它没跟着动。
    follow_pet(&app);
    Ok(())
}

/// 宠物被拖动时，附属窗口要不要跟。
///
/// 拖动过程中每像素都重排会让窗口抖成一片（D06 实机可见），所以只**记下**
/// 这次移动，等手停下来再排一次：停手 140ms 之后必然补上一次最终位置。
/// 只做节流不做补发的话，松手那一刻的落点会永远停在半路上。
fn follow_pet(app: &AppHandle) {
    let Some(state) = app.try_state::<Follower>() else {
        // 没有状态（理论上不会发生）就直接排一次，总比完全不跟强。
        let _ = relayout(app);
        return;
    };
    // 克隆的是内部那个 Arc，线程要用 'static 的那份 —— 不能借用 State。
    let state = state.inner().clone();
    state.note();
    if state.waiter_running() {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(POLL_INTERVAL);
            // 还没静够就**继续等**，而不是退出 —— 这里曾经写反过：不静够
            // 直接 break，于是后台线程在 note 之后的第一个 tick 就退了，
            // 拖动跟随一次都不发生（实机抓到：日志有「宠物移动了」，但一次
            // 仲裁都没发生，附属窗口原地不动）。
            match state.settle() {
                Settle::Wait => continue,
                Settle::Now => {
                    if let Err(error) = relayout(&handle) {
                        eprintln!("one: 宠物动过之后没摆好附属窗口：{error}");
                    }
                    return;
                }
            }
        }
    });
}

/// 手停够了吗。这个区分必须有：**「还没停」是继续等，「停了」是排版收工**，
/// 两件事撞在一个布尔上就会写反（实机踩过）。
#[derive(Debug, PartialEq, Eq)]
enum Settle {
    Wait,
    Now,
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
            "resize_bubble",
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

/// `--open-bubble`：启动后直接亮出对话条。摘要条有 `--open-summary` 配对，
/// 三条附属窗口同时在场的布局（互不遮挡）才能在验收时被看见 —— 而「都在」正是
/// 那种布局最需要被看见的时候。
fn open_bubble_arg() -> bool {
    std::env::args().any(|arg| arg == "--open-bubble")
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
    frames::hello(
        status.wire_version,
        &status.role,
        &status.provider,
        &status.label,
        &status.capabilities,
    )
}

/// 启动本体。宠物是默认安装的那个客户端，但两端都需要它活着。
#[tauri::command]
fn core_start(app: AppHandle) -> Result<(), String> {
    core_link::start_core(&app)
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
        .inner_size(BUBBLE_WIDTH, BUBBLE_HEIGHT)
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
/// 菜单上的一项：id 决定点了做什么，label 是用户看到的中文。
struct Entry {
    id: String,
    label: String,
}

/// 宠物菜单**先定清单，再照清单造菜单**。分两步只为让清单本身能测 —— 它不需要
/// AppHandle，也不需要管道，就是几个字符串。
///
/// 「点了没反应」是这个菜单上一路挖出来的洞（实机）：「打开 ONE 桌面端」原来是无条件
/// 给的，而 `desktop` 默认不在安装清单里 —— 本体于是每次都诚实回答「desktop 还没有
/// 安装」，界面上只剩一片沉默。它跟插件项受同一条规矩：装了才给入口，
/// `core install desktop` 之后它就出现了。
fn pet_menu_entries(installed: &[String], views: &[(String, String)]) -> Vec<Entry> {
    let mut entries: Vec<Entry> = Vec::new();
    if installed.iter().any(|id| id == "desktop") {
        entries.push(Entry {
            id: LAUNCH_DESKTOP.into(),
            label: "打开 ONE 桌面端".into(),
        });
    }
    for (provider, label) in views {
        entries.push(Entry {
            id: format!("{PLUGIN_ITEM}{provider}"),
            label: format!("打开{label}页面"),
        });
    }
    entries.push(Entry {
        id: PET_SUMMARY.into(),
        label: "今天的摘要".into(),
    });
    entries.push(Entry {
        id: RESTART_CORE.into(),
        label: "重新启动 ONE 本体".into(),
    });
    entries.push(Entry {
        id: QUIT.into(),
        label: "退出".into(),
    });
    entries
}

fn pet_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    // 菜单每次弹出时现问本体「装了什么、谁在跑」。宿主是唯一知道装了什么的角色，
    // 所以没装或没运行的插件这里**不会出现** —— 不拿一个点了打不开的入口充数。
    // 三态的引导归摘要条（ADR-018），菜单只负责在场。
    let entries = pet_menu_entries(&plugin::installed_ids(app), &plugin::connected_views(app));
    let owned: Vec<MenuItem<tauri::Wry>> = entries
        .into_iter()
        .map(|entry| MenuItem::with_id(app, entry.id.as_str(), entry.label.as_str(), true, None::<&str>))
        .collect::<tauri::Result<_>>()?;
    let items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = owned
        .iter()
        .map(|item| item as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect();
    Menu::with_items(app, &items)
}

/**
 * 桌面端的窗口菜单栏。
 *
 * **顶层必须是 `Submenu`。** 实机挖出来的：原来这里直接摆四个 `MenuItem`，菜单栏
 * 照画不误（截图里四个字都在），但**一个字都点不动**。原因是 muda 只给子菜单插
 * `MF_POPUP`，普通项插的是 `MF_STRING`（muda `platform_impl/windows/mod.rs`
 * `attach_item`）—— 菜单栏上的项必须是弹窗，点击才会开下拉；不是弹窗的项只会被
 * 画出来，不会有任何反应。
 *
 * 宠物的右键菜单不受影响：那是**弹出菜单**，普通项在弹出菜单里本来就是对的。
 * 同一份 `Menu` 用在哪，决定了它该由什么组成 —— 这也是它当初看起来没问题的地方。
 *
 * 所以这里收成一个「ONE」下拉，四条命令都放进去。
 */
fn desktop_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let launch = MenuItem::with_id(app, LAUNCH_PET, "启动 ONE 宠物", true, None::<&str>)?;
    let bubble = MenuItem::with_id(app, PET_BUBBLE, "呼出宠物对话条", true, None::<&str>)?;
    let show = MenuItem::with_id(app, PET_SHOW, "显示宠物", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, "退出", true, None::<&str>)?;
    let one = Submenu::with_items(app, "ONE", true, &[&launch, &bubble, &show, &quit])?;
    Menu::with_items(app, &[&one])
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
    if let Err(error) = core_link::start_core(app) {
        eprintln!("one: 无法启动本体：{error}");
    }
    let frame = frames::clients_launch(&shell_request_id(app), kind);
    if let Err(error) = core_link::send_command(app, frame) {
        eprintln!("one: 请本体拉起 {kind} 失败：{error}");
    }
}

fn call_pet_through_core(app: &AppHandle, capability: &str) {
    let frame = frames::capability_call(&shell_request_id(app), "pet", capability);
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
        .manage(Follower::default())
        .manage(core_link::CoreProcess::new())
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
            if let Err(error) = core_link::start_core(&handle) {
                eprintln!("one: 本体没有启动，界面会显示原因：{error}");
            }
            if let Err(error) = build_windows(&handle, client) {
                eprintln!("one: 创建客户端窗口失败：{error}");
                return Err(error.into());
            }
            if let Err(error) = install_menu(&handle, client) {
                eprintln!("one: 安装菜单失败：{error}");
            }
            // 鼠标拖宠物时，附属窗口要跟。方向键那条路走 move_window 命令，
            // 鼠标这条只能靠窗口移动事件 —— 拖动是系统做的，我们收不到命令。
            let follow = handle.clone();
            if let Some(pet) = handle.get_webview_window(PET) {
                pet.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Moved(_)) {
                        eprintln!("one: 宠物移动了，重新摆附属窗口");
                        follow_pet(&follow);
                    }
                });
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
            // 顺序有讲究：对话条在摘要条**之后**开，仲裁才会看到两个都在场。
            // 那是「不互相遮挡」唯一有意义的时刻 —— 只开一个时它无处可撞。
            if open_bubble_arg() {
                if let Err(error) = show_bubble(&handle) {
                    eprintln!("one: 对话条没有打开：{error}");
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
                    if let Err(error) = core_link::restart_core(app) {
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
            resize_bubble,
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
        .build(tauri::generate_context!())
        .expect("failed to build ONE client")
        .run(|app, event| {
            // 退出的**唯一**收口。放在这里而不是 `quit_app` 里，是因为退出有好几条路
            // （菜单、界面关窗、界面取消完 Run 后强退），每条都自己记得清理一次，
            // 迟早漏一条 —— 而漏掉的那条就是用户下次开机发现本体还在后台。
            if let tauri::RunEvent::Exit = event {
                core_link::stop_core(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn the_follower_waits_for_the_hand_to_stop_before_it_lays_out() {
        // 拖动跟随的判据（实机抓到的坑就在这里）：
        // 「还没停」是**继续等**，「停了」才排版收工。这两件事一旦撞进一个
        // 布尔值就会写反 —— 反了之后后台线程在第一次 tick 就退出，
        // 日志里看得见「宠物移动了」，却一次仲裁都没发生。
        let follower = Follower::default();
        follower.note();
        assert_eq!(follower.settle(), Settle::Wait, "刚动过就说不稳");
        assert!(!follower.waiter_running(), "第一次来的人起线程");
        assert!(follower.waiter_running(), "别再起第二个线程");
        std::thread::sleep(FOLLOW_SETTLE + std::time::Duration::from_millis(30));
        assert_eq!(follower.settle(), Settle::Now, "停够了就该排版");
        assert!(
            !follower.waiter_running(),
            "排完把等待权交出去，下一次拖动能再起线程"
        );
    }

    #[test]
    fn settling_takes_longer_than_one_poll_tick() {
        // 60ms 一查、140ms 才算停：至少查两轮才可能停。太近的话慢速拖动
        // 时会每动一点就重排一次，窗口抖成一片。
        assert!(POLL_INTERVAL < FOLLOW_SETTLE);
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
    fn the_pet_menu_only_offers_entrances_that_are_actually_installed() {
        // 实机挖出来的洞：「打开 ONE 桌面端」原来是无条件给的，而 desktop 默认不在
        // 安装清单里，点下去本体每次都答「还没有安装」—— 界面上只剩点了没反应。
        let ids = |installed: &[&str], views: &[(&str, &str)]| {
            let installed: Vec<String> = installed.iter().map(|s| s.to_string()).collect();
            let views: Vec<(String, String)> = views
                .iter()
                .map(|(provider, label)| (provider.to_string(), label.to_string()))
                .collect();
            pet_menu_entries(&installed, &views)
                .into_iter()
                .map(|entry| entry.id)
                .collect::<Vec<_>>()
        };
        let views = [("local.calendar", "本地日历"), ("local.notes", "本地笔记")];

        assert_eq!(
            ids(&["local.calendar", "local.notes", "pet"], &views),
            vec![
                format!("{PLUGIN_ITEM}local.calendar"),
                format!("{PLUGIN_ITEM}local.notes"),
                PET_SUMMARY.to_string(),
                RESTART_CORE.to_string(),
                QUIT.to_string(),
            ],
            "没装 desktop 时菜单里不该出现「打开 ONE 桌面端」"
        );

        let with_desktop = [
            "local.calendar",
            "local.notes",
            "pet",
            "desktop",
        ];
        assert_eq!(
            ids(&with_desktop, &views)[0],
            LAUNCH_DESKTOP,
            "装上 desktop 之后入口就该出现（core install desktop）"
        );

        // 问不到清单（本体没起来）时同样不给：宁可少一个入口，不要一个打不开的。
        assert!(!ids(&[], &views).contains(&LAUNCH_DESKTOP.to_string()));
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
