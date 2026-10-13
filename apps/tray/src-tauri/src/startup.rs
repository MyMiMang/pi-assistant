//! 启动过程：服务日志落盘 + 服务就绪前显示本地「正在启动」页，启动失败时显示原因和日志路径（不再出现浏览器的「拒绝连接」页）。
//! - 日志：服务端的 stdout/stderr 和托盘自己的启动信息都写到 app_log_dir/server.log
//!   （Windows：%LOCALAPPDATA%\com.piassistant.app\logs\server.log；macOS：~/Library/Logs/com.piassistant.app/server.log；
//!   Linux：~/.local/share/com.piassistant.app/logs/server.log）。超过 5MB 时启动时轮转成 server.old.log，最多占 10MB
//! - 主窗口：服务没就绪时加载打包进程序的 startup.html；就绪后导航到本机服务；失败时页面显示原因、日志尾部、重试按钮
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

static LOG: OnceLock<PathBuf> = OnceLock::new();
static FILE: Mutex<Option<std::fs::File>> = Mutex::new(None);
const MAX: u64 = 5 * 1024 * 1024;

pub fn init_log(app: &AppHandle) {
    let Ok(dir) = app.path().app_log_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let p = dir.join("server.log");
    if std::fs::metadata(&p).map(|m| m.len() > MAX).unwrap_or(false) {
        let _ = std::fs::rename(&p, dir.join("server.old.log"));
    }
    if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        *FILE.lock().unwrap() = Some(f);
    }
    let _ = LOG.set(p);
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    log(&format!(
        "\n===== Pi Assistant {} 启动（unix {secs}，{} {}）=====\n",
        app.package_info().version,
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
}

pub fn log_path() -> String {
    LOG.get().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
}

/// 写一段到日志（也打到 stderr，开发时能看到）
pub fn log(s: &str) {
    eprint!("{s}");
    if let Some(f) = FILE.lock().unwrap().as_mut() {
        let _ = f.write_all(s.as_bytes());
        let _ = f.flush();
    }
}

fn tail(n: usize) -> String {
    let Some(p) = LOG.get() else { return String::new() };
    let s = std::fs::read(p).map(|b| String::from_utf8_lossy(&b).to_string()).unwrap_or_default();
    // 只看本次启动之后的内容
    let s = s.rsplit("===== Pi Assistant").next().unwrap_or(&s).to_string();
    let lines: Vec<&str> = s.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

fn push(app: &AppHandle, v: serde_json::Value) {
    if let Some(w) = app.get_webview_window("main") {
        if w.url().map(|u| crate::is_startup_url(&u)).unwrap_or(false) {
            let _ = w.eval(format!("window.piaStartup && window.piaStartup({v})"));
        }
    }
}

/// 等服务就绪（最多 limit 秒），期间把进度推给启动页；服务反复崩溃时提前判失败
pub async fn wait_ready(app: &AppHandle, limit: u64) -> bool {
    let st = app.state::<crate::State>();
    let base_restarts = st.restarts.load(Ordering::SeqCst);
    for i in 0..limit * 2 {
        if crate::healthy().await {
            st.ready.store(true, Ordering::SeqCst);
            log("[tray] 服务已就绪\n");
            return true;
        }
        if st.restarts.load(Ordering::SeqCst) >= base_restarts + 2 {
            break;
        }
        if i % 2 == 0 {
            push(app, serde_json::json!({ "state": "wait", "secs": i / 2, "log": log_path() }));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    false
}

/// 启动失败：记日志，主窗口（有的话）切到失败状态；页面加载可能比这里晚，所以连推几秒
pub async fn fail(app: &AppHandle) {
    let st = app.state::<crate::State>();
    let reason = st.last_error.lock().unwrap().clone().unwrap_or_else(|| "等了很久服务还是没有响应。".into());
    log(&format!("[tray] 服务没有启动起来：{reason}\n"));
    let t = tail(25);
    let diag = format!(
        "Pi Assistant {}\n系统：{} {}\n端口：{}\n原因：{reason}\n日志：{}\n重启次数：{}\n---- 日志末尾 ----\n{}",
        app.package_info().version,
        std::env::consts::OS,
        std::env::consts::ARCH,
        crate::port(),
        log_path(),
        st.restarts.load(Ordering::SeqCst),
        tail(80)
    );
    for _ in 0..10 {
        push(app, serde_json::json!({ "state": "fail", "reason": reason, "log": log_path(), "tail": t, "diag": diag }));
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// 等待就绪后把主窗口切过去；失败就显示失败页
pub async fn wait_then_show(app: AppHandle) {
    if wait_ready(&app, 120).await {
        if let Some(w) = app.get_webview_window("main") {
            if w.url().map(|u| crate::is_startup_url(&u)).unwrap_or(false) {
                if let Ok(u) = crate::base().parse::<tauri::Url>() {
                    let _ = w.navigate(u);
                }
            }
        }
    } else {
        fail(&app).await;
    }
}

#[tauri::command]
pub fn startup_retry(app: AppHandle) {
    log("[tray] 用户点了重试\n");
    let st = app.state::<crate::State>();
    st.restarts.store(0, Ordering::SeqCst);
    *st.last_error.lock().unwrap() = None;
    crate::stop_server(&app);
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(800)).await;
        h.state::<crate::State>().quitting.store(false, Ordering::SeqCst);
        crate::pick_port(&h).await;
        if !crate::healthy().await {
            crate::start_server(&h);
        }
        wait_then_show(h).await;
    });
}

#[tauri::command]
pub fn startup_open_logs(app: AppHandle) {
    if let Some(dir) = LOG.get().and_then(|p| p.parent()) {
        let _ = app.opener().open_path(dir.to_string_lossy().to_string(), None::<&str>);
    }
}
