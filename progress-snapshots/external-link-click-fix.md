# external-link-click-fix（桌面聊天 markdown 外链左键点击无反应）

分支 `external-link-click-fix`，独立 tree，基线 `origin/main` = `f3cb6c9`（beta.22 候选）。未 push / 未 tag，避免与并发发布冲突。
工作树：`/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/external-link-click-fix`。

## 用户报告（原话大意）
Mac 安装版（截图时 `CFBundleShortVersionString` = **0.1.0-beta.21**）聊天里 markdown 外链「查看构建进度」（`https://github.com/MyMiMang/pi-assistant/actions/runs/38703641245`，蓝色下划线）**左键点击无反应，只有右键菜单可用**。

## 真实根因（完整链路）
1. 页面渲染：`apps/web/src/components/Markdown.tsx` 把链接渲染成 `<a target="_blank" rel="noreferrer noopener">`（正文内联链接走 `a:` 组件；单独成段的走 `LinkCard`）。
2. 主窗口加载的是**远程页面** `http://127.0.0.1:8787`（capability `remote-ui`，`windows: ["main"]` + `remote.urls`）。
3. `tauri-plugin-opener` 默认注入 `init-iife.js`：点 `<a target="_blank">` 时 `preventDefault()` 再 invoke `plugin:opener|open_url`。**但 `remote-ui` capability 没有放行该命令**（`default.json` 里的 `opener:default` 是 `"windows": []`，不覆盖任何窗口）→ ACL 拒绝 → 点击被吞，页面什么都不做。这正是「左键无反应」。
4. beta.19（`2e20335`）的修法是 `open_js_links_on_click(false)` 关掉插件脚本，改成只靠原生 `on_new_window` / `on_navigation`。但**这条路在安装版上没被实测过**（ROADMAP 一直写「原生点击待用户实测」），beta.19/20/21/23 用户实测仍然是点了没反应 → 说明 `target=_blank` 在 WKWebView 里不保证走到那两个回调，**光关掉 JS 拦截不等于修好**。
5. 另外原 Rust 回调里 `let _ = app.opener().open_url(...)` **吞掉错误**，失败时既没日志也没反馈 → 符合「静默无反应」的现象。

## 本次改动（最小、完整）
| 文件 | 改动 |
|---|---|
| `apps/web/src/externalLinks.ts`（新） | 共享外链处理：只认 `__TAURI_INTERNALS__`（新版 Tauri 没有 `window.__TAURI__`）；白名单只放行 `http/https/mailto`；左键/中键点外链 → `preventDefault` → `invoke("plugin:opener|open_url", {url})` → 失败退回 `window.open`（WebView 原生窗口，Rust 兜底转交浏览器）→ 仍然失败弹底部提示卡片（含原地址 + 一键复制），**绝不静默**。右键、双击第二下、拖动选中文字、已 `preventDefault`、非外链、同源链接一律不接管。 |
| `apps/web/src/main.tsx` | 入口 `installExternalLinkHandling()`（聊天 / 群聊 / 子代理 / 工具结果 / 设置共用这一处）。普通浏览器 / PWA / 手机端是空操作。 |
| `apps/tray/src-tauri/capabilities/remote-ui.json` | 放行 `opener:allow-open-url` + `opener:allow-default-urls`（范围只有 `mailto/tel/http/https`，不放开 `javascript:`/`data:`/`file:`）。 |
| `apps/tray/src-tauri/src/main.rs` | 新增 `is_external_link()`（`http`/`https`/`mailto`）与页面侧一致；`on_navigation` / `on_new_window` 走它，并把 `open_url` 的错误 `eprintln!` 出来（不再 `let _ =` 吞掉）。原生路径降级为兜底（页面侧已 `preventDefault`，不会打开两次）。 |

链路（修好后）：markdown `<a target=_blank>` → 全局 capture click → `preventDefault` → `invoke plugin:opener|open_url` → ACL（remote-ui capability）→ Rust `commands::open_url` 按 scope 校验 → `app.opener().open_url` → `/usr/bin/open` → 系统默认浏览器。

## 已验证 / 未验证
**已实际跑过（Mock，不花钱、不碰真实配置）**
- `node --import tsx --test test/external-links.test.ts`：**13/13 通过**。覆盖：只认 `__TAURI_INTERNALS__`（`window.__TAURI__` 不算）、协议白名单（拒绝 `javascript:`/`data:`/`file:`/`blob:`/`tel:`/同源/相对）、左键 preventDefault + invoke 命令名与参数、**invoke 被 capability 拒绝 → 退回 `window.open` 且不误报**、`window.open` 也失败 → 必须 `notify`（带原地址）、非 Tauri 完全不动、右键/双击/已 preventDefault 不接管、中键、拖动选中、链接内部子元素、capability 与 Rust 白名单静态一致、markdown 仍是 `target=_blank` 且入口装了处理器。
- 两端 typecheck：`tsc --noEmit -p apps/web` 与 `tsc --noEmit -p packages/server` 均 exit 0。
- `vite build`（apps/web）通过，产物里含 `plugin:opener|open_url`。

**未验证（明确不宣称）**
- 未 `cargo build`（本机无 Rust 工具链），Rust 改动只做**静态核对**（测试里断言 helper 定义、两个回调都走白名单、不再吞错误）。
- 未安装 App、未真机点链接（按要求不动用户桌面、不装 App、不跑真实 desktop/VM）。
- 因此「安装版左键真的打开系统浏览器」仍需一次安装冒烟（Mac arm64）确认；页面侧 + capability 的链路是本次可验证的最长一段。
