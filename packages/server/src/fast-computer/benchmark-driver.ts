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
 *    prepare(prepared_pid) → list_windows(pid) → get_browser_state(pid, window_id) 绑定拿 target_id + tabs[].tab_id
 *    + 精确绑定证据（此阶段官方**没有**页面快照） → browser_navigate(target_id, tab_id, url 带 nonce) →
 *    get_browser_state(target_id, tab_id, semantic_v2) 复核 `page.url` + 取 pin `snapshot.id`。
 *    （旧实现把 target_id 挂在 prepare 上、并在 bind 阶段要求 `snapshot_id`，两处都会让隔离路径永远 fail-closed。）
 *  - computer（助理电脑 VM）天然隔离，仍用 cua 原生 `launch_app({urls})` 打开 fixture 窗口（配合宿主网关）。
 *
 * **未验证声明**：本文件是真实 driver 路径的源码实现，但当前开发环境没有开启 hostpc、也没有跑助理电脑 VM，
 * 因此**没有在真实桌面上验证过**。CI / 无真实 CUA 环境一律走 blocked，不 mock 冒充 ready。
 */
import type { BenchmarkDriver, FixtureWindowHandle } from "./benchmark-host.ts";
import type { ObservedWindow } from "./benchmark.ts";
import { benchmarkToolGuard, type BenchmarkGuardInput } from "./benchmark-guard.ts";
import { fixtureUrlMatches, parseBrowserBind, parseBrowserSnapshot, parsePreparedBrowser, pickWindowForPid, type FixtureWindowKind } from "./benchmark-window.ts";

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
	/** 能力探测（由 runtime 缓存后注入）；不提供 = fail-closed，不默认 true。传 requested 按点名的那台电脑判定。 */
	capable?: (requested?: "hostpc" | "computer") => { ok: boolean; reason?: string };
	/** 结束后关闭自有 fixture 窗口的可选实现；driver-isolated-browser 有内置实现（kill 自有 pid）。 */
	closeOwn?: (handle: FixtureWindowHandle) => Promise<void>;
}

