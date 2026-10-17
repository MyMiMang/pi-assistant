/**
 * 浏览器页面快照（cua-driver `get_browser_state` semantic_v2）的**共享归一 / 校验**。
 *
 * 为什么单独一个模块：同一套逻辑现在有两个消费方——
 *  - 产品工具 `fast_pick_action`（浏览器目标：直接读主模型自己绑好的 exact target / tab）；
 *  - 真实操控基准（benchmark driver / window）。
 * 之前它长在 `benchmark-driver.ts` 里，产品工具去 import 就会把整个 benchmark driver（host / fixture / 判分）
 * 拖进产品路径，还会形成 benchmark-host → tool → benchmark-driver 的循环引用。这里只留纯函数，
 * 不 import 任何 benchmark 运行时代码（fixture 路由常量属于 `benchmark-window.ts` 的 fixture 校验，不进这里）。
 *
 * 字段以官方 cua-driver 0.35.4 实测为准（见 docs/design/fast-model-benchmark.md §9.1）：
 *  - bind（`pid`+`window_id`）：`binding_quality:"exact"` + `mutation_allowed:true` + `target_id` + `tabs[]`，**没有页面快照**；
 *  - snapshot（`target_id`+`tab_id`+`snapshot_format:"semantic_v2"`）：`snapshot.id`（refs 前缀 `p<n>`）、`page.url`、`refs[]` / `content_refs[]`。
 */

export interface BrowserBinding {
	ok: boolean;
	reason?: string;
	/** 浏览器进程 pid（仅在返回里带出时存在；不据此证明归属）。 */
	ownerPid?: number;
	tabId?: string;
	/** 绑定 / 快照需要的 target id。 */
	targetId?: string;
	/** 页面快照 **pin**（真实字段 `snapshot.id`，如 `p1`；refs 前缀就取自它）。只有 snapshot 模式有。 */
	token?: string;
	url?: string;
}

/**
 * 校验 `get_browser_state` **绑定模式**（`pid`+`window_id`）的返回。
 * 必须证明 `binding_quality:"exact"` + `mutation_allowed:true`，并给出 `target_id`；**绑定阶段没有页面快照**，
 * 因此不要求 `snapshot_id`（这一条以前写错，导致隔离路径 100% fail-closed）。
 * 标签从 `tabs[]` 里取：唯一 `active:true`，否则只有唯一标签时用它；多标签且都无法证明活动 → fail-closed。
 */
export function parseBrowserBind(structured: unknown): BrowserBinding {
	const s = asObj(structured);
	if (!s) return { ok: false, reason: "读不到浏览器状态（fail-closed）" };
	// 把 snapshot 返回喂进绑定校验 = 调用方问错了东西 → fail-closed（只认明确的 snapshot 标记，其它未知 mode 不据此拒绝）。
	if (firstString(s.mode) === "snapshot") return { ok: false, reason: "返回的是页面快照，不是绑定信息（fail-closed）" };
	const status = firstString(s.status);
	if (status && status !== "ok") return { ok: false, reason: "浏览器绑定没有成功（fail-closed）" };
	const quality = firstString(s.binding_quality, s.bindingQuality);
	if (quality !== "exact") {
		return { ok: false, reason: quality ? `浏览器不是精确绑定（binding_quality=${quality}），fail-closed` : "浏览器没有 binding_quality=exact 证据（fail-closed）" };
	}
	const mutation = s.mutation_allowed ?? s.mutationAllowed;
	if (mutation !== true) {
		return { ok: false, reason: mutation === false ? "浏览器不可变更（mutation_allowed=false），fail-closed" : "浏览器没有 mutation_allowed=true 证据（fail-closed）" };
	}
	const ownerPid = firstNumber(s.pid, s.owner_pid, s.ownerPid, asObj(s.browser)?.pid);
	const targetId = firstString(s.target_id, s.targetId, asObj(s.target)?.id);
	if (!targetId) return { ok: false, reason: "浏览器绑定没有 target_id，无法导航（fail-closed）" };
	const tabs = Array.isArray(s.tabs) ? s.tabs.map((t) => asObj(t)).filter((t): t is Record<string, unknown> => !!t) : [];
	const activeTabs = tabs.filter((t) => t.active === true);
	const chosen = activeTabs.length === 1 ? activeTabs[0] : tabs.length === 1 ? tabs[0] : null;
	if (!chosen) {
		return { ok: false, reason: tabs.length ? "浏览器有多个标签且无法证明哪个是活动标签（fail-closed）" : "浏览器绑定没有返回任何标签（fail-closed）" };
	}
	// 顶层 tab_id 只在部分版本 / 导航返回里出现；bind 以 tabs[] 为准。
	const tabId = firstString(s.tab_id, s.tabId, chosen.tab_id, chosen.tabId);
	if (!tabId) return { ok: false, reason: "浏览器绑定没有 tab_id，无法快照页面（fail-closed）" };
	const url = firstString(chosen.url, s.url, s.current_url, s.currentUrl);
	return { ok: true, ...(ownerPid !== undefined ? { ownerPid } : {}), tabId, targetId, ...(url ? { url } : {}) };
}

