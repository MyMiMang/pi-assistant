/**
 * 快速操作模型 · 基准测试的目标电脑驱动（真实路径）。
 *
 * 这一层把「统一 computer backend」抽象成 `invoke(prefix, tool, args)`：
 *  - 生产：`createMcpInvoke` 经 cua 的 MCP（hostpc 用 `hostMcpCommand`，助理电脑用 `cuaMcpCommand`）调用
 *    `get_window_state` / `list_windows` / `click` / `scroll` / 打开 fixture 的 `launch_app`；
 *    所有动作仍走 cua 自身的权限与保护；
 *  - 测试：注入假 invoke，模拟真 driver 的调用序列（含窗口 token 变化、URL nonce、窗口失焦等）。
 *
 * 重要（2026-10-22 复核）：浏览器 `browser_*` 工具来自 ext-browser（CDP），**不在** cua 的 MCP 工具清单里；
 * 所以真实驱动用 cua 原生的 `launch_app({urls})` 在目标电脑上打开 fixture 窗口，再用 `list_windows` +
 * `get_window_state`（同一条 cua 通道）pin 身份。这样「打开 / 观察 / 派发」都只用 cua MCP 能力，能力探测才有意义。
 *
 * **未验证声明**：本文件是真实 driver 路径的源码实现，但当前开发环境没有开启 hostpc、也没有跑助理电脑 VM，
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

/** 去 `mcp__<prefix>__` 命名空间，MCP `tools/call` 只认裸名；非 MCP 名原样返回。 */
export const bareTool = (t: string) => t.replace(/^mcp__[a-z0-9_-]+__/, "");

export interface InvokeDriverOptions {
	/** 用户显式选择的目标；未授权 / 未启动返回 null。传入 requested 表示用户点名要哪台。 */
	target(requested?: "hostpc" | "computer"): { prefix: "hostpc" | "computer"; session?: string } | null;
	invoke: ComputerInvoke;
	/** fixture 页面在目标电脑里的可达 URL；返回 null = 该目标没有安全可达地址（fail-closed）。 */
	fixtureUrl(path: string, prefix: "hostpc" | "computer"): string | null;
	/**
	 * 打开 fixture 窗口的工具与参数。默认用 cua 原生 `launch_app`（用 `urls` 交给应用打开目标地址）。
	 * 平台 / 后端没有该能力时 `capable()` 必须 false（fail-closed），不假装 ready。
	 */
	open?: (url: string) => { tool: string; args: Record<string, unknown> };
	/** 能力探测（由 runtime 缓存后注入）；不提供 = fail-closed，不默认 true。 */
	capable?: () => { ok: boolean; reason?: string };
	/** 结束后关闭自有 fixture 窗口的可选实现；不提供则不关（绝不 kill 用户浏览器）。 */
	closeOwn?: (handle: FixtureWindowHandle) => Promise<void>;
}

const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);

/** 默认打开方式：cua 原生 launch_app，把 fixture 地址作为待打开目标交给应用。 */
export const defaultOpenTool = "launch_app";
const defaultOpen = (url: string) => ({ tool: defaultOpenTool, args: { urls: [url] } });

/**
 * 用统一 backend 调用构造真实 driver。所有失败都 fail-closed（返回 null / ok:false），绝不「大概是它」。
 */
export function createInvokeBenchmarkDriver(opts: InvokeDriverOptions): BenchmarkDriver {
	const open = opts.open ?? defaultOpen;
	return {
		target: (requested) => opts.target(requested),
		capable: () => opts.capable?.() ?? { ok: false, reason: "未提供目标电脑能力探测（fail-closed，不默认可用）" },
		// 经统一 computer backend（cua MCP）真实调用；来源标 cua，不是测试假驱动
		provenance: () => "cua",

		async openFixtureWindow({ url, fixtureId, nonce, target }) {
			const sel = opts.target(target);
			if (!sel) throw new Error("目标电脑未授权或未启动");
			const absolute = opts.fixtureUrl(url, sel.prefix);
			if (!absolute) throw new Error("目标电脑没有安全可达的 fixture 地址（需要受控宿主网关）");
			const { tool: openTool, args: openArgs } = open(absolute);
			const opened = await opts.invoke(sel.prefix, bareTool(openTool), { ...openArgs, ...(sel.session ? { session: sel.session } : {}) });
			if (opened.isError) throw new Error(`打开 fixture 窗口失败：${opened.contentText ?? "未知错误"}`);
			// 用 list_windows 找到标题 / URL 里带 fixtureId + nonce 的那一个窗口（只认唯一命中）。
			const listed = await opts.invoke(sel.prefix, "list_windows", { ...(sel.session ? { session: sel.session } : {}) });
			const windows = (asObj(listed.structuredContent)?.windows ?? asObj(listed.structuredContent)?.result ?? []) as unknown;
			const match = pickFixtureWindow(windows, fixtureId, nonce);
			if (!match) throw new Error("找不到带本次 fixture nonce 的独立窗口（fail-closed）");
			const state = await opts.invoke(sel.prefix, "get_window_state", { pid: match.pid, window_id: match.windowId, tree_format: "elements", ...(sel.session ? { session: sel.session } : {}) });
			// cua `get_window_state` 只给 `snapshot_id`（每次读取都换新），没有 `window_token`；用它作为「拿到了新鲜快照」标记。
			const token = asObj(state.structuredContent)?.snapshot_id ?? asObj(state.structuredContent)?.window_token ?? asObj(state.structuredContent)?.windowToken;
			if (typeof token !== "string" || !token) throw new Error("读不到窗口快照 id（fail-closed）");
			const handle: FixtureWindowHandle = { prefix: sel.prefix, session: sel.session, pid: match.pid, windowId: match.windowId, windowToken: token, fixtureId, url: absolute };
			return {
				handle,
				close: async () => {
					// 只关本次打开的 fixture 窗口（若后端提供受控关闭接口）；绝不 kill 整个浏览器 / 动别的窗口。
					if (opts.closeOwn) await opts.closeOwn(handle).catch(() => {});
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
			return opts.invoke(handle.prefix, bareTool(tool), args);
		},
	};
}

/** 从 get_window_state 的 structuredContent 抽出窗口身份；fixture_id 取自 URL / 标题上的 nonce 标记。 */
function observedFrom(s: Record<string, unknown>, handle: FixtureWindowHandle): ObservedWindow | null {
	// 真实 cua 返回 `snapshot_id`；`window_token` 仅作兼容。
	const token = s.snapshot_id ?? s.window_token ?? s.windowToken;
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
