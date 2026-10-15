/**
 * 快速操作模型 · 基准测试的目标电脑驱动（真实路径）。
 *
 * 这一层把「统一 computer backend」抽象成 `invoke(prefix, tool, args)`：
 *  - 生产：`createMcpInvoke` 经 cua 的 MCP（hostpc 用 `hostMcpCommand`，助理电脑用 `cuaMcpCommand`）调用
 *    `browser_prepare` / `browser_navigate` / `get_browser_state` / `get_window_state` / `list_windows` /
 *    `click` / `scroll` / `launch_app`；所有动作仍走受限权限桥（暂停 / 档位）。
 *  - 测试：注入假 invoke，模拟真 driver 的调用序列（含窗口 token 变化、URL nonce、隔离浏览器绑定）。
 *
 * 窗口来源（2026-10-22，字段以官方 cua-driver 0.35.4 为准）：
 *  - hostpc 用**驱动自有隔离浏览器**（`browser_prepare {allow_launch:true, profile:{mode:"isolated_new"}}`），
 *    不用用户日常 Chrome / launch_app。官方隔离启动**只返回 `prepared_pid`**，因此正确序列是：
 *    prepare(prepared_pid) → list_windows(pid) → get_browser_state(pid, window_id) 绑定拿 target_id/tab_id
 *    + 精确绑定证据 → browser_navigate(target_id, url 带 nonce) → get_browser_state(target_id, tab_id) 复核 URL + 快照 id。
 *    （旧实现把 target_id 挂在 prepare 上，会让隔离路径永远 fail-closed。）
 *  - computer（助理电脑 VM）天然隔离，仍用 cua 原生 `launch_app({urls})` 打开 fixture 窗口（配合宿主网关）。
 *
 * **未验证声明**：本文件是真实 driver 路径的源码实现，但当前开发环境没有开启 hostpc、也没有跑助理电脑 VM，
 * 因此**没有在真实桌面上验证过**。CI / 无真实 CUA 环境一律走 blocked，不 mock 冒充 ready。
 */
import type { BenchmarkDriver, FixtureWindowHandle } from "./benchmark-host.ts";
import type { ObservedWindow } from "./benchmark.ts";
import { benchmarkToolGuard, type BenchmarkGuardInput } from "./benchmark-guard.ts";
import { fixtureUrlMatches, parseBrowserBinding, parsePreparedBrowser, pickWindowForPid, type FixtureWindowKind } from "./benchmark-window.ts";

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
	 * 打开 fixture 窗口的工具与参数（仅 **sandbox-app** 路径）。默认用 cua 原生 `launch_app`（用 `urls` 交给应用打开目标地址）。
	 * 平台 / 后端没有该能力时 `capable()` 必须 false（fail-closed），不假装 ready。
	 */
	open?: (url: string) => { tool: string; args: Record<string, unknown> };
	/** 该目标用哪种隔离窗口来源；由 runtime 的 `planFixtureWindow` 推断。默认 hostpc=driver-isolated-browser / computer=sandbox-app。 */
	windowKindOf?: (prefix: "hostpc" | "computer") => FixtureWindowKind | null;
	/** 受限权限桥（暂停 / 档位）；不提供则不做额外拦截（测试 / 内部调用）。传入裸工具名。 */
	guard?: (input: { prefix: "hostpc" | "computer"; tool: string }) => { ok: boolean; reason?: string };
	/** 能力探测（由 runtime 缓存后注入）；不提供 = fail-closed，不默认 true。 */
	capable?: () => { ok: boolean; reason?: string };
	/** 结束后关闭自有 fixture 窗口的可选实现；driver-isolated-browser 有内置实现（kill 自有 pid）。 */
	closeOwn?: (handle: FixtureWindowHandle) => Promise<void>;
}

const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);

/** 默认打开方式：cua 原生 launch_app，把 fixture 地址作为待打开目标交给应用（沙箱路径）。 */
export const defaultOpenTool = "launch_app";
const defaultOpen = (url: string) => ({ tool: defaultOpenTool, args: { urls: [url] } });

