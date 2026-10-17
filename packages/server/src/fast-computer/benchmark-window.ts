/**
 * 快速操作模型 · 真实操控基准测试 —— 专用 fixture 窗口的**生命周期计划**（纯逻辑，可注入）。
 *
 * 背景（2026-10-22 用户要求「一键真实测试」）：
 *  - 以前 hostpc 目标要求用户手填「是否提供隔离测试窗口」这种安全开关，助理电脑要求手填宿主网关基址，
 *    结果按钮在两台电脑上默认永远 blocked。用户要的是点一下就能真跑，不是手填参数或无效开关。
 *  - 但「不能自动开窗口」也不能省：GET availability 必须无副作用，**只能在 POST bootstrap（用户点了「开始实际操作测试」）里
 *    才创建窗口**。所以能力探测只回答「**可不可以准备**」（preparable），真正的窗口生命周期在 start 时执行。
 *
 * 这个模块不认识 MCP / CUA，只吃工具名清单与驱动返回的 JSON，因此能在单测里完整验证：
 *  - `planFixtureWindow`：只凭 tools/list 判断这台电脑有没有「驱动自有、与日常环境隔离」的窗口来源；
 *  - `parsePreparedBrowser` / `parseBrowserBinding`：把 `browser_prepare` / `get_browser_state` 的返回收紧成
 *    可 pin 的精确身份；任何缺失都 fail-closed。
 *    **字段以官方 cua-driver 为准**（0.35.4 实测真实响应，本机 2026-10-17，见 docs/design/fast-model-benchmark.md「隔离浏览器 pin 契约」）：
 *    隔离启动 `browser_prepare{allow_launch,profile.isolated_new}` 只返回 `prepared_pid`（没有 `target_id` / `window_id`）；
 *    `get_browser_state` **两种模式返回不同字段**：
 *      - bind（`pid`+`window_id`）：`{status:"ok",mode:"bind",binding_quality:"exact",mutation_allowed:true,target_id,
 *        tabs:[{tab_id,url,title,active}],native_title,binding_route,…}` —— **只证明「窗口↔CDP target」，不开页面快照，
 *        所以没有 `snapshot_id` / `snapshot` / 顶层 `url`**；标签 id 只在 `tabs[]` 里。
 *      - snapshot（`target_id`+`tab_id`+`snapshot_format:"semantic_v2"`）：`{status:"ok",mode:"snapshot",target_id,tab_id,
 *        page:{title,url},snapshot:{id:"p1",format:"semantic_v2",complete,…},outline,refs:[{ref:"p1:0"}],content_refs}`` ——
 *        **pin 是 `snapshot.id`（refs 前缀 `p<n>` 就是它）**，页面 URL 在 `page.url`，顶层**没有** `binding_quality`。
 *    旧实现要求 **bind 就返回 `snapshot_id`**，于是隔离路径每次都在「点开始」后立刻报 pin fail-closed（beta.29 实测 bug）。
 *  - `fixtureUrlMatches`：fixture URL 必须同时带本次 fixtureId + nonce，防串扰。
 */
import { BENCHMARK_FIXTURE_BASE } from "./benchmark-fixture.ts";

/** fixture 窗口来源：驱动自有的隔离浏览器（hostpc）或沙箱里的应用窗口（助理电脑 VM）。 */
export type FixtureWindowKind = "driver-isolated-browser" | "sandbox-app";

/** 驱动自有隔离浏览器所需能力（官方 browser_prepare 的 isolated_new / isolated_named 路径）。 */
export const DRIVER_BROWSER_TOOLS = ["browser_prepare", "browser_navigate", "get_browser_state"] as const;
/** 沙箱应用窗口所需能力（cua 原生 launch_app + 窗口观察）。 */
export const SANDBOX_APP_TOOLS = ["list_windows", "get_window_state", "click", "scroll"] as const;

