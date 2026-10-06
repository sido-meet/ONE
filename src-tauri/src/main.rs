#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow,
};

const PET: &str = "pet";
const BUBBLE: &str = "bubble";
const MAIN: &str = "main";
const BEFORE_QUIT: &str = "one:before-quit";
const GAP: i32 = 12;
/// If the host window cannot answer, quitting must not hang the app.
const QUIT_GRACE: Duration = Duration::from_millis(3000);

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

/// Puts the bubble next to the pet: above by default, below when there is no
/// room, and always inside the monitor work area so it never lands off-screen
/// at high DPI, on a second display, or on negative coordinates.
fn place_bubble(pet: Rect, bubble: Rect, work: Rect, gap: i32) -> (i32, i32) {
    let x = clamp(
        pet.x + pet.width / 2 - bubble.width / 2,
        work.x,
        work.x + work.width - bubble.width,
    );
    let above = pet.y - bubble.height - gap;
    let below = pet.y + pet.height + gap;
    let bottom_limit = work.y + work.height - bubble.height;
    let y = if above >= work.y {
        above
    } else if below <= bottom_limit {
        below
    } else {
        clamp(below, work.y, bottom_limit)
    };
    (x, y)
}

fn open_bubble(app: &AppHandle) -> Result<(), String> {
    let bubble = app
        .get_webview_window(BUBBLE)
        .ok_or("bubble window is missing")?;
    bubble.show().map_err(|error| error.to_string())?;
    if let Some(pet) = app.get_webview_window(PET) {
        let pet_rect = pet
            .outer_position()
            .and_then(|position| {
                pet.outer_size().map(|size| Rect {
                    x: position.x,
                    y: position.y,
                    width: size.width as i32,
                    height: size.height as i32,
                })
            })
            .ok();
        let bubble_size = bubble
            .outer_size()
            .map(|size| (size.width as i32, size.height as i32))
            .ok();
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
fn open_bubble_window(app: AppHandle) -> Result<(), String> {
    open_bubble(&app)
}

#[tauri::command]
fn hide_bubble(app: AppHandle) -> Result<(), String> {
    app.get_webview_window(BUBBLE)
        .ok_or("bubble window is missing")?
        .hide()
        .map_err(|error| error.to_string())
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
fn start_drag(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn popup_pet_menu(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    if window.label() != PET {
        return Err("only the pet window shows the pet menu".into());
    }
    let open_item = MenuItem::with_id(&app, "open_main", "打开 ONE", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let bubble_item =
        MenuItem::with_id(&app, "open_bubble", "打开小聊天框", true, None::<&str>)
            .map_err(|error| error.to_string())?;
    let hide_item =
        MenuItem::with_id(&app, "hide_pet", "隐藏宠物", true, None::<&str>)
            .map_err(|error| error.to_string())?;
    let quit_item = MenuItem::with_id(&app, "quit", "退出", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let separator = PredefinedMenuItem::separator(&app).map_err(|error| error.to_string())?;
    let menu = Menu::with_items(
        &app,
        &[&open_item, &bubble_item, &hide_item, &separator, &quit_item],
    )
    .map_err(|error| error.to_string())?;
    window
        .popup_menu(&menu)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn quit_app(app: AppHandle) -> Result<(), String> {
    // Give the host window a chance to stop running work before we exit.
    if let Some(main) = app.get_webview_window(MAIN) {
        if main.is_visible().unwrap_or(false) {
            let _ = app.emit_to(MAIN, BEFORE_QUIT, ());
        }
    }
    let fallback = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(QUIT_GRACE);
        fallback.exit(0);
    });
    Ok(())
}

#[tauri::command]
fn force_quit(app: AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(pet) = app.get_webview_window(PET) {
                // Default to the bottom-right corner of the monitor work area.
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
            }
            app.on_menu_event(|app, event| match event.id().as_ref() {
                "open_main" => {
                    let _ = open_main(app.clone());
                }
                "open_bubble" => {
                    let _ = open_bubble(app);
                }
                "hide_pet" => {
                    let _ = hide_pet(app.clone());
                }
                "quit" => {
                    let _ = quit_app(app.clone());
                }
                _ => {}
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_main,
            open_bubble_window,
            hide_bubble,
            hide_pet,
            show_pet,
            start_drag,
            popup_pet_menu,
            quit_app,
            force_quit
        ])
        .on_window_event(|window, event| {
            // Closing the host window ends the session: the pet and bubble have
            // no state of their own and must not outlive the authority.
            if window.label() == MAIN {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = quit_app(window.app_handle().clone());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run ONE desktop shell");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_the_space_above_the_pet() {
        let (x, y) = place_bubble(
            Rect { x: 1000, y: 700, width: 128, height: 128 },
            Rect { x: 0, y: 0, width: 400, height: 560 },
            Rect { x: 0, y: 0, width: 1920, height: 1040 },
            12,
        );
        assert_eq!(x, 864);
        assert_eq!(y, 128);
    }

    #[test]
    fn flips_below_when_the_top_edge_would_leave_the_work_area() {
        let (x, y) = place_bubble(
            Rect { x: 900, y: 120, width: 128, height: 128 },
            Rect { x: 0, y: 0, width: 400, height: 560 },
            Rect { x: 0, y: 0, width: 1920, height: 1040 },
            12,
        );
        assert_eq!(x, 764);
        assert_eq!(y, 260);
    }

    #[test]
    fn keeps_the_window_inside_the_work_area_on_a_second_display() {
        let work = Rect { x: 1920, y: -200, width: 1280, height: 1000 };
        let (x, y) = place_bubble(
            Rect { x: 3100, y: 700, width: 128, height: 128 },
            Rect { x: 0, y: 0, width: 400, height: 560 },
            work,
            12,
        );
        assert!(x >= work.x && x + 400 <= work.x + work.width);
        assert!(y >= work.y && y + 560 <= work.y + work.height);
    }

    #[test]
    fn clamps_a_pet_that_was_dragged_off_the_right_edge() {
        let work = Rect {
            x: 0,
            y: 0,
            width: 1280,
            height: 800,
        };
        let (x, y) = place_bubble(
            Rect {
                x: 1260,
                y: 600,
                width: 128,
                height: 128,
            },
            Rect {
                x: 0,
                y: 0,
                width: 400,
                height: 560,
            },
            work,
            12,
        );
        // The bubble would hang off the right edge, so it is pulled back inside.
        assert_eq!(x, 880);
        assert_eq!(y, 28);
    }

    #[test]
    fn survives_a_work_area_smaller_than_the_bubble() {
        let (x, y) = place_bubble(
            Rect { x: 10, y: 10, width: 128, height: 128 },
            Rect { x: 0, y: 0, width: 400, height: 560 },
            Rect { x: 0, y: 0, width: 320, height: 480 },
            12,
        );
        assert_eq!((x, y), (0, 0));
    }
}