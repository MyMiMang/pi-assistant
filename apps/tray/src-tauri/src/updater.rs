//! 应用自动更新（DESIGN §16.x「关于 / 更新」）。
//! 托盘菜单和设置页「关于」共用这一个状态机：检查 → 有新版本 → 下载（带进度）→ 安装 → 重启。
//! 设置页是本机 8787 的网页（远程来源），通过 capabilities/remote-ui.json 只放行下面这几个命令。
//! 任何一步失败都记下中文摘要 + 原始错误，托盘菜单显示“更新失败”，并弹系统通知；设置页显示详情。
//! Windows：NSIS 安装器会覆盖 node.exe 等文件，所以先下载完、停掉内置服务，再交给安装器（否则文件被占用装不上）。
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Serialize, Default)]
pub struct UpdState {
    /// idle | checking | latest | available | downloading | installing | error
    pub phase: String,
    pub current: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
    pub detail: Option<String>,
    pub last_checked: Option<u64>,
    pub auto_check: bool,
    pub platform: String,
}

pub struct Updates {
    pub st: Mutex<UpdState>,
    pending: Mutex<Option<Update>>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
fn prefs_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("update.json"))
}

impl Updates {
    pub fn new(app: &AppHandle) -> Self {
        let mut s = UpdState { phase: "idle".into(), current: app.package_info().version.to_string(), auto_check: true, platform: std::env::consts::OS.into(), ..Default::default() };
        if let Some(Ok(t)) = prefs_path(app).map(std::fs::read_to_string) {
            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&t) {
                s.auto_check = j["autoCheck"].as_bool().unwrap_or(true);
                s.last_checked = j["lastChecked"].as_u64();
            }
        }
        Updates { st: Mutex::new(s), pending: Mutex::new(None) }
    }
}

fn save_prefs(app: &AppHandle) {
    let s = app.state::<Updates>().st.lock().unwrap().clone();
    if let Some(p) = prefs_path(app) {
        let _ = std::fs::create_dir_all(p.parent().unwrap());
        let _ = std::fs::write(p, serde_json::json!({ "autoCheck": s.auto_check, "lastChecked": s.last_checked }).to_string());
    }
}

/// 把原始错误翻成一句用户看得懂的话
pub fn summarize(e: &str) -> String {
    let l = e.to_lowercase();
    if l.contains("signature") || l.contains("minisign") {
        "更新包签名校验失败，已停止安装（可能下载损坏或被篡改）".into()
    } else if l.contains("permission denied") || l.contains("operation not permitted") || l.contains("access is denied") || l.contains("os error 13") || l.contains("os error 1)") {
        "没有权限替换应用，请把 Pi Assistant 拖进「应用程序」文件夹后再试，或下载安装包手动安装".into()
    } else if l.contains("read-only") || l.contains("os error 30") || l.contains("translocat") {
        "应用是从下载的磁盘映像里直接打开的，无法自动更新：请先把它拖进「应用程序」文件夹".into()
    } else if l.contains("timed out") || l.contains("timeout") {
        "下载超时，请检查网络后重试".into()
    } else if l.contains("dns") || l.contains("connect") || l.contains("network") || l.contains("request") || l.contains("tls") || l.contains("reqwest") {
        "连不上更新服务器（GitHub），请检查网络后重试".into()
    } else if l.contains("platform") || l.contains("target") {
        "这个版本没有适合你电脑的更新包，请到发布页手动下载".into()
    } else {
        "更新失败".into()
    }
}

fn set(app: &AppHandle, f: impl FnOnce(&mut UpdState)) {
    let s = {
        let ups = app.state::<Updates>();
        let mut g = ups.st.lock().unwrap();
        f(&mut g);
        g.clone()
    };
    crate::update_menu(app, &s);
}

fn fail(app: &AppHandle, e: String, notify: bool) {
    eprintln!("[tray] 更新失败：{e}");
    let sum = summarize(&e);
    set(app, |s| {
        s.phase = "error".into();
        s.error = Some(sum.clone());
        s.detail = Some(e.clone());
    });
    if notify {
        let _ = app.notification().builder().title("Pi Assistant 更新失败").body(format!("{sum}。打开「设置 › 关于」查看详情。")).show();
    }
}

/// 检查更新。notify_err：失败时弹通知（用户手动点的才弹，后台自动检查失败只记下）
pub async fn check(app: &AppHandle, notify_err: bool) -> UpdState {
    {
        let ph = app.state::<Updates>().st.lock().unwrap().phase.clone();
        if ph == "downloading" || ph == "installing" || ph == "checking" {
            return app.state::<Updates>().st.lock().unwrap().clone();
        }
    }
    set(app, |s| {
        s.phase = "checking".into();
        s.error = None;
        s.detail = None;
    });
    let res = match app.updater_builder().timeout(Duration::from_secs(30)).build() {
        Ok(u) => u.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    match res {
        Ok(Some(u)) => {
            let (v, n, d) = (u.version.clone(), u.body.clone(), u.date.map(|d| d.to_string()));
            let seen = app.state::<Updates>().st.lock().unwrap().version.clone();
            if !notify_err && seen.as_deref() != Some(v.as_str()) {
                let _ = app.notification().builder().title("Pi Assistant 有新版本").body(format!("v{v} 可以更新了：在托盘菜单或「设置 › 关于」里安装。")).show();
            }
            *app.state::<Updates>().pending.lock().unwrap() = Some(u);
            set(app, |s| {
                s.phase = "available".into();
                s.version = Some(v);
                s.notes = n;
                s.pub_date = d;
                s.last_checked = Some(now_ms());
            });
        }
        Ok(None) => set(app, |s| {
            s.phase = "latest".into();
            s.version = None;
            s.notes = None;
            s.last_checked = Some(now_ms());
        }),
        Err(e) => fail(app, e, notify_err),
    }
    save_prefs(app);
    app.state::<Updates>().st.lock().unwrap().clone()
}

/// 下载并安装，然后重启。在后台跑；进度写进状态
pub async fn install(app: AppHandle) {
    let ph = app.state::<Updates>().st.lock().unwrap().phase.clone();
    if ph == "downloading" || ph == "installing" {
        return;
    }
    if app.state::<Updates>().pending.lock().unwrap().is_none() {
        check(&app, true).await;
    }
    let Some(u) = app.state::<Updates>().pending.lock().unwrap().take() else {
        let ph = app.state::<Updates>().st.lock().unwrap().phase.clone();
        if ph == "latest" {
            set(&app, |s| s.phase = "latest".into());
        }
        return;
    };
    set(&app, |s| {
        s.phase = "downloading".into();
        s.downloaded = 0;
        s.total = None;
        s.error = None;
        s.detail = None;
    });
    let h = app.clone();
    let mut last = std::time::Instant::now() - Duration::from_secs(1);
    let bytes = u
        .download(
            move |n, total| {
                let ups = h.state::<Updates>();
                let mut g = ups.st.lock().unwrap();
                g.downloaded += n as u64;
                g.total = total;
                // 托盘菜单文字最多每 0.5 秒刷新一次
                if last.elapsed() > Duration::from_millis(500) {
                    last = std::time::Instant::now();
                    let s = g.clone();
                    drop(g);
                    crate::update_menu(&h, &s);
                }
            },
            || {},
        )
        .await;
    let bytes = match bytes {
        Ok(b) => b,
        Err(e) => {
            *app.state::<Updates>().pending.lock().unwrap() = Some(u);
            return fail(&app, e.to_string(), true);
        }
    };
    set(&app, |s| s.phase = "installing".into());
    // 先停内置服务：Windows 安装器要覆盖 node.exe；macOS 换 .app 时也不该有旧进程在用里面的文件
    crate::stop_server(&app);
    match u.install(bytes) {
        Ok(()) => {
            tokio::time::sleep(Duration::from_millis(300)).await;
            app.restart();
        }
        Err(e) => {
            // 装失败：把服务拉起来，别让用户什么都用不了
            crate::restart_server(&app);
            *app.state::<Updates>().pending.lock().unwrap() = Some(u);
            fail(&app, e.to_string(), true);
        }
    }
}

// ---------------------------------------------------------------- 设置页调用的命令
#[tauri::command]
pub fn app_update_status(app: AppHandle) -> UpdState {
    app.state::<Updates>().st.lock().unwrap().clone()
}
#[tauri::command]
pub async fn app_update_check(app: AppHandle) -> UpdState {
    check(&app, false).await
}
#[tauri::command]
pub fn app_update_install(app: AppHandle) {
    tauri::async_runtime::spawn(install(app));
}
#[tauri::command]
pub fn app_update_set_auto(app: AppHandle, on: bool) -> UpdState {
    app.state::<Updates>().st.lock().unwrap().auto_check = on;
    save_prefs(&app);
    app.state::<Updates>().st.lock().unwrap().clone()
}

/// 启动后检查一次，之后每 12 小时（开着“自动检查”时）
pub async fn auto_loop(app: AppHandle) {
    loop {
        if app.state::<Updates>().st.lock().unwrap().auto_check {
            check(&app, false).await;
        }
        tokio::time::sleep(Duration::from_secs(12 * 3600)).await;
    }
}
