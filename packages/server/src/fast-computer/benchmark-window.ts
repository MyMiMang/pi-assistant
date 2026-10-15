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
 *  - `parsePreparedBrowserTarget` / `parseBrowserBinding`：把 `browser_prepare` / `get_browser_state` 的返回收紧成
 *    可 pin 的精确身份（target_id / tab_id / owner_pid），任何缺失都 fail-closed；
 *  - `fixtureUrlMatches`：fixture URL 必须同时带本次 fixtureId + nonce，防串扰。
 */

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

/** 从 `browser_prepare` 的返回里取出可 pin 的隔离浏览器 target；缺失 / 形状不符 → null（fail-closed）。 */
export function parsePreparedBrowserTarget(structured: unknown): { targetId: string; tabId?: string; ownerPid?: number } | null {
	const s = asObj(structured);
	if (!s) return null;
	const targetId = firstString(s.target_id, s.targetId, asObj(s.target)?.id);
	if (!targetId) return null;
	const tabId = firstString(s.tab_id, s.tabId, firstTabId(s.tabs), firstTabId(asObj(s.target)?.tabs));
	const ownerPid = firstNumber(s.pid, s.owner_pid, s.ownerPid);
	return { targetId, ...(tabId ? { tabId } : {}), ...(ownerPid !== undefined ? { ownerPid } : {}) };
}

export interface BrowserBinding {
	ok: boolean;
	reason?: string;
	/** 驱动自有浏览器进程 pid（仅当能证明是本次 driver 拉起时非空，关闭只 kill 它）。 */
	ownerPid?: number;
	tabId?: string;
	token?: string;
}

/**
 * 校验 `get_browser_state` 的返回：必须是精确绑定、可变更、且 URL 带本次 fixtureId + nonce。
 * 任何一项缺失都 fail-closed（不“大概是它”）。
 */
export function parseBrowserBinding(structured: unknown, input: { fixtureId: string; nonce: string }): BrowserBinding {
	const s = asObj(structured);
	if (!s) return { ok: false, reason: "读不到隔离浏览器状态（fail-closed）" };
	const quality = firstString(s.binding_quality, s.bindingQuality);
	if (quality !== undefined && quality !== "exact") return { ok: false, reason: `隔离浏览器不是精确绑定（binding_quality=${quality}），fail-closed` };
	const mutation = s.mutation_allowed ?? s.mutationAllowed;
	if (mutation === false) return { ok: false, reason: "隔离浏览器不可变更（mutation_allowed=false），fail-closed" };
	const url = firstString(s.url, s.current_url, asObj(s.tab)?.url);
	if (!url || !fixtureUrlMatches(url, input.fixtureId, input.nonce)) return { ok: false, reason: "隔离浏览器当前 URL 不是本次 fixture（nonce 不符，fail-closed）" };
	const token = firstString(s.snapshot_id, s.snapshotId, s.state_id, s.stateId);
	if (!token) return { ok: false, reason: "隔离浏览器读不到可 pin 的快照 id（fail-closed）" };
	const ownerPid = firstNumber(s.pid, s.owner_pid, s.ownerPid, asObj(s.browser)?.pid);
	const tabId = firstString(s.tab_id, s.tabId);
	// isolatedOwned 必须为真才允许之后 kill（关闭只关驱动自有浏览器，绝不关用户浏览器）。
	const owned = s.isolated_owned ?? s.isolatedOwned ?? s.owned ?? true;
	if (owned === false) return { ok: false, reason: "隔离浏览器不是驱动自有（isolated_owned=false），fail-closed" };
	return { ok: true, ...(ownerPid !== undefined ? { ownerPid } : {}), ...(tabId ? { tabId } : {}), token };
}

/** fixture URL 必须同时含本次 fixtureId + nonce（防别的 run / 别的页面串扰）。 */
export function fixtureUrlMatches(url: string, fixtureId: string, nonce: string): boolean {
	return url.includes(fixtureId) && url.includes(nonce);
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
const firstTabId = (tabs: unknown): string | undefined => {
	if (!Array.isArray(tabs) || !tabs.length) return undefined;
	const t = asObj(tabs[0]);
	return t ? firstString(t.tab_id, t.tabId, t.id) : undefined;
};