/**
 * 用统一 backend 调用构造真实 driver。所有失败都 fail-closed（返回 null / ok:false / 抛错），绝不「大概是它」。
 */
export function createInvokeBenchmarkDriver(opts: InvokeDriverOptions): BenchmarkDriver {
	const open = opts.open ?? defaultOpen;
	const windowKindOf = (prefix: "hostpc" | "computer"): FixtureWindowKind =>
		opts.windowKindOf?.(prefix) ?? (prefix === "hostpc" ? "driver-isolated-browser" : "sandbox-app");

	/** 每次 backend 调用前过受限权限桥（暂停 / 只看档位）；拒绝的调用直接作为 isError 返回，不派发。 */
	const call = async (prefix: "hostpc" | "computer", tool: string, args: Record<string, unknown>): Promise<InvokeResult> => {
		const bare = bareTool(tool);
		if (opts.guard) {
			const g = opts.guard({ prefix, tool: bare });
			if (!g.ok) return { isError: true, contentText: g.reason ?? "基准动作被权限桥拒绝" };
		}
		return opts.invoke(prefix, tool, args);
	};

	const openSandboxApp = async (prefix: "hostpc" | "computer", session: string | undefined, absolute: string, fixtureId: string, nonce: string) => {
		const s = session ? { session } : {};
		const { tool: openTool, args: openArgs } = open(absolute);
		const opened = await call(prefix, bareTool(openTool), { ...openArgs, ...s });
		if (opened.isError) throw new Error(`打开 fixture 窗口失败：${opened.contentText ?? "未知错误"}`);
		// 用 list_windows 找到标题 / URL 里带 fixtureId + nonce 的那一个窗口（只认唯一命中）。
		const listed = await call(prefix, "list_windows", { ...s });
		const windows = (asObj(listed.structuredContent)?.windows ?? asObj(listed.structuredContent)?.result ?? []) as unknown;
		const match = pickFixtureWindow(windows, fixtureId, nonce);
		if (!match) throw new Error("找不到带本次 fixture nonce 的独立窗口（fail-closed）");
		const state = await call(prefix, "get_window_state", { pid: match.pid, window_id: match.windowId, tree_format: "elements", ...s });
		// cua `get_window_state` 只给 `snapshot_id`（每次读取都换新），没有 `window_token`；用它作为「拿到了新鲜快照」标记。
		const token = asObj(state.structuredContent)?.snapshot_id ?? asObj(state.structuredContent)?.window_token ?? asObj(state.structuredContent)?.windowToken;
		if (typeof token !== "string" || !token) throw new Error("读不到窗口快照 id（fail-closed）");
		const handle: FixtureWindowHandle = { prefix, session, pid: match.pid, windowId: match.windowId, windowToken: token, fixtureId, url: absolute };
		return { handle, close: async () => void (await opts.closeOwn?.(handle).catch(() => {})) };
	};

	const openDriverBrowser = async (prefix: "hostpc" | "computer", session: string | undefined, absolute: string, fixtureId: string, nonce: string) => {
		const s = session ? { session } : {};
		// 1) 拉起驱动自有的隔离浏览器（官方 attested 路径；不用用户日常 profile）。隔离启动只保证返回 `prepared_pid`。
		const prep = await call(prefix, "browser_prepare", { allow_launch: true, profile: { mode: "isolated_new" }, ...s });
		if (prep.isError) throw new Error(`打开驱动自有隔离浏览器失败：${prep.contentText ?? "未知错误"}`);
		const prepared = parsePreparedBrowser(prep.structuredContent);
		if (!prepared) throw new Error("驱动没有返回 prepared_pid，无法证明是本次自有的隔离浏览器（fail-closed）");
		// 2) 列该自有进程的窗口，pin 原生 pid/window_id（隔离浏览器刚启动一般是唯一 / 空白窗口）。
		const listed = await call(prefix, "list_windows", { pid: prepared.preparedPid, ...s });
		const windows = (asObj(listed.structuredContent)?.windows ?? asObj(listed.structuredContent)?.result ?? []) as unknown;
		const win = pickWindowForPid(windows, prepared.preparedPid);
		if (!win) throw new Error("找不到驱动自有隔离浏览器的窗口（fail-closed）");
		// 3) bind：拿 target_id/tab_id + 精确绑定证据（此时 URL 还是空白，不能用 fixture nonce 校验）。
		const bind = await call(prefix, "get_browser_state", { pid: win.pid, window_id: win.windowId, snapshot_format: "semantic_v2", ...s });
		if (bind.isError) throw new Error(`绑定隔离浏览器失败：${bind.contentText ?? "未知错误"}`);
		const binding = parseBrowserBinding(bind.structuredContent);
		if (!binding.ok) throw new Error(binding.reason ?? "隔离浏览器绑定校验失败（fail-closed）");
		if (!binding.targetId) throw new Error("隔离浏览器绑定没有 target_id，无法导航（fail-closed）");
		// 4) 在隔离浏览器里打开本次随机 nonce 的 fixture。
		const navArgs: Record<string, unknown> = { target_id: binding.targetId, url: absolute, ...s };
		if (binding.tabId) navArgs.tab_id = binding.tabId;
		const nav = await call(prefix, "browser_navigate", navArgs);
		if (nav.isError) throw new Error(`在隔离浏览器里打开 fixture 失败：${nav.contentText ?? "未知错误"}`);
		// 5) 复核：URL 必须带本次 fixtureId+nonce，并重新拿可 pin 的快照 id。
		const stateArgs: Record<string, unknown> = { target_id: binding.targetId, snapshot_format: "semantic_v2", ...s };
		if (binding.tabId) stateArgs.tab_id = binding.tabId;
		const state = await call(prefix, "get_browser_state", stateArgs);
		if (state.isError) throw new Error(`复核隔离浏览器状态失败：${state.contentText ?? "未知错误"}`);
		const verified = parseBrowserBinding(state.structuredContent, { fixtureId, nonce });
		if (!verified.ok) throw new Error(verified.reason ?? "隔离浏览器 fixture 校验失败（fail-closed）");
		const ownerPid = verified.ownerPid ?? binding.ownerPid ?? prepared.preparedPid;
		const handle: FixtureWindowHandle = { prefix, session, pid: win.pid, windowId: win.windowId, windowToken: verified.token!, fixtureId, url: absolute };
		return {
			handle,
			close: async () => {
				// 只关**驱动自有**的隔离浏览器进程（prepared_pid 由本次 browser_prepare 拉起）；拿不到就不关。
				if (ownerPid === undefined) return;
				if (opts.closeOwn) {
					await opts.closeOwn(handle).catch(() => {});
					return;
				}
				await call(prefix, "kill_app", { pid: ownerPid, ...s });
			},
		};
	};

	return {
		target: (requested) => opts.target(requested),
		capable: () => opts.capable?.() ?? { ok: false, reason: "未提供目标电脑能力探测（fail-closed，不默认可用）" },
		// 经统一 computer backend（cua MCP）真实调用；来源标 cua，不是测试假驱动
		provenance: () => "cua",
		windowKind: (prefix) => windowKindOf(prefix),

		async openFixtureWindow({ url, fixtureId, nonce, target }) {
			const sel = opts.target(target);
			if (!sel) throw new Error("目标电脑未授权或未启动");
			const absolute = opts.fixtureUrl(url, sel.prefix);
			if (!absolute) throw new Error("目标电脑没有安全可达的 fixture 地址（需要受控宿主网关）");
			if (!fixtureUrlMatches(absolute, fixtureId, nonce)) throw new Error("fixture 地址缺少本次 nonce（fail-closed）");
			const kind = windowKindOf(sel.prefix);
			return kind === "driver-isolated-browser" ? openDriverBrowser(sel.prefix, sel.session, absolute, fixtureId, nonce) : openSandboxApp(sel.prefix, sel.session, absolute, fixtureId, nonce);
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
			return call(handle.prefix, bareTool(tool), args);
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
