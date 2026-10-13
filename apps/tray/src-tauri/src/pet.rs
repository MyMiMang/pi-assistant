//! 桌宠窗口：透明、无边框、置顶、不进任务栏的小窗，加载本机服务的 /pet 页面。
//! - 显示 / 隐藏跟着服务端设置（设置 › 桌宠 › 在桌面上显示），每 2 秒看一次
//! - 点击穿透：页面把能点的区域（宠物、气泡）报上来（pet_hitbox），这里每 40ms 看一次鼠标位置，
//!   鼠标在这些区域外就让窗口忽略鼠标（点击落到下面的程序），在区域内就恢复
//! - 拖动：页面按住拖动时调 pet_drag（系统原生拖窗）；松手后的位置存到配置目录 pet-position.json，下次启动放回原处
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

pub const W: f64 = 300.0;
pub const H: f64 = 340.0;

#[derive(Default)]
pub struct PetState {
    /// 能点的区域（CSS 像素，相对窗口左上角）：[x, y, w, h]
    rects: Mutex<Vec<[f64; 4]>>,
    ignoring: AtomicBool,
}

fn pos_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("pet-position.json"))
}

fn saved_pos(app: &AppHandle) -> Option<(i32, i32)> {
    let s = std::fs::read_to_string(pos_file(app)?).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    Some((v["x"].as_i64()? as i32, v["y"].as_i64()? as i32))
}

pub fn save_pos(app: &AppHandle, x: i32, y: i32) {
    if let Some(f) = pos_file(app) {
        let _ = std::fs::write(f, serde_json::json!({ "x": x, "y": y }).to_string());
    }
}

/// 位置还在某块屏幕上吗（拔掉外接屏后别跑到看不见的地方）
fn on_screen(w: &tauri::WebviewWindow, x: i32, y: i32) -> bool {
    w.available_monitors().unwrap_or_default().iter().any(|m| {
        let p = m.position();
        let s = m.size();
        x + 60 > p.x && x + 60 < p.x + s.width as i32 && y + 60 > p.y && y + 60 < p.y + s.height as i32
    })
}

pub fn ensure(app: &AppHandle, base: &str) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window("pet") {
        return Some(w);
    }
    let url = format!("{base}/pet").parse().ok()?;
    let w = WebviewWindowBuilder::new(app, "pet", WebviewUrl::External(url))
        .title("Pi Assistant 桌宠")
        .inner_size(W, H)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .visible(false)
        .focused(false)
        .on_new_window({
            let h = app.clone();
            move |u, _| {
                let path = format!("{}{}", u.path(), u.query().map(|q| format!("?{q}")).unwrap_or_default());
                let h2 = h.clone();
                let _ = h.run_on_main_thread(move || crate::open_ui(&h2, &path));
                tauri::webview::NewWindowResponse::Deny
            }
        })
        .build()
        .ok()?;
    match saved_pos(app) {
        Some((x, y)) if on_screen(&w, x, y) => {
            let _ = w.set_position(PhysicalPosition::new(x, y));
        }
        _ => {
            // 默认放在主屏右下角（留出 Dock / 任务栏）
            if let Ok(Some(m)) = w.primary_monitor() {
                let s = m.scale_factor();
                let x = m.position().x as f64 + m.size().width as f64 - (W + 24.0) * s;
                let y = m.position().y as f64 + m.size().height as f64 - (H + 96.0) * s;
                let _ = w.set_position(PhysicalPosition::new(x as i32, y as i32));
            }
        }
    }
    let h = app.clone();
    w.on_window_event(move |ev| {
        if let tauri::WindowEvent::Moved(p) = ev {
            save_pos(&h, p.x, p.y);
        }
    });
    Some(w)
}

/// 鼠标在不在能点的区域里 → 切换点击穿透
async fn hit_loop(app: AppHandle) {
    loop {
        tokio::time::sleep(Duration::from_millis(40)).await;
        let Some(w) = app.get_webview_window("pet") else { continue };
        if !w.is_visible().unwrap_or(false) {
            continue;
        }
        let (Ok(cur), Ok(pos), Ok(scale)) = (app.cursor_position(), w.inner_position(), w.scale_factor()) else { continue };
        let x = (cur.x - pos.x as f64) / scale;
        let y = (cur.y - pos.y as f64) / scale;
        let st = app.state::<PetState>();
        let inside = st.rects.lock().unwrap().iter().any(|r| x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3]);
        let ignore = !inside;
        if st.ignoring.swap(ignore, Ordering::SeqCst) != ignore {
            let _ = w.set_ignore_cursor_events(ignore);
        }
    }
}

/// 跟着服务端设置显示 / 隐藏
pub async fn run(app: AppHandle, base: String) {
    tauri::async_runtime::spawn(hit_loop(app.clone()));
    let client = reqwest::Client::builder().timeout(Duration::from_secs(3)).build().unwrap();
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let Ok(r) = client.get(format!("{base}/api/pet/settings")).send().await else { continue };
        let Ok(j) = r.json::<serde_json::Value>().await else { continue };
        let show = j["enabled"].as_bool().unwrap_or(false);
        let h = app.clone();
        let b = base.clone();
        let _ = app.run_on_main_thread(move || {
            if show {
                if let Some(w) = ensure(&h, &b) {
                    if !w.is_visible().unwrap_or(false) {
                        let _ = w.show();
                    }
                }
            } else if let Some(w) = h.get_webview_window("pet") {
                let _ = w.hide();
            }
        });
    }
}

#[tauri::command]
pub fn pet_hitbox(app: AppHandle, rects: Vec<[f64; 4]>) {
    *app.state::<PetState>().rects.lock().unwrap() = rects;
}

#[tauri::command]
pub fn pet_drag(window: tauri::WebviewWindow) {
    let _ = window.start_dragging();
}

#[tauri::command]
pub fn pet_open_main(app: AppHandle, path: String) {
    // 只接受站内路径
    let p = if path.starts_with('/') && !path.starts_with("//") { path } else { "/".to_string() };
    let h = app.clone();
    let _ = app.run_on_main_thread(move || crate::open_ui(&h, &p));
}
