//! Pi Assistant 托盘程序（无主窗口）：
//! - 启动并守护服务端：内置 Node 运行时（sidecar `node`）+ 安装包里的 app 目录（服务端源码 + 生产依赖 + 网页 + 第三方二进制）
//!   如果 8787 端口上已经有 Pi Assistant 在跑（比如源码安装的 LaunchAgent），直接用它，不重复启动
//! - 首次运行 / 手动打开时自动在浏览器打开界面；开机自启（--background 不弹界面）
//! - 菜单：打开、配对手机、暂停/继续操作电脑、悬浮条开关、开机自启、检查更新、退出
//! - 操作这台电脑时弹出置顶悬浮条（/hostbar），一键暂停
//! - 自动更新：Tauri updater 读 GitHub Releases 的 latest.json（签名校验），新版本含新版 Pi
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const PORT: u16 = 8787;
const BAR_W: f64 = 440.0;
const BAR_H: f64 = 56.0;

struct State {
    child: Mutex<Option<CommandChild>>,
    quitting: AtomicBool,
    restarts: AtomicU32,
    bar_enabled: AtomicBool,
    paused: AtomicBool,
    pause_item: Mutex<Option<MenuItem<Wry>>>,
    update_item: Mutex<Option<MenuItem<Wry>>>,
}

fn base() -> String {
    format!("http://127.0.0.1:{PORT}")
}

fn http() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(3)).build().unwrap()
}

async fn healthy() -> bool {
    match http().get(format!("{}/api/system/public", base())).send().await {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    }
}

fn app_dir(app: &AppHandle) -> PathBuf {
    app.path().resource_dir().expect("resource dir").join("app")
}

fn start_server(app: &AppHandle) {
    let dir = app_dir(app);
    let main = dir.join("packages").join("server").join("src").join("main.ts");
    let cmd = match app.shell().sidecar("node") {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[tray] sidecar node 不可用：{e}");
            return;
        }
    };
    let spawned = cmd
        .args(["--disable-warning=ExperimentalWarning", "--import", "tsx", &main.to_string_lossy()])
        .current_dir(&dir)
        .env("PIA_APP_DIR", dir.to_string_lossy().to_string())
        .env("PIA_PORT", PORT.to_string())
        .env("PIA_LAUNCHER", "tray")
        .spawn();
    let (mut rx, child) = match spawned {
        Ok(x) => x,
        Err(e) => {
            eprintln!("[tray] 启动服务失败：{e}");
            return;
        }
    };
    *app.state::<State>().child.lock().unwrap() = Some(child);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(l) | CommandEvent::Stderr(l) => eprint!("[server] {}", String::from_utf8_lossy(&l)),
                CommandEvent::Terminated(_) => {
                    let st = handle.state::<State>();
                    if st.quitting.load(Ordering::SeqCst) {
                        break;
                    }
                    // 守护：意外退出后退避重启（3s、6s… 最多 60s）
                    let n = st.restarts.fetch_add(1, Ordering::SeqCst).min(20);
                    tokio::time::sleep(Duration::from_secs((3 * (n as u64 + 1)).min(60))).await;
                    if !healthy().await {
                        start_server(&handle);
                    }
                    break;
                }
                _ => {}
            }
        }
    });
}

fn open_ui(app: &AppHandle, path: &str) {
    let _ = app.opener().open_url(format!("{}{path}", base()), None::<&str>);
}

/// 悬浮条窗口：服务就绪后再建（它加载的是本机服务的 /hostbar 页面）
fn ensure_bar(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window("hostbar") {
        return Some(w);
    }
    let url = format!("{}/hostbar", base()).parse().ok()?;
    let w = WebviewWindowBuilder::new(app, "hostbar", WebviewUrl::External(url))
        .title("Pi Assistant · 操作这台电脑")
        .inner_size(BAR_W, BAR_H)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .build()
        .ok()?;
    if let Ok(Some(m)) = w.primary_monitor() {
        let s = m.scale_factor();
        let x = m.position().x as f64 + (m.size().width as f64 - BAR_W * s) / 2.0;
        let y = m.position().y as f64 + 36.0 * s;
        let _ = w.set_position(PhysicalPosition::new(x as i32, y as i32));
    }
    Some(w)
}

/// 每 2 秒看一次：开着“操作这台电脑”且（正在操作 / 已暂停）时显示悬浮条
async fn bar_loop(app: AppHandle) {
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let Ok(r) = http().get(format!("{}/api/host-control/bar", base())).send().await else { continue };
        let Ok(j) = r.json::<serde_json::Value>().await else { continue };
        let enabled = j["enabled"].as_bool().unwrap_or(false);
        let paused = j["paused"].as_bool().unwrap_or(false);
        let active = j["active"].as_bool().unwrap_or(false);
        let st = app.state::<State>();
        st.paused.store(paused, Ordering::SeqCst);
        if let Some(item) = st.pause_item.lock().unwrap().as_ref() {
            let _ = item.set_enabled(enabled);
            let _ = item.set_text(if paused { "继续操作这台电脑" } else { "暂停操作这台电脑" });
        }
        let show = st.bar_enabled.load(Ordering::SeqCst) && enabled && (active || paused);
        let h = app.clone();
        let _ = app.run_on_main_thread(move || {
            if show {
                if let Some(w) = ensure_bar(&h) {
                    if !w.is_visible().unwrap_or(false) {
                        let _ = w.show();
                    }
                }
            } else if let Some(w) = h.get_webview_window("hostbar") {
                let _ = w.hide();
            }
        });
    }
}