/**
 * 校验 `get_browser_state` **快照模式**（`target_id`+`tab_id`）的返回，并取得可 pin 的快照身份。
 * 只做**通用**校验（status / pin / URL 字段），**不**判 fixture 特定 URL——那句在 `benchmark-window.ts` 的
 * `parseBrowserSnapshot` 里叠加（产品工具看的是用户当前真实页面，没有 fixture 可校）。
 */
export function parseBrowserSnapshotView(structured: unknown): BrowserBinding {
	const s = asObj(structured);
	if (!s) return { ok: false, reason: "读不到浏览器的页面快照（fail-closed）" };
	// 把 bind 返回喂进快照校验 = 会拿到一把假的“快照 pin” → fail-closed。
	if (firstString(s.mode) === "bind") return { ok: false, reason: "返回的是绑定信息，没有页面快照（fail-closed）" };
	const status = firstString(s.status);
	if (status && status !== "ok") return { ok: false, reason: "浏览器页面快照没有成功（fail-closed）" };
	const snap = asObj(s.snapshot);
	const token = firstString(snap?.id, snap?.snapshot_id, s.snapshot_id, s.snapshotId, s.state_id, s.stateId);
	if (!token) return { ok: false, reason: "读不到可 pin 的快照 id（driver 约定 snapshot.id），fail-closed" };
	const page = asObj(s.page);
	const url = firstString(page?.url, s.url, s.current_url, s.currentUrl, asObj(s.tab)?.url);
	const ownerPid = firstNumber(s.pid, s.owner_pid, s.ownerPid, asObj(s.browser)?.pid);
	const tabId = firstString(s.tab_id, s.tabId);
	const targetId = firstString(s.target_id, s.targetId, asObj(s.target)?.id);
	return { ok: true, ...(ownerPid !== undefined ? { ownerPid } : {}), ...(tabId ? { tabId } : {}), ...(targetId ? { targetId } : {}), token, ...(url ? { url } : {}) };
}

/**
 * 把页面快照（`refs[]`）归一成与原生窗口一致的 elements 形状，让候选收集 / 目标新鲜度 / 判分三层复用同一套逻辑。
 * `element_token` 就放 ref（如 `p3:7`）；真正派发时，浏览器目标换成 `browser_click{ref}`（候选表仍用 element_token 存 ref，
 * 好让执行前的「目标新鲜度校验」一条路径通用于原生与页面）。
 *
 * 能力语义：`refs[]` 是**动作节点**（带 `actions`，如 `click` / `pointer` / `type`），`content_refs[]` 是**内容节点**
 * （status / statictext 等，无动作能力）。内容节点也纳入 elements 作为独立 UI 证据，但 `actions` 一律置空，
 * 不会被当成「可点击候选」。`pointer` 与 `click` 不是同一件事（pointer = 可悬停 / 可滚动 / 可定位），
 * 候选收集据此单独判断，见 `tool.ts` 的 `clickCandidatesFromBrowserRefs`。
 */
export function browserSnapshotAsWindow(structured: unknown): Record<string, unknown> {
	const s = asObj(structured) ?? {};
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
			const token = firstString(r.ref);
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
	return { ...s, elements, snapshot_id: firstString(asObj(s.snapshot)?.id, s.snapshot_id), url: page.url, title: page.title };
}

/** 快照 pin（`snapshot.id` / 兼容旧字段）；取不到就是 undefined（调用方必须 fail-closed，不自己编）。 */
export function browserSnapshotId(structured: unknown): string | undefined {
	return parseBrowserSnapshotView(structured).token;
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