export interface FixtureWindowPlan {
	ok: boolean;
	/** ok:true 时的窗口来源类型。 */
	kind?: FixtureWindowKind;
	/** ok:false 时的中文原因（直接给 UI）。 */
	reason?: string;
}

export interface FixtureWindowPlanInput {
	prefix: "hostpc" | "computer";
	/** 目标 MCP 暴露的工具名清单（裸名）；`null` = 读不到 → fail-closed。 */
	tools: readonly string[] | null;
	/** 沙箱打开 fixture 用的工具名；默认 `launch_app`。 */
	openTool?: string;
	/** 助理电脑的宿主 fixture 网关；`undefined`/`null` = 未提供 → 该目标不可准备。 */
	gateway?: { ok: boolean; reason?: string } | null;
}

/**
 * 判断这台目标电脑能否为基准取得一个**隔离的 fixture 窗口**。只看工具清单，**不开窗口、无副作用**。
 *  - hostpc：必须能拿到「驱动自有的隔离浏览器」（browser_prepare + browser_navigate + get_browser_state），
 *    否则 fail-closed（绝不用用户日常 Chrome / launch_app 打开用户默认浏览器当 sandbox）。
 *  - computer：助理电脑天然隔离，但 fixture 页面要经受控宿主网关加载（不把 Pi 控制 API 暴露到 0.0.0.0）。
 */
export function planFixtureWindow(input: FixtureWindowPlanInput): FixtureWindowPlan {
	if (input.tools === null) return { ok: false, reason: "读不到目标电脑的能力清单（连接失败或未授权），无法证明能取得独立受控窗口" };
	const have = new Set(input.tools);
	if (input.prefix === "hostpc") {
		const missing = DRIVER_BROWSER_TOOLS.filter((t) => !have.has(t));
		if (missing.length) {
			return { ok: false, reason: `用户电脑没有可用的「驱动自有隔离浏览器」能力：${missing.join("、")}（不用你的日常浏览器 profile，fail-closed）` };
		}
		return { ok: true, kind: "driver-isolated-browser" };
	}
	const required = [input.openTool ?? "launch_app", ...SANDBOX_APP_TOOLS];
	const missing = required.filter((t) => !have.has(t));
	if (missing.length) return { ok: false, reason: `助理电脑缺少取得独立窗口所需能力：${missing.join("、")}` };
	if (input.gateway && !input.gateway.ok) return { ok: false, reason: input.gateway.reason ?? "助理电脑没有安全可达的宿主 fixture 网关（不把 Pi 控制 API 暴露到 0.0.0.0）" };
	// 能拿到驱动自有隔离浏览器就用它（独立 profile / 窗口）；否则退回 sandbox-app（launch_app 打开专用窗口）。
	if (DRIVER_BROWSER_TOOLS.every((t) => have.has(t))) return { ok: true, kind: "driver-isolated-browser" };
	return { ok: true, kind: "sandbox-app" };
}

/**
 * 从 `browser_prepare` 的返回里取出驱动自有隔离浏览器的进程 pid。
 * 官方 isolated_new / isolated_named 只保证返回 `prepared_pid`（`target_id` / `tab_id` 要 bind 之后才有）；
 * 拿不到 pid 就无法证明「这是本次驱动拉起的自有进程」→ null（fail-closed）。
 */
export function parsePreparedBrowser(structured: unknown): { preparedPid: number } | null {
	const s = asObj(structured);
	if (!s) return null;
	const pid = firstNumber(s.prepared_pid, s.preparedPid, s.pid, s.owner_pid, s.ownerPid);
	if (pid === undefined) return null;
	return { preparedPid: pid };
}