async fn set_paused(paused: bool) {
    let _ = http().post(format!("{}/api/host-control/pause", base())).json(&serde_json::json!({ "paused": paused })).send().await;
}

async fn check_update(app: &AppHandle, install: bool) {
    use tauri_plugin_updater::UpdaterExt;
    let Ok(up) = app.updater() else { return };
    match up.check().await {
        Ok(Some(u)) => {
            if let Some(item) = app.state::<State>().update_item.lock().unwrap().as_ref() {
                let _ = item.set_text(format!("安装更新 v{}", u.version));
            }
            if install {
                if u.download_and_install(|_, _| {}, || {}).await.is_ok() {
                    stop_server(app);
                    app.restart();
                }
            }
        }
        Ok(None) => {
            if install {
                if let Some(item) = app.state::<State>().update_item.lock().unwrap().as_ref() {
                    let _ = item.set_text("已是最新版本");
                }
            }
        }
        Err(e) => eprintln!("[tray] 检查更新失败：{e}"),
    }
}

fn stop_server(app: &AppHandle) {
    let st = app.state::<State>();
    st.quitting.store(true, Ordering::SeqCst);
    let child = st.child.lock().unwrap().take();
    if let Some(c) = child {
        let _ = c.kill();
    }
}

fn main() {
    let background = std::env::args().any(|a| a == "--background");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| open_ui(app, "/")))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--background"])))
        .manage(State {
            child: Mutex::new(None),
            quitting: AtomicBool::new(false),
            restarts: AtomicU32::new(0),
            bar_enabled: AtomicBool::new(true),
            paused: AtomicBool::new(false),
            pause_item: Mutex::new(None),
            update_item: Mutex::new(None),
        })
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let cfg = app.path().app_config_dir()?;
            std::fs::create_dir_all(&cfg).ok();
            let first_run = !cfg.join("first-run-done").exists();
            if first_run {
                // 首次安装默认开启开机自启
                let _ = app.autolaunch().enable();
            }

            let open = MenuItem::with_id(app, "open", "打开 Pi Assistant", true, None::<&str>)?;
            let pair = MenuItem::with_id(app, "pair", "配对手机…", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "暂停操作这台电脑", false, None::<&str>)?;
            let bar = CheckMenuItem::with_id(app, "bar", "操作电脑时显示悬浮条", true, true, None::<&str>)?;
            let log = MenuItem::with_id(app, "log", "操作记录…", true, None::<&str>)?;
            let auto = CheckMenuItem::with_id(app, "autostart", "开机自动启动", true, app.autolaunch().is_enabled().unwrap_or(true), None::<&str>)?;
            let update = MenuItem::with_id(app, "update", "检查更新", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let sep = || PredefinedMenuItem::separator(app);
            let menu = Menu::with_items(app, &[&open, &pair, &sep()?, &pause, &bar, &log, &sep()?, &auto, &update, &sep()?, &quit])?;
            *app.state::<State>().pause_item.lock().unwrap() = Some(pause.clone());
            *app.state::<State>().update_item.lock().unwrap() = Some(update.clone());
            // macOS 菜单栏用单色模板图（系统按深浅色自动着色）；Windows/Linux 用彩色托盘图标
            #[cfg(target_os = "macos")]
            let (tray_icon, tray_template) = (tauri::include_image!("icons/tray-template@2x.png"), true);
            #[cfg(not(target_os = "macos"))]
            let (tray_icon, tray_template) = (tauri::include_image!("icons/tray.png"), false);
            TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .icon_as_template(tray_template)
                .tooltip("Pi Assistant")
                .menu(&menu)
                .on_menu_event(move |app, ev| match ev.id().as_ref() {
                    "open" => open_ui(app, "/"),
                    "pair" => open_ui(app, "/?settings=remote"),
                    "log" => open_ui(app, "/?settings=host"),
                    "pause" => {
                        let p = !app.state::<State>().paused.load(Ordering::SeqCst);
                        tauri::async_runtime::spawn(set_paused(p));
                    }
                    "bar" => {
                        let st = app.state::<State>();
                        let v = !st.bar_enabled.load(Ordering::SeqCst);
                        st.bar_enabled.store(v, Ordering::SeqCst);
                    }
                    "autostart" => {
                        let al = app.autolaunch();
                        let _ = if al.is_enabled().unwrap_or(false) { al.disable() } else { al.enable() };
                    }
                    "update" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move { check_update(&app, true).await });
                    }
                    "quit" => {
                        stop_server(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            let h = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // 已有服务在跑（例如源码安装）就直接用；否则启动内置服务
                if !healthy().await {
                    start_server(&h);
                }
                for _ in 0..240 {
                    if healthy().await {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                if first_run || !background {
                    open_ui(&h, "/");
                    let _ = std::fs::write(cfg.join("first-run-done"), "1");
                }
                let h2 = h.clone();
                tauri::async_runtime::spawn(async move { check_update(&h2, false).await });
                bar_loop(h).await;
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, ev| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &ev {
                // 关掉悬浮条窗口不退出托盘程序
                if code.is_none() {
                    api.prevent_exit();
                }
            }
            if let tauri::RunEvent::Exit = ev {
                stop_server(app);
            }
        });
}