const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
const firstStringStatic = (...vals: unknown[]): string | undefined => {
	for (const v of vals) if (typeof v === "string" && v) return v;
	return undefined;
};

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
		if (opened.isError) throw new Error(`打开 fixture 窗口失败：${shortError(opened.contentText)}`);
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
		if (prep.isError) throw new Error(`打开驱动自有隔离浏览器失败：${shortError(prep.contentText)}`);
		const prepared = parsePreparedBrowser(prep.structuredContent);
		if (!prepared) throw new Error("驱动没有返回 prepared_pid，无法证明是本次自有的隔离浏览器（fail-closed）");
		// 2) 列该自有进程的窗口，pin 原生 pid/window_id（隔离浏览器刚启动一般是唯一 / 空白窗口）。
		const listed = await call(prefix, "list_windows", { pid: prepared.preparedPid, ...s });
		const windows = (asObj(listed.structuredContent)?.windows ?? asObj(listed.structuredContent)?.result ?? []) as unknown;
		const win = pickWindowForPid(windows, prepared.preparedPid);
		if (!win) throw new Error("找不到驱动自有隔离浏览器的窗口（fail-closed）");
		// 3) bind：拿 target_id/tab_id + 精确绑定证据（此时 URL 还是空白，不传 fixture nonce）。
		//    官方 bind 模式**不返回页面快照 id**（只有 snapshot 模式有 `snapshot.id`），这里只能校绑定证据 + 标签。
		const bind = await call(prefix, "get_browser_state", { pid: win.pid, window_id: win.windowId, ...s });
		if (bind.isError) throw new Error(`绑定隔离浏览器失败：${shortError(bind.contentText)}`);
		const binding = parseBrowserBind(bind.structuredContent);
		if (!binding.ok) throw new Error(binding.reason ?? "隔离浏览器绑定校验失败（fail-closed）");
		// 4) 在隔离浏览器里打开本次随机 nonce 的 fixture（用 bind 返回的 target_id + tabs[] 里的 tab_id）。
		const navArgs: Record<string, unknown> = { target_id: binding.targetId, url: absolute, ...s };
		if (binding.tabId) navArgs.tab_id = binding.tabId;
		const nav = await call(prefix, "browser_navigate", navArgs);
		if (nav.isError) throw new Error(`在隔离浏览器里打开 fixture 失败：${shortError(nav.contentText)}`);
		// 5) 复核：读真实页面快照，URL 必须带本次 fixtureId+nonce，pin 取官方 `snapshot.id`。
		const stateArgs: Record<string, unknown> = { target_id: binding.targetId, snapshot_format: "semantic_v2", ...s };
		if (binding.tabId) stateArgs.tab_id = binding.tabId;
		const state = await call(prefix, "get_browser_state", stateArgs);
		if (state.isError) throw new Error(`复核隔离浏览器状态失败：${shortError(state.contentText)}`);
		const verified = parseBrowserSnapshot(state.structuredContent, { fixtureId, nonce });
		if (!verified.ok) throw new Error(verified.reason ?? "隔离浏览器 fixture 校验失败（fail-closed）");
		const ownerPid = verified.ownerPid ?? binding.ownerPid ?? prepared.preparedPid;
		const handle: FixtureWindowHandle = { prefix, session, pid: win.pid, windowId: win.windowId, windowToken: verified.token!, fixtureId, url: absolute, targetId: binding.targetId, tabId: binding.tabId };
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
		capable: (requested) => opts.capable?.(requested) ?? { ok: false, reason: "未提供目标电脑能力探测（fail-closed，不默认可用）" },
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
			if (isBrowserFixture(handle)) {
				// 优先用刚观察到的快照 pin（不新取快照，避免作废即将点击的 ref）。
				const cached = lastObservedToken.get(handle);
				if (cached) return { prefix: handle.prefix, pid: handle.pid, window_id: handle.windowId, session: handle.session, window_token: cached, fixture_id: handle.fixtureId };
				const snap = await readBrowserSnapshot(opts, handle);
				if (!snap.ok) return null;
				lastObservedToken.set(handle, snap.token);
				return { prefix: handle.prefix, pid: handle.pid, window_id: handle.windowId, session: handle.session, window_token: snap.token, fixture_id: handle.fixtureId };
			}
			const r = await opts.invoke(handle.prefix, "get_window_state", { pid: handle.pid, window_id: handle.windowId, tree_format: "elements", ...(handle.session ? { session: handle.session } : {}) });
			if (r.isError) return null;
			const s = asObj(r.structuredContent);
			if (!s) return null;
			return observedFrom(s, handle);
		},

		async observe(handle) {
			// 浏览器 fixture：网页内容不在原生 AX 里（Chrome 后台窗口不暴露 web AX，实测只看到工具栏），
			// 所以用驱动自己的页面快照（refs 形如 `p3:7`），再归一成同一套 elements 形状供收集/判分。
			if (isBrowserFixture(handle)) {
				const snap = await readBrowserSnapshot(opts, handle);
				if (!snap.ok) return { ok: false as const, error: snap.error };
				lastObservedToken.set(handle, snap.token);
				return { ok: true as const, structured: browserSnapshotAsWindow(snap.structured) };
			}
			// 只传官方 get_window_state 认识的入参（0.35.4 实测：没有 `require_complete`，传了直接拒调用）；
			// 要结构化 element_token 就 tree_format:"elements"，并抬一个**有限**的 max_elements 预算（默认 250 对大页会截断）。
			const r = await opts.invoke(handle.prefix, "get_window_state", { pid: handle.pid, window_id: handle.windowId, tree_format: "elements", max_elements: BENCHMARK_MAX_ELEMENTS, ...(handle.session ? { session: handle.session } : {}) });
			if (r.isError) return { ok: false as const, error: shortError(r.contentText) || "读取窗口状态失败" };
			const token = firstStringStatic(asObj(r.structuredContent)?.snapshot_id);
			if (token) lastObservedToken.set(handle, token);
			return { ok: true as const, structured: r.structuredContent };
		},

		async execute(handle, tool, args, signal) {
			if (signal.aborted) return { isError: true };
			if (isBrowserFixture(handle)) return executeInBrowserFixture(call, handle, bareTool(tool), args);
			return call(handle.prefix, bareTool(tool), args);
		},
	};
}

/** 观察窗口时最多走多少个 AX 节点（驱动默认 250，对带页面的浏览器窗口偏小；上限保持有限，不无界拉 AX）。 */
export const BENCHMARK_MAX_ELEMENTS = 600;