export interface BrowserBinding {
	ok: boolean;
	reason?: string;
	/** 驱动自有浏览器进程 pid（仅当能证明是本次 driver 拉起时非空，关闭只 kill 它）。 */
	ownerPid?: number;
	tabId?: string;
	/** 导航 / snapshot 需要的绑定 target id（由 get_browser_state 绑定后给出）。 */
	targetId?: string;
	/** 页面快照 **pin**（真实字段 `snapshot.id`，如 `p1`；refs 前缀就取自它）。只有 snapshot 模式有。 */
	token?: string;
	url?: string;
}

/**
 * 校验 `get_browser_state` **绑定模式**（`pid`+`window_id`）的返回。
 * 官方约定（0.35.4 实测）：必须证明 `binding_quality:"exact"` + `mutation_allowed:true`，并给出 `target_id`；
 * **绑定阶段没有页面快照，因此不要求 `snapshot_id`**（这一条以前写错，导致隔离路径 100% fail-closed）。
 * 标签从 `tabs[]` 里取：唯一 `active:true`，否则只有唯一标签时用它；多标签且都无法证明活动 → fail-closed。
 */
export function parseBrowserBind(structured: unknown): BrowserBinding {
	const s = asObj(structured);
	if (!s) return { ok: false, reason: "读不到隔离浏览器状态（fail-closed）" };
	const status = firstString(s.status);
	if (status && status !== "ok") return { ok: false, reason: "隔离浏览器绑定没有成功（fail-closed）" };
	const quality = firstString(s.binding_quality, s.bindingQuality);
	if (quality !== "exact") {
		return { ok: false, reason: quality ? `隔离浏览器不是精确绑定（binding_quality=${quality}），fail-closed` : "隔离浏览器没有 binding_quality=exact 证据（fail-closed）" };
	}
	const mutation = s.mutation_allowed ?? s.mutationAllowed;
	if (mutation !== true) {
		return { ok: false, reason: mutation === false ? "隔离浏览器不可变更（mutation_allowed=false），fail-closed" : "隔离浏览器没有 mutation_allowed=true 证据（fail-closed）" };
	}
	const ownerPid = firstNumber(s.pid, s.owner_pid, s.ownerPid, asObj(s.browser)?.pid);
	const targetId = firstString(s.target_id, s.targetId, asObj(s.target)?.id);
	if (!targetId) return { ok: false, reason: "隔离浏览器绑定没有 target_id，无法导航（fail-closed）" };
	const tabs = Array.isArray(s.tabs) ? s.tabs.map((t) => asObj(t)).filter((t): t is Record<string, unknown> => !!t) : [];
	const activeTabs = tabs.filter((t) => t.active === true);
	const chosen = activeTabs.length === 1 ? activeTabs[0] : tabs.length === 1 ? tabs[0] : null;
	if (!chosen) {
		return { ok: false, reason: tabs.length ? "隔离浏览器有多个标签且无法证明哪个是活动标签（fail-closed）" : "隔离浏览器绑定没有返回任何标签（fail-closed）" };
	}
	// 顶层 tab_id 只在部分版本 / 导航返回里出现；bind 以 tabs[] 为准。
	const tabId = firstString(s.tab_id, s.tabId, chosen.tab_id, chosen.tabId);
	if (!tabId) return { ok: false, reason: "隔离浏览器绑定没有 tab_id，无法快照页面（fail-closed）" };
	const url = firstString(chosen.url, s.url, s.current_url, s.currentUrl);
	return { ok: true, ...(ownerPid !== undefined ? { ownerPid } : {}), tabId, targetId, ...(url ? { url } : {}) };
}

/**
 * 校验 `get_browser_state` **快照模式**（`target_id`+`tab_id`）的返回，并取得可 pin 的快照身份。
 * 官方约定（0.35.4 实测）：`snapshot.id`（如 `p1`，refs 的 `p<n>:<i>` 前缀），页面 URL 在 `page.url`；
 * 兼容旧 `dom_refs_v1` 顶层 `snapshot_id` / `state_id`。**拿不到就 fail-closed**（绝不自己编 id）。
 * 传 `fixtureId`+`nonce` 时，额外要求当前页面 URL 是本次 fixture。
 */
