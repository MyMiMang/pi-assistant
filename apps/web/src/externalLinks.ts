/**
 * 外链统一处理：桌面程序（Tauri）里点击外部链接，交给系统默认浏览器打开。
 *
 * 背景（beta.19–beta.23 的真实缺口）：
 * - 页面里 markdown 链接渲染成 `<a target="_blank">`（apps/web/src/components/Markdown.tsx）。
 * - 主窗口加载的是远程页面（本机 8787），Tauri 的 `opener` 插件默认会在点击时
 *   preventDefault 再 invoke `plugin:opener|open_url`；但主窗口的 capability（remote-ui）
 *   没放行该命令 → 点击被吞，表现为「左键点了没反应」（右键菜单里的打开/复制仍可用）。
 * - 已关掉插件的 JS 拦截（apps/tray/src-tauri/src/main.rs 的 open_js_links_on_click(false)），
 *   交给原生 on_navigation / on_new_window；但安装版实测这条路不可靠（WKWebView 里
 *   `target=_blank` 不保证走到原生回调），所以页面侧要显式接管。
 *
 * 这里的做法（页面侧兜底，只认公开能力）：
 *   左键/中键点外链 → preventDefault → invoke `plugin:opener|open_url`
 *   → 失败再退回 window.open（WebView 原生窗口，由 Rust on_new_window 交给浏览器）
 *   → 仍然打不开就弹出可见提示（绝不静默失败）。
 *
 * 只在 Tauri 桌面窗口里接管：普通浏览器 / PWA / 手机端完全不动原生行为。
 * 只放行 http/https/mailto；javascript:/data:/file:/blob: 等一律不接管（不放开策略）。
 */

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** 新版 Tauri（2.x）只暴露 `window.__TAURI_INTERNALS__`，没有 `window.__TAURI__`。 */
const tauriInternals = (): { invoke?: Invoke } | undefined =>
	typeof window === "undefined" ? undefined : (window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;

/** 当前是否在 Tauri 桌面窗口里（有可用的 invoke 才算）。 */
export const inTauri = (): boolean => typeof tauriInternals()?.invoke === "function";
/** 桌面窗口里的 invoke（不在桌面程序里为 null）；其他桌面窗口能力（如窗口明暗）共用这一个入口。 */
export const tauriInvoke = (): Invoke | null => (inTauri() ? tauriInternals()!.invoke! : null);

/** 交给系统浏览器的协议白名单：http/https/mailto。其余协议（javascript:/data:/file:/blob:/tel:）不接管。 */
const EXTERNAL_SCHEME = /^(https?|mailto):/i;

/**
 * href 是否要交给系统默认浏览器。
 * 相对地址、锚点、同源地址、以及白名单外的协议都返回 false（保持原生行为）。
 */
export function isExternalHref(href: string | null | undefined, pageOrigin: string): boolean {
	const raw = (href ?? "").trim();
	if (!raw || raw.startsWith("#")) return false;
	if (/^mailto:/i.test(raw)) return true;
	if (!EXTERNAL_SCHEME.test(raw)) return false;
	try {
		return new URL(raw).origin !== pageOrigin;
	} catch {
		return false;
	}
}

/** 点击事件里需要的最小字段（便于单测，不依赖真实 DOM）。 */
export interface ClickLike {
	defaultPrevented?: boolean;
	button?: number;
	detail?: number;
	target?: unknown;
	preventDefault?: () => void;
}

export interface ClickDeps {
	/** Tauri invoke；为 null 表示不在桌面程序里（此时完全不管） */
	invoke: Invoke | null;
	/** window.open（WebView 原生新窗口，Rust 侧会转交系统浏览器） */
	open: (url: string) => unknown;
	/** 真正打不开时的可见反馈（不能静默） */
	notify: (url: string) => void;
	pageOrigin: string;
	/** 拖动选择文字后不应再打开链接 */
	selectionInLink?: (anchor: Element) => boolean;
	warn?: (msg: string, err?: unknown) => void;
}

export type ClickOutcome = "ignored" | "tauri" | "browser" | "failed";

/** 从事件目标里找最近的 <a href>（链接内部子元素、<code>、<span> 都能命中）。 */
function anchorFrom(target: unknown): Element | null {
	const el = target as Element | null;
	if (!el || typeof el.closest !== "function") return null;
	return el.closest("a[href]");
}

/**
 * 处理一次点击。返回实际走通的路径，便于测试与日志。
 * 不在 Tauri 里、右键、双击、拖动选中、非外链 → "ignored"（不改原生行为）。
 */
export async function handleExternalClick(ev: ClickLike, deps: ClickDeps): Promise<ClickOutcome> {
	if (!deps.invoke) return "ignored"; // 普通浏览器 / PWA：保持原生
	if (ev.defaultPrevented) return "ignored"; // 页面里已有处理器接管了
	// 右键保留原生菜单（复制链接等）；左键(0)和中键(1)才接管
	if (ev.button !== undefined && ev.button !== 0 && ev.button !== 1) return "ignored";
	if ((ev.detail ?? 1) > 1) return "ignored"; // 双击的第二下不重复打开
	const anchor = anchorFrom(ev.target);
	if (!anchor) return "ignored";
	const href = anchor.getAttribute("href");
	if (!isExternalHref(href, deps.pageOrigin)) return "ignored";
	if (deps.selectionInLink?.(anchor)) return "ignored";

	const url = href as string;
	ev.preventDefault?.(); // 阻止 WebView 内嵌导航 / 新窗口请求（避免被 popup blocked 吞掉）
	try {
		await deps.invoke("plugin:opener|open_url", { url });
		return "tauri";
	} catch (err) {
		deps.warn?.("[external-links] plugin:opener|open_url 调用失败，退回 window.open", err);
	}
	let w: unknown = null;
	try {
		w = deps.open(url);
	} catch (err) {
		deps.warn?.("[external-links] window.open 也失败", err);
	}
	if (w) return "browser";
	deps.notify(url);
	return "failed";
}

/** 打不开时的可见提示：底部小卡片 + 一键复制，10 秒后自动消失。 */
function notifyOpenFailed(url: string): void {
	if (typeof document === "undefined" || !document.body) return;
	const id = "pa-link-toast";
	let box = document.getElementById(id);
	if (!box) {
		box = document.createElement("div");
		box.id = id;
		box.setAttribute("role", "status");
		box.style.cssText =
			"position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:2147483000;max-width:min(92vw,520px);" +
			"display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;font-size:13px;" +
			"background:var(--card,#1f1f22);color:var(--fg,#eee);border:1px solid var(--line,#3a3a40);" +
			"box-shadow:0 10px 30px rgba(0,0,0,.28)";
		document.body.appendChild(box);
	}
	box.textContent = "";
	const msg = document.createElement("span");
	msg.style.cssText = "min-width:0;overflow-wrap:anywhere";
	msg.textContent = `打不开这个链接：${url}`;
	const btn = document.createElement("button");
	btn.type = "button";
	btn.textContent = "复制链接";
	btn.style.cssText =
		"flex:none;padding:4px 10px;border-radius:8px;border:1px solid var(--line,#3a3a40);" +
		"background:var(--hover,rgba(255,255,255,.08));color:inherit;cursor:pointer;font-size:12px";
	btn.onclick = () => {
		void navigator.clipboard?.writeText(url).then(
			() => (msg.textContent = "已复制链接，可粘贴到浏览器打开"),
			() => (msg.textContent = "复制失败，请手动选中下面的地址"),
		);
		// 复制后把地址露出来，方便手动选中
		const code = document.createElement("code");
		code.style.cssText = "display:block;margin-top:4px;font-size:11.5px;opacity:.75;overflow-wrap:anywhere";
		code.textContent = url;
		box.appendChild(code);
	};
	box.append(msg, btn);
	const prev = Number(box.dataset.timer ?? 0);
	if (prev) clearTimeout(prev);
	box.dataset.timer = String(setTimeout(() => box?.remove(), 10000));
}

/** 全局安装：聊天 / 群聊 / 子代理 / 工具结果 / 设置里所有 `<a target=_blank>` 外链共用这一处处理。 */
export function installExternalLinkHandling(): () => void {
	if (typeof window === "undefined" || typeof document === "undefined") return () => {};
	let down: { x: number; y: number } | null = null;
	const deps: ClickDeps = {
		invoke: tauriInternals()?.invoke ?? null,
		open: (url) => window.open(url, "_blank"),
		notify: notifyOpenFailed,
		pageOrigin: location.origin,
		selectionInLink: (anchor) => {
			const sel = window.getSelection?.();
			if (!sel || sel.isCollapsed || !sel.toString().trim()) return false;
			try {
				return sel.containsNode ? sel.containsNode(anchor, true) : false;
			} catch {
				return false;
			}
		},
		warn: (msg, err) => console.warn(msg, err),
	};
	if (!deps.invoke) return () => {}; // 普通浏览器 / PWA：不装任何监听

	const onDown = (e: MouseEvent) => {
		down = { x: e.clientX, y: e.clientY };
	};
	const run = (e: MouseEvent) => {
		const d = down;
		down = null;
		// 拖动（选文字 / 拖链接）超过 4px 不算点击
		if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
		void handleExternalClick(e, deps);
	};
	window.addEventListener("mousedown", onDown, true);
	window.addEventListener("click", run, true);
	window.addEventListener("auxclick", run, true); // 中键
	return () => {
		window.removeEventListener("mousedown", onDown, true);
		window.removeEventListener("click", run, true);
		window.removeEventListener("auxclick", run, true);
	};
}
