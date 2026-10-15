/**
 * 快速操作模型 · 基准测试的目标电脑驱动（真实路径）。
 *
 * 这一层把「统一 computer backend」抽象成 `invoke(prefix, tool, args)`：
 *  - 生产：`createMcpInvoke` 经 cua 的 MCP（hostpc 用 `hostMcpCommand`，助理电脑用 `cuaMcpCommand`）调用
 *    `get_window_state` / `list_windows` / `click` / 打开 fixture 的浏览器工具；所有动作仍走 cua 自身的权限与保护；
 *  - 测试：注入假 invoke，模拟真 driver 的调用序列（含窗口 token 变化、URL nonce、窗口失焦等）。
 *
 * **重要（未验证声明）**：本文件是真实 driver 路径的源码实现，但当前开发环境没有开启 hostpc、也没有跑助理电脑 VM，
 * 因此**没有在真实桌面上验证过**。CI / 无真实 CUA 环境一律走 blocked，不 mock 冒充 ready。
 */
import type { BenchmarkDriver, FixtureWindowHandle } from "./benchmark-host.ts";
import type { ObservedWindow } from "./benchmark.ts";

export interface InvokeResult {
	isError: boolean;
	structuredContent?: unknown;
	contentText?: string;
}

/** 统一 computer backend 调用：prefix = hostpc|computer，tool = 裸工具名（如 get_window_state / click）。 */
export type ComputerInvoke = (prefix: "hostpc" | "computer", tool: string, args: Record<string, unknown>) => Promise<InvokeResult>;

export interface InvokeDriverOptions {
	/** 用户显式选择的目标；未授权 / 未启动返回 null。传入 requested 表示用户点名要哪台。 */
	target(requested?: "hostpc" | "computer"): { prefix: "hostpc" | "computer"; session?: string } | null;
	invoke: ComputerInvoke;
	/** fixture 页面在目标电脑里的可达 URL（本机默认就是相对路径拼出的绝对地址）。 */
	fixtureUrl(path: string): string;
	/** 打开 fixture 页面用的浏览器工具名（默认 `browser_navigate`，new_tab = true）。 */
	openTool?: string;
	/** 能否拿到独立受控 fixture 窗口证明；默认 true。 */
	capable?: () => { ok: boolean; reason?: string };
}

const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);

/**
 * 用统一 backend 调用构造真实 driver。所有失败都 fail-closed（返回 null / ok:false），绝不「大概是它」。
 */
export function createInvokeBenchmarkDriver(opts: InvokeDriverOptions): BenchmarkDriver {
	return {
		target: (requested) => opts.target(requested),
		capable: () => opts.capable?.() ?? { ok: true },
		// 经统一 computer backend（cua MCP）真实调用；来源标 cua，不是测试假驱动
		provenance: () => "cua",

		async openFixtureWindow({ url, fixtureId, nonce, target }) {
			const sel = opts.target(target);
			if (!sel) throw new Error("目标电脑未授权或未启动");
			const absolute = opts.fixtureUrl(url);
			const openTool = opts.openTool ?? "browser_navigate";
			const opened = await opts.invoke(sel.prefix, openTool, { url: absolute, new_tab: true, ...(sel.session ? { session: sel.session } : {}) });
			if (opened.isError) throw new Error(`打开 fixture 窗口失败：${opened.contentText ?? "未知错误"}`);
			// 用 list_windows 找到标题 / URL 里带 fixtureId + nonce 的那一个窗口（只认唯一命中）。
			const listed = await opts.invoke(sel.prefix, "list_windows", { ...(sel.session ? { session: sel.session } : {}) });
			const windows = (asObj(listed.structuredContent)?.windows ?? asObj(listed.structuredContent)?.result ?? []) as unknown;
			const match = pickFixtureWindow(windows, fixtureId, nonce);
			if (!match) throw new Error("找不到带本次 fixture nonce 的独立窗口（fail-closed）");
			const state = await opts.invoke(sel.prefix, "get_window_state", { pid: match.pid, window_id: match.windowId, tree_format: "elements", ...(sel.session ? { session: sel.session } : {}) });
			const token = asObj(state.structuredContent)?.window_token ?? asObj(state.structuredContent)?.windowToken;
			if (typeof token !== "string" || !token) throw new Error("读不到窗口身份 token（fail-closed）");
			const handle: FixtureWindowHandle = { prefix: sel.prefix, session: sel.session, pid: match.pid, windowId: match.windowId, windowToken: token, fixtureId, url: absolute };
			return {
				handle,
				close: async () => {
					// 只关闭本次打开的 fixture 标签页 / 窗口；不 kill 整个浏览器、不动别的窗口。
					await opts.invoke(sel.prefix, "browser_tabs", { action: "close", ...(sel.session ? { session: sel.session } : {}) }).catch(() => {});
				},
			};
		},

		async readWindow(handle) {
			const r = await opts.invoke(handle.prefix, "get_window_state", { pid: handle.pid, window_id: handle.windowId, tree_format: "elements", ...(handle.session ? { session: handle.session } : {}) });
			if (r.isError) return null;
			const s = asObj(r.structuredContent);
			if (!s) return null;
			return observedFrom(s, handle);
		},

		async observe(handle) {
			const r = await opts.invoke(handle.prefix, "get_window_state", { pid: handle.pid, window_id: handle.windowId, tree_format: "elements", require_complete: true, ...(handle.session ? { session: handle.session } : {}) });
			if (r.isError) return { ok: false as const, error: r.contentText ?? "读取窗口状态失败" };
			return { ok: true as const, structured: r.structuredContent };
		},

		async execute(handle, tool, args, signal) {
			if (signal.aborted) return { isError: true };
			return opts.invoke(handle.prefix, tool, args);
		},
	};
}

/** 从 get_window_state 的 structuredContent 抽出窗口身份；fixture_id 取自 URL / 标题上的 nonce 标记。 */
function observedFrom(s: Record<string, unknown>, handle: FixtureWindowHandle): ObservedWindow | null {
	const token = s.window_token ?? s.windowToken;
	const pid = s.pid ?? s.owner_pid;
	const windowId = s.window_id ?? s.windowId;
	if (typeof token !== "string" || typeof pid !== "number" || typeof windowId !== "number") return null;
	return { prefix: handle.prefix, pid, window_id: windowId, session: handle.session, window_token: token, fixture_id: handle.fixtureId };
}

/** 只接受唯一匹配 fixtureId + nonce 的窗口；多个 / 0 个都 fail-closed。 */
export function pickFixtureWindow(windows: unknown, fixtureId: string, nonce: string): { pid: number; windowId: number } | null {
	if (!Array.isArray(windows)) return null;
	const hits = windows
		.map((w) => asObj(w))
		.filter((w): w is Record<string, unknown> => !!w)
		.filter((w) => {
			const blob = `${w.title ?? ""} ${w.url ?? ""}`;
			return blob.includes(fixtureId) && blob.includes(nonce);
		})
		.map((w) => ({ pid: Number(w.pid), windowId: Number(w.window_id ?? w.windowId) }))
		.filter((w) => Number.isFinite(w.pid) && Number.isFinite(w.windowId));
	return hits.length === 1 ? hits[0] : null;
}