/** 从驱动错误里取一行可给用户看的摘要（不把整段内部/AX/协议细节披到 UI）。 */
export function shortError(text: string | undefined): string {
	const raw = (text ?? "").trim();
	if (!raw) return "未知错误";
	try {
		const o = asObj(JSON.parse(raw));
		const code = typeof o?.code === "string" ? o.code : typeof o?.error_code === "string" ? o.error_code : undefined;
		const msg = typeof o?.message === "string" ? o.message : typeof o?.error === "string" ? o.error : undefined;
		if (msg) return code ? `${msg}（${code}）` : msg;
		if (code) return code;
	} catch {
		// 纯文本错误（例如权限桥 / 传输层）：取第一行并截断
	}
	const line = raw.split("\n")[0].trim();
	return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * 每个 fixture 窗口「本次观察到的快照 pin」。
 * 驱动的新快照会作废旧 element/ref（官方：a newer snapshot stales the tokens），
 * 所以动作前的身份复核**不能再取一次快照**（那会把自己即将点击的目标弄成 stale），
 * 而是复用刚刚 observe 到的那个 pin；首次读不到时才真的去读一次。
 */
const lastObservedToken = new WeakMap<FixtureWindowHandle, string>();

/** fixture 是**驱动自有浏览器**里的一个标签页时，动作/观察走浏览器能力（target_id/tab_id），而不是 pid/window 原生输入。 */
const isBrowserFixture = (handle: FixtureWindowHandle): handle is FixtureWindowHandle & { targetId: string; tabId: string } =>
	typeof handle.targetId === "string" && !!handle.targetId && typeof handle.tabId === "string" && !!handle.tabId;

/** 读页面快照（semantic_v2）并取官方 pin `snapshot.id`；失败给可读原因。 */
async function readBrowserSnapshot(
	opts: InvokeDriverOptions,
	handle: FixtureWindowHandle & { targetId: string; tabId: string },
): Promise<{ ok: true; token: string; structured: Record<string, unknown> } | { ok: false; error: string }> {
	const r = await opts.invoke(handle.prefix, "get_browser_state", {
		target_id: handle.targetId,
		tab_id: handle.tabId,
		snapshot_format: "semantic_v2",
		...(handle.session ? { session: handle.session } : {}),
	});
	if (r.isError) return { ok: false, error: shortError(r.contentText) || "读取页面快照失败" };
	const s = asObj(r.structuredContent);
	const token = firstStringStatic(asObj(s?.snapshot)?.id, s?.snapshot_id, s?.state_id);
	if (!s || !token) return { ok: false, error: "页面快照没有可 pin 的快照 id（driver 约定 snapshot.id）" };
	return { ok: true, token, structured: s };
}

/**
 * 把页面快照（`refs[]`）归一成与原生窗口一致的 elements 形状，让候选收集 / 目标新鲜度 / 判分三层复用同一套逻辑。
 * `element_token` 就放 ref（如 `p3:7`）；真正派发时由 `executeInBrowserFixture` 换成 `ref`。
 */
export function browserSnapshotAsWindow(structured: unknown): Record<string, unknown> {
	const s = asObj(structured) ?? {};
	// 页面里的 `role=status` 之类状态元素是**内容节点**（无动作），只在 `content_refs` 里；
	// 独立 UI 证据要看到它们，所以两类 ref 都归一成 elements（去重），但候选收集只会取有动作的。
	const actionRefs = Array.isArray(s.refs) ? s.refs : [];
	const contentRefs = Array.isArray(s.content_refs) ? s.content_refs : [];
	const seen = new Set<string>();
	const elements: Record<string, unknown>[] = [];
	for (const [kind, list] of [
		["action", actionRefs],
		["content", contentRefs],
	] as const) {
		for (const raw of list) {
			const r = asObj(raw) ?? {};
			const token = firstStringStatic(r.ref);
			if (!token || seen.has(token)) continue;
			seen.add(token);
			elements.push({
				element_index: elements.length,
				element_token: token,
				role: typeof r.role === "string" ? r.role : undefined,
				label: typeof r.name === "string" ? r.name : undefined,
				value: typeof r.value === "string" ? r.value : (r.value ?? undefined),
				actions: kind === "action" && Array.isArray(r.actions) ? r.actions : [],
				frame: r.frame,
			});
		}
	}
	const page = asObj(s.page) ?? {};
	return { ...s, elements, snapshot_id: firstStringStatic(asObj(s.snapshot)?.id, s.snapshot_id), url: page.url, title: page.title };
}

/** 浏览器 fixture 的派发适配：`click`→`browser_click{ref}`、程序侧 `scroll`→`browser_pointer{action:scroll}`。 */
async function executeInBrowserFixture(
	call: (prefix: "hostpc" | "computer", tool: string, args: Record<string, unknown>) => Promise<InvokeResult>,
	handle: FixtureWindowHandle & { targetId: string; tabId: string },
	tool: string,
	args: Record<string, unknown>,
): Promise<InvokeResult> {
	const session = handle.session ? { session: handle.session } : {};
	const base = { target_id: handle.targetId, tab_id: handle.tabId, ...session };
	const token = firstStringStatic(args.element_token, args.ref);
	if (tool === "click" || tool === "browser_click") {
		if (!token) return { isError: true, contentText: "点击候选缺少 ref（fail-closed）" };
		return call(handle.prefix, "browser_click", { ...base, ref: token });
	}
	if (tool === "scroll" || tool === "browser_pointer") {
		const amount = Number(args.amount ?? 3);
		const direction = String(args.direction ?? "down");
		const step = (Number.isFinite(amount) && amount > 0 ? amount : 3) * 120;
		const ref = firstStringStatic(args.ref);
		// 官方 `browser_pointer{action:"scroll"}` 必须给 ref 或视口坐标；没有 ref 时用**有界的视口中心**（不猜页面坐标）。
		const point = ref ? { ref } : { x: 600, y: 400 };
		return call(handle.prefix, "browser_pointer", {
			...base,
			...point,
			action: "scroll",
			delta_y: direction === "up" ? -step : step,
			delta_x: direction === "left" ? -step : direction === "right" ? step : 0,
		});
	}
	return call(handle.prefix, tool, args);
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
