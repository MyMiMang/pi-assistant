//! Pi Assistant托盘程序（无窗口）：
//! - 启动并守护 pi-assistant-server sidecar（内含 Node 运行时 + Pi + 我们的服务，Node SEA 单文件）
//! - 菜单栏/托盘菜单：打开Pi Assistant、配对手机、开机自启、检查更新、退出
//! - 自动更新：新版本（含新版 Pi）通过 Tauri updater 静默下载安装
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const PORT: u16 = 8787;
struct Server(Mutex<Option<CommandChild>>);

fn start_server(app: &AppHandle) {
    let data_dir = app.path().app_data_dir().expect("data dir");
    let web_dir = app.path().resource_dir().expect("resource dir").join("web");
    let cloudflared = app.path().resource_dir().unwrap().join(if cfg!(windows) { "cloudflared.exe" } else { "cloudflared" });
    let (mut rx, child) = app
        .shell()
        .sidecar("pi-assistant-server")
        .expect("sidecar")
        .env("PIA_DATA_DIR", data_dir.to_string_lossy().to_string())
        .env("PIA_WEB_DIST", web_dir.to_string_lossy().to_string())
        .env("PIA_CLOUDFLARED", cloudflared.to_string_lossy().to_string())
        .env("PIA_PORT", PORT.to_string())
        .spawn()
        .expect("failed to start pi-assistant-server");
    *app.state::<Server>().0.lock().unwrap() = Some(child);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            if let CommandEvent::Terminated(_) = ev {
                // 守护：服务意外退出时 3 秒后重启
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                start_server(&handle);
                break;
            }
        }
    });
}

fn open_ui(app: &AppHandle, path: &str) {
    let _ = app.opener().open_url(format!("http://127.0.0.1:{PORT}{path}"), None::<&str>);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| open_ui(app, "/")))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--background"])))
        .manage(Server(Mutex::new(None)))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            // 首次安装默认开启开机自启
            let _ = app.autolaunch().enable();
            start_server(app.handle());

            let open = MenuItem::with_id(app, "open", "打开Pi Assistant", true, None::<&str>)?;
            let pair = MenuItem::with_id(app, "pair", "配对手机…", true, None::<&str>)?;
            let auto = CheckMenuItem::with_id(app, "autostart", "开机自动启动", true, app.autolaunch().is_enabled().unwrap_or(true), None::<&str>)?;
            let update = MenuItem::with_id(app, "update", "检查更新", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &pair, &PredefinedMenuItem::separator(app)?, &auto, &update, &PredefinedMenuItem::separator(app)?, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Pi Assistant")
                .menu(&menu)
                .on_menu_event(move |app, ev| match ev.id().as_ref() {
                    "open" => open_ui(app, "/"),
                    "pair" => open_ui(app, "/?settings=remote"),
                    "autostart" => {
                        let al = app.autolaunch();
                        let _ = if al.is_enabled().unwrap_or(false) { al.disable() } else { al.enable() };
                    }
                    "update" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            use tauri_plugin_updater::UpdaterExt;
                            if let Ok(Some(u)) = app.updater().unwrap().check().await {
                                let _ = u.download_and_install(|_, _| {}, || {}).await;
                                app.restart();
                            }
                        });
                    }
                    "quit" => {
                        if let Some(c) = app.state::<Server>().0.lock().unwrap().take() {
                            let _ = c.kill();
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
