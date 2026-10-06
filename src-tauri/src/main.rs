#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod core_link;

use std::time::Duration;

use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem},
    AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const PET: &str = "pet";
const BUBBLE: &str = "bubble";
const MAIN: &str = "main";
const BEFORE_QUIT: &str = "one:before-quit";
const GAP: i32 = 12;
/// Menu item ids. A menu entry without a handler is a button that silently does
/// nothing, so the ids are constants and `menu_action` has to answer for all of
/// them (see the test of the same name).
const LAUNCH_DESKTOP: &str = "launch_desktop";
const LAUNCH_PET: &str = "launch_pet";
const RESTART_CORE: &str = "restart_core";
const PET_BUBBLE: &str = "pet_bubble";
const PET_SHOW: &str = "pet_show";
const QUIT: &str = "quit";

/// What a menu entry does. Clients never spawn each other: launching and asking
/// the pet to do something both go through core, the only thing that knows what
/// is installed and who is connected.
#[derive(Debug, PartialEq, Eq)]
enum MenuAction {
    Launch(&'static str),
    RestartCore,
    PetCapability(&'static str),
    Quit,
}

fn menu_action(id: &str) -> Option<MenuAction> {
    Some(match id {
        LAUNCH_DESKTOP => MenuAction::Launch("desktop"),
        LAUNCH_PET => MenuAction::Launch("pet"),
        RESTART_CORE => MenuAction::RestartCore,
        PET_BUBBLE => MenuAction::PetCapability(CAP_BUBBLE_OPEN),
        PET_SHOW => MenuAction::PetCapability(CAP_WINDOW_SHOW),
        QUIT => MenuAction::Quit,
        _ => return None,
    })
}
/// If the host window cannot answer, quitting must not hang the app.
const QUIT_GRACE: Duration = Duration::from_millis(3000);
/// Kept in sync with packages/contracts/src/wire.ts.
const WIRE_VERSION: u32 = 2;

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

/// Puts the bubble under the pet, flipping above when the bottom edge would
/// leave the monitor work area, and always keeps it inside that work area so it
/// never lands off-screen at high DPI, on a second display, or on negative
/// coordinates.
fn place_bubble(pet: Rect, bubble: Rect, work: Rect, gap: i32) -> (i32, i32) {
    let x = clamp(
        pet.x + pet.width / 2 - bubble.width / 2,
        work.x,
        work.x + work.width - bubble.width,
    );
    let below = pet.y + pet.height + gap;
    let above = pet.y - bubble.height - gap;
    let bottom_limit = work.y + work.height - bubble.height;
    let y = if below <= bottom_limit {
        below
    } else if above >= work.y {
        above
    } else {
        clamp(below, work.y, bottom_limit)
    };
    (x, y)
}

fn show_bubble(app: &AppHandle) -> Result<(), String> {
    let bubble = app
        .get_webview_window(BUBBLE)
        .ok_or("bubble window is missing")?;
    bubble.show().map_err(|error| error.to_string())?;
    if let Some(pet) = app.get_webview_window(PET) {
        let pet_rect = pet.outer_position().ok().and_then(|position| {
            pet.outer_size().ok().map(|size| Rect {
                x: position.x,
                y: position.y,
                width: size.width as i32,
                height: size.height as i32,
            })
        });
        let bubble_size = bubble
            .outer_size()
            .ok()
            .map(|size| (size.width as i32, size.height as i32));
        if let (Some(pet_rect), Some((width, height))) = (pet_rect, bubble_size) {
            if width > 0 && height > 0 {
                let work = pet
                    .current_monitor()
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
                    });
                let (x, y) = place_bubble(
                    pet_rect,
                    Rect {
                        x: 0,
                        y: 0,
                        width,
                        height,
                    },
                    work,
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
        "quit_app",
        "force_quit",
        "shell_commands",
    ]
}

/// Which client this process is, and which window is asking. The renderer asks
/// the shell instead of guessing from the URL: both clients load the same page.
#[tauri::command]
fn client_identity(
    window: WebviewWindow,
    link: State<'_, core_link::CoreLink>,
    client: State<'_, ClientKind>,
) -> Value {
    let status = link.status();
    // 一个客户端进程里有多个窗口，它们共用同一根管道，因此共用同一个会话。
    // 但对话条只是宠物的另一块屏幕：它要状态，不要能力——否则"请宠物打开对话条"
    // 会被同进程的每个窗口各答一次，靠"谁先回"决定结果。
    let is_view = window.label() != client.primary_window;
    json!({
        "role": status.role,
        "provider": status.provider,
        "label": status.label,
        "capabilities": if is_view { Vec::new() } else { status.capabilities.clone() },
        "wireVersion": status.wire_version,
        "window": window.label(),
        "primaryWindow": client.primary_window,
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
    let restart = MenuItem::with_id(app, RESTART_CORE, "重新启动 ONE 本体", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, "退出", true, None::<&str>)?;
    Menu::with_items(app, &[&launch, &restart, &quit])
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

    tauri::Builder::default()
        .manage(identity)
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
    fn every_menu_item_the_menus_declare_has_a_handler() {
        // 菜单项加上去却没接线的后果是"点了没反应"，用户看不出是坏了还是没用。
        for id in [
            LAUNCH_DESKTOP,
            LAUNCH_PET,
            RESTART_CORE,
            PET_BUBBLE,
            PET_SHOW,
            QUIT,
        ] {
            assert!(menu_action(id).is_some(), "菜单项 {id} 没有对应动作");
        }
        assert_eq!(menu_action("没有这个菜单项"), None);
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
