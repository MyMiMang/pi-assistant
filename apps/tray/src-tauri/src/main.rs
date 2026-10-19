//! Pi Assistant 桌面程序（原生主窗口 + 托盘）：
//! - 启动并守护服务端：内置 Node 运行时（sidecar `node`）+ 安装包里的 app 目录（服务端源码 + 生产依赖 + 网页 + 第三方二进制）
//!   如果 8787 端口上已经有 Pi Assistant 在跑（比如源码安装的 LaunchAgent），直接用它，不重复启动
//! - 首次运行 / 手动打开时弹出原生主窗口（系统 WebView 加载本机 8787 界面，不再开浏览器）；
//!   关窗口只是隐藏，托盘常驻；开机自启（--background 不弹窗口）。外部链接用默认浏览器打开
//! - 菜单：打开、配对手机、暂停/继续操作电脑、悬浮条开关、开机自启、检查更新（进度 / 失败原因同步显示）、退出
//! - 操作这台电脑时弹出置顶悬浮条（/hostbar），一键暂停
//! - 桌宠（/pet）：透明置顶小窗，跟着助理状态动，只有宠物和气泡能点（见 pet.rs）
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

mod pet;
mod startup;
mod updater;

/// 默认端口；被别的程序占用时依次换 8788…8796（capabilities 里放行了这一段），选中的端口记在配置目录 port.txt 里保持稳定
pub const PORT: u16 = 8787;
const PORT_SPAN: u16 = 10;
static ACTIVE_PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(PORT);
pub fn port() -> u16 {
    ACTIVE_PORT.load(Ordering::SeqCst)
}

fn port_free(p: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", p)).is_ok()
}

/// 选端口：上次用的优先；已有 Pi Assistant 在跑就用它；否则找第一个空闲的
pub async fn pick_port(app: &AppHandle) {
    let file = app.path().app_config_dir().ok().map(|d| d.join("port.txt"));
    let saved = file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|s| s.trim().parse::<u16>().ok()).filter(|p| (PORT..PORT + PORT_SPAN).contains(p));
    let mut order: Vec<u16> = saved.into_iter().collect();
    order.extend((PORT..PORT + PORT_SPAN).filter(|p| Some(*p) != saved));
    for p in order.iter().copied() {
        ACTIVE_PORT.store(p, Ordering::SeqCst);
        if healthy().await || port_free(p) {
            if p != PORT {
                startup::log(&format!("[tray] 端口 {PORT} 被占用，改用 {p}\n"));
            }
            if let Some(f) = &file {
                let _ = std::fs::write(f, p.to_string());
            }
            return;
        }
        startup::log(&format!("[tray] 端口 {p} 被其他程序占用\n"));
    }
    ACTIVE_PORT.store(saved.unwrap_or(PORT), Ordering::SeqCst);
}
const BAR_W: f64 = 440.0;
const BAR_H: f64 = 56.0;

pub struct State {
    /// 服务已就绪（健康检查通过过；服务退出后清掉）
    pub ready: AtomicBool,
    /// 最近一次启动失败 / 退出的原因（显示在启动失败页）
    pub last_error: Mutex<Option<String>>,
    child: Mutex<Option<CommandChild>>,
    pub quitting: AtomicBool,
    pub restarts: AtomicU32,
    bar_enabled: AtomicBool,
    paused: AtomicBool,
    pause_item: Mutex<Option<MenuItem<Wry>>>,
    update_item: Mutex<Option<MenuItem<Wry>>>,
}

pub fn base() -> String {
    format!("http://127.0.0.1:{}", port())
}

fn http() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(3)).build().unwrap()
}

pub async fn healthy() -> bool {
    match http().get(format!("{}/api/system/public", base())).send().await {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    }
}

fn app_dir(app: &AppHandle) -> PathBuf {
    plain_path(app.path().resource_dir().expect("resource dir").join("app"))
}

/// Windows 上 resource_dir 可能是 `\\?\C:\...` 这种「原样路径」：Node 解析入口文件时会对它报
/// `EISDIR: illegal operation on a directory, lstat 'C:'` 并立刻退出（beta.10 Windows 打不开的原因），这里转回普通路径
fn plain_path(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p
    }
}