export function parseBrowserSnapshot(structured: unknown, input: { fixtureId?: string; nonce?: string; expectedOrigin?: string } = {}): BrowserBinding {
	const s = asObj(structured);
	if (!s) return { ok: false, reason: "读不到隔离浏览器的页面快照（fail-closed）" };
	const status = firstString(s.status);
	if (status && status !== "ok") return { ok: false, reason: "隔离浏览器页面快照没有成功（fail-closed）" };
	const snap = asObj(s.snapshot);
	const token = firstString(snap?.id, snap?.snapshot_id, s.snapshot_id, s.snapshotId, s.state_id, s.stateId);
	if (!token) return { ok: false, reason: "隔离浏览器读不到可 pin 的快照 id（driver 约定 snapshot.id），fail-closed" };
	const page = asObj(s.page);
	const url = firstString(page?.url, s.url, s.current_url, s.currentUrl, asObj(s.tab)?.url);
	if (input.fixtureId && input.nonce && (!url || !fixtureUrlMatches(url, input.fixtureId, input.nonce, input.expectedOrigin))) {
		return { ok: false, reason: "隔离浏览器当前 URL 不是本次 fixture（nonce 不符，fail-closed）" };
	}
	const ownerPid = firstNumber(s.pid, s.owner_pid, s.ownerPid, asObj(s.browser)?.pid);
	const tabId = firstString(s.tab_id, s.tabId);
	const targetId = firstString(s.target_id, s.targetId, asObj(s.target)?.id);
	return { ok: true, ...(ownerPid !== undefined ? { ownerPid } : {}), ...(tabId ? { tabId } : {}), ...(targetId ? { targetId } : {}), token, ...(url ? { url } : {}) };
}

/**
 * fixture URL 必须是「同一个 origin + fixture 固定路径 + query 里 nonce 相等」，防别的 run / 别的页面串扰。
 * 只做字符串包含判断不够：任意站点的 URL 里只要碰巧带了这两个字符串就会通过，所以这里解析 URL 再逐项比。
 * `expectedOrigin` 由调用方给（本次真正导航到的 fixture 地址的 origin）；不给时只校 path + nonce。
 */
export function fixtureUrlMatches(url: string, fixtureId: string, nonce: string, expectedOrigin?: string): boolean {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return false;
	}
	if (expectedOrigin && u.origin !== expectedOrigin) return false;
	if (u.pathname !== `${BENCHMARK_FIXTURE_BASE}/${encodeURIComponent(fixtureId)}`) return false;
	return u.searchParams.get("nonce") === nonce;
}

const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
const firstString = (...vals: unknown[]): string | undefined => {
	for (const v of vals) if (typeof v === "string" && v) return v;
	return undefined;
};
const firstNumber = (...vals: unknown[]): number | undefined => {
	for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
	return undefined;
};
/** 按进程挑出唯一窗口（隔离浏览器刚启动时一般只有一个 / 空白窗）；多个无法确定 → null（fail-closed）。 */
export function pickWindowForPid(windows: unknown, pid: number): { pid: number; windowId: number } | null {
	if (!Array.isArray(windows)) return null;
	const hits = windows
		.map((w) => asObj(w))
		.filter((w): w is Record<string, unknown> => !!w)
		.filter((w) => Number(w.pid) === pid)
		.map((w) => ({ pid: Number(w.pid), windowId: Number(w.window_id ?? w.windowId), url: String(w.url ?? "") }))
		.filter((w) => Number.isFinite(w.pid) && Number.isFinite(w.windowId));
	if (hits.length === 1) return { pid: hits[0].pid, windowId: hits[0].windowId };
	const blank = hits.filter((w) => !w.url || /^about:/.test(w.url));
	return blank.length === 1 ? { pid: blank[0].pid, windowId: blank[0].windowId } : null;
}