pub fn start_server(app: &AppHandle) {
    let dir = app_dir(app);
    let main = dir.join("packages").join("server").join("src").join("main.ts");
    let cmd = match app.shell().sidecar("node") {
        Ok(c) => c,
        Err(e) => {
            startup::log(&format!("[tray] sidecar node 不可用：{e}\n"));
            *app.state::<State>().last_error.lock().unwrap() = Some(format!("找不到内置的 Node 运行时（{e}）。"));
            return;
        }
    };
    startup::log(&format!("[tray] 启动服务：{} （目录 {}）\n", main.display(), dir.display()));
    let spawned = cmd
        .args(["--disable-warning=ExperimentalWarning", "--import", "tsx", &main.to_string_lossy()])
        .current_dir(&dir)
        .env("PIA_APP_DIR", dir.to_string_lossy().to_string())
        .env("PIA_PORT", port().to_string())
        .env("PIA_LAUNCHER", "tray")
        .spawn();
    let (mut rx, child) = match spawned {
        Ok(x) => x,
        Err(e) => {
            startup::log(&format!("[tray] 启动服务失败：{e}\n"));
            *app.state::<State>().last_error.lock().unwrap() = Some(format!("启动后台服务失败（{e}），可能被杀毒软件拦截。"));
            return;
        }
    };
    *app.state::<State>().child.lock().unwrap() = Some(child);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(l) | CommandEvent::Stderr(l) => {
                    let t = String::from_utf8_lossy(&l);
                    startup::log(&if t.ends_with('\n') { t.to_string() } else { format!("{t}\n") });
                }
                CommandEvent::Error(e) => startup::log(&format!("[tray] 服务进程错误：{e}\n")),
                CommandEvent::Terminated(p) => {
                    let st = handle.state::<State>();
                    st.ready.store(false, Ordering::SeqCst);
                    startup::log(&format!("[tray] 服务进程退出：code={:?} signal={:?}\n", p.code, p.signal));
                    if !st.quitting.load(Ordering::SeqCst) {
                        *st.last_error.lock().unwrap() = Some(match p.code {
                            Some(c) => format!("后台服务启动后退出了（代码 {c}）。"),
                            None => "后台服务被系统结束了。".to_string(),
                        });
                    }
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

/// 打开原生主窗口（没有就建；已有就导航到 path 并前置）。建窗口失败时退回默认浏览器
pub fn open_ui(app: &AppHandle, path: &str) {
    let full = format!("{}{path}", base());
    let Ok(url) = full.parse::<tauri::Url>() else { return };
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    let ready = app.state::<State>().ready.load(Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("main") {
        let on_startup = w.url().map(|u| is_startup_url(&u)).unwrap_or(false);
        if ready && (path != "/" || on_startup) {
            let _ = w.navigate(url);
        }
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let opener = app.clone();
    let opener_nav = app.clone();
    // 服务还没就绪：先显示打包进程序的启动页（不要让 WebView 显示「拒绝连接」），就绪后自动切过去
    let target = if ready { WebviewUrl::External(url) } else { WebviewUrl::App("startup.html".into()) };
    let builder = WebviewWindowBuilder::new(app, "main", target)
        .title("Pi Assistant")
        .inner_size(1280.0, 820.0)
        .min_inner_size(380.0, 560.0)
        .center()
        .focused(true)
        // 把拖进窗口的文件交给网页：Tauri 默认自己截走拖放（转成 tauri://drag-drop 事件），网页的 drop 就收不到文件，
        // 拖到聊天框不会像点「上传」那样加附件（apps/web/src/components/Chat.tsx / RoomChat.tsx 的 onDrop）。App 里没有用 Tauri 拖放事件的地方。
        .disable_drag_drop_handler();
    // macOS：标题栏改成透明覆盖式（红黄绿按钮仍由系统绘制、位置和行为都不变），并隐藏窗口标题文字，
    // 页面顶部背景就能一直顶到窗口边，不再有一条独立的深灰标题栏。
    // 同时给页面注入 .macos-tauri 标记：只有 macOS 桌面窗口有，普通浏览器 / Windows / Linux 都没有，
    // 页面侧据此留出顶部安全高度并放拖动区（apps/web/src/macosWindow.ts、themes/macos-titlebar.css）。
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .initialization_script(
            // 注入标记：document start 时 <html> 可能还没建出来，用 MutationObserver 等它出现，
            // 保证在首帧渲染前就带上 .macos-tauri（否则会闪一下没留白的布局）。
            "(function(){function add(){var d=document.documentElement;if(d){d.classList.add('macos-tauri');return true;}return false;}\
             if(add())return;\
             var mo=new MutationObserver(function(){if(add())mo.disconnect();});\
             mo.observe(document,{childList:true,subtree:true});\
             setTimeout(function(){mo.disconnect();add();},3000);})();",
        );
    let built = builder
        // 页面里 target=_blank / window.open 的外部链接交给系统浏览器，不在应用里开新窗口。
        // 这是兜底路径：页面侧（apps/web/src/externalLinks.ts）会先 preventDefault 并 invoke
        // plugin:opener|open_url；没走页面侧（原生新窗口请求）时才落到这里。
        .on_new_window(move |u, _| {
            if is_external_link(&u) {
                if let Err(e) = opener.opener().open_url(u.as_str(), None::<&str>) {
                    eprintln!("[tray] 外链交给系统浏览器失败（{}）：{e}", u.as_str());
                }
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_navigation(move |u| {
            // 主窗口只允许停留在本机服务页面；其他外部地址交给系统默认浏览器。
            // 注意：WebView 里点链接（含 target=_blank）可能先走到这里，只 return false 会「静默取消」→
            // 浏览器没被打开、链接点了没反应。所以这里对真正的外部地址要主动 open_url 再拒绝内嵌跳转。
            let local = u.host_str() == Some("127.0.0.1") && u.port() == Some(port());
            if local || is_startup_url(u) || u.scheme() == "about" || u.scheme() == "blob" || u.scheme() == "data" {
                return true;
            }
            if is_external_link(u) {
                if let Err(e) = opener_nav.opener().open_url(u.as_str(), None::<&str>) {
                    eprintln!("[tray] 外链交给系统浏览器失败（{}）：{e}", u.as_str());
                }
            }
            false
        })
        .build();
    match built {
        Ok(w) => {
            let _ = w.set_focus();
            if !ready {
                tauri::async_runtime::spawn(startup::wait_then_show(app.clone()));
            }
        }
        Err(e) => {
            eprintln!("[tray] 建主窗口失败，改用浏览器：{e}");
            let _ = app.opener().open_url(full, None::<&str>);
        }
    }
}

/// 程序自带页面（启动页）的地址：macOS/Linux 是 tauri://localhost，Windows 是 http://tauri.localhost
pub fn is_startup_url(u: &tauri::Url) -> bool {
    u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost")
}

/// 允许交给系统默认浏览器打开的协议白名单，和页面侧 apps/web/src/externalLinks.ts 保持一致：
/// 只放行 http / https / mailto；javascript: / data: / file: / blob: 等一律不打开。
fn is_external_link(u: &tauri::Url) -> bool {
    matches!(u.scheme(), "http" | "https" | "mailto")
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
        // 透明无边框：页面背景透明，只露出圆角胶囊（macOS 需 macOSPrivateApi）
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        // 悬浮条里的“打开设置”在主窗口里打开
        .on_new_window({
            let h = app.clone();
            move |u, _| {
                let path = format!("{}{}", u.path(), u.query().map(|q| format!("?{q}")).unwrap_or_default());
                let h2 = h.clone();
                let _ = h.run_on_main_thread(move || open_ui(&h2, &path));
                tauri::webview::NewWindowResponse::Deny
            }
        })
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

/// 每 2 秒看一次：开着“操作这台电脑”且助理正在操作（最近几秒有动作）时才显示悬浮条
async fn bar_loop(app: AppHandle) {
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let Ok(r) = http().get(format!("{}/api/host-control/bar", base())).send().await else { continue };
        let Ok(j) = r.json::<serde_json::Value>().await else { continue };
        app.state::<State>().ready.store(true, Ordering::SeqCst);
        let enabled = j["enabled"].as_bool().unwrap_or(false);
        let paused = j["paused"].as_bool().unwrap_or(false);
        let active = j["active"].as_bool().unwrap_or(false);
        let dismissed = j["dismissed"].as_bool().unwrap_or(false);
        let st = app.state::<State>();
        st.paused.store(paused, Ordering::SeqCst);
        if let Some(item) = st.pause_item.lock().unwrap().as_ref() {
            let _ = item.set_enabled(enabled);
            let _ = item.set_text(if paused { "继续操作这台电脑" } else { "暂停操作这台电脑" });
        }
        let show = st.bar_enabled.load(Ordering::SeqCst) && enabled && active && !dismissed;
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

/// 托盘菜单里“检查更新”这一项的文字跟着更新状态走
pub fn update_menu(app: &AppHandle, s: &updater::UpdState) {
    let text = match s.phase.as_str() {
        "checking" => "正在检查更新…".to_string(),
        "available" => format!("安装更新 v{}", s.version.clone().unwrap_or_default()),
        "downloading" => match s.total {
            Some(t) if t > 0 => format!("正在下载更新 {}%", s.downloaded * 100 / t),
            _ => format!("正在下载更新 {} MB", s.downloaded / 1_048_576),
        },
        "installing" => "正在安装更新…".to_string(),
        "latest" => "已是最新版本".to_string(),
        "error" => "更新失败，点这里查看".to_string(),
        _ => "检查更新".to_string(),
    };
    let busy = matches!(s.phase.as_str(), "checking" | "downloading" | "installing");
    if let Some(item) = app.state::<State>().update_item.lock().unwrap().as_ref() {
        let _ = item.set_text(text);
        let _ = item.set_enabled(!busy);
    }
}

/// 更新安装失败后把内置服务重新拉起来
pub fn restart_server(app: &AppHandle) {
    let st = app.state::<State>();
    st.quitting.store(false, Ordering::SeqCst);
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        if !healthy().await {
            start_server(&h);
        }
    });
}

pub fn stop_server(app: &AppHandle) {
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
        // 关掉 opener 插件的 JS 链接拦截（open_js_links_on_click）：它会在点击 <a target=_blank> 时
        // preventDefault 再经 IPC 调 plugin:opener|open_url。页面侧自己接管这件事
        // （apps/web/src/externalLinks.ts，remote-ui capability 已放行 opener:allow-open-url +
        // opener:allow-default-urls），避免插件脚本和页面处理器重复打开两次。
        // 原生侧下面的 on_navigation / on_new_window 仍作为兜底。
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--background"])))
        .manage(State {
            ready: AtomicBool::new(false),
            last_error: Mutex::new(None),
            child: Mutex::new(None),
            quitting: AtomicBool::new(false),
            restarts: AtomicU32::new(0),
            bar_enabled: AtomicBool::new(true),
            paused: AtomicBool::new(false),
            pause_item: Mutex::new(None),
            update_item: Mutex::new(None),
        })
        .manage(pet::PetState::default())
        .invoke_handler(tauri::generate_handler![updater::app_update_status, updater::app_update_check, updater::app_update_install, updater::app_update_set_auto, pet::pet_hitbox, pet::pet_drag, pet::pet_open_main, startup::startup_retry, startup::startup_open_logs])
        .setup(move |app| {
            startup::init_log(app.handle());
            let u = updater::Updates::new(app.handle());
            app.manage(u);
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
            let auto = CheckMenuItem::with_id(app, "autostart", "开机自动启动", true, app.autolaunch().is_enabled().unwrap_or(true), None::<&str>)?;
            let update = MenuItem::with_id(app, "update", "检查更新", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let sep = || PredefinedMenuItem::separator(app);
            let menu = Menu::with_items(app, &[&open, &pair, &sep()?, &pause, &bar, &sep()?, &auto, &update, &sep()?, &quit])?;
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
                        // 有新版本 → 直接开始安装；否则检查一次。都打开「设置 › 关于」看进度和详情
                        let phase = app.state::<updater::Updates>().st.lock().unwrap().phase.clone();
                        open_ui(app, "/?settings=about");
                        let app = app.clone();
                        if phase == "available" {
                            tauri::async_runtime::spawn(updater::install(app));
                        } else {
                            tauri::async_runtime::spawn(async move {
                                updater::check(&app, true).await;
                            });
                        }
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
                pick_port(&h).await;
                if healthy().await {
                    h.state::<State>().ready.store(true, Ordering::SeqCst);
                    startup::log(&format!("[tray] 已有服务在 {} 上运行，直接使用\n", port()));
                } else {
                    start_server(&h);
                }
                let show = first_run || !background;
                if show {
                    // 立即打开窗口：没就绪时是启动页（open_ui 里会等待就绪再切过去 / 失败时显示原因和日志路径）
                    let h2 = h.clone();
                    let _ = h.run_on_main_thread(move || open_ui(&h2, "/"));
                    let _ = std::fs::write(cfg.join("first-run-done"), "1");
                }
                if !show && !h.state::<State>().ready.load(Ordering::SeqCst) && !startup::wait_ready(&h, 120).await {
                    startup::fail(&h).await;
                }
                tauri::async_runtime::spawn(updater::auto_loop(h.clone()));
                tauri::async_runtime::spawn(pet::run(h.clone(), base()));
                bar_loop(h).await;
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, ev| {
            // 关主窗口 = 隐藏到托盘（服务继续跑）；macOS 回到纯菜单栏模式
            if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { api, .. }, .. } = &ev {
                if label == "main" {
                    api.prevent_close();
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                    }
                    #[cfg(target_os = "macos")]
                    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
            }
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

#[cfg(test)]
mod tests {
    use super::plain_path;
    use std::path::PathBuf;
    #[test]
    fn strips_verbatim_prefix() {
        assert_eq!(plain_path(PathBuf::from(r"\\?\C:\Users\灯灯\AppData\Local\Pi Assistant\app")), PathBuf::from(r"C:\Users\灯灯\AppData\Local\Pi Assistant\app"));
        assert_eq!(plain_path(PathBuf::from(r"\\?\UNC\srv\share\app")), PathBuf::from(r"\\srv\share\app"));
        assert_eq!(plain_path(PathBuf::from("/Applications/Pi Assistant.app/Contents/Resources/app")), PathBuf::from("/Applications/Pi Assistant.app/Contents/Resources/app"));
    }
}
