/**
 * 快速操作模型 · 基准测试：专用 fixture 窗口生命周期 / 能力推断 / 受限权限桥 / 窄网关。
 *
 * 全程假 backend 调用（模拟 cua 官方工具 schema）+ 本地内存 HTTP 小服务（127.0.0.1），
 * 数据目录临时 / 不调真实模型 / 不碰系统钥匙串 / 不开真实桌面。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { BenchmarkFixtureStateStore, benchmarkFixtureTasks } from "../src/fast-computer/benchmark-fixture.ts";
import { mountFastComputerRoutes } from "../src/fast-computer/routes.ts";
import { createBenchmarkHost, type BenchmarkDriver, type FixtureWindowHandle } from "../src/fast-computer/benchmark-host.ts";
import { createInvokeBenchmarkDriver, pickFixtureWindow, type InvokeResult } from "../src/fast-computer/benchmark-driver.ts";
import { planFixtureWindow, parsePreparedBrowser, parseBrowserBind, parseBrowserSnapshot, fixtureUrlMatches, DRIVER_BROWSER_TOOLS } from "../src/fast-computer/benchmark-window.ts";
import { benchmarkToolGuard, isBenchmarkReadOnly } from "../src/fast-computer/benchmark-guard.ts";
import { resolveComputerFixtureBaseUrl, fixtureOriginAllowed, isFixtureGatewayPath } from "../src/fast-computer/benchmark-gateway.ts";
import { createMockChooser } from "../src/fast-computer/choosers.ts";
import { _resetBenchmarks } from "../src/fast-computer/benchmark.ts";
import { _resetFastComputerState, saveFastComputerSettings, fastComputerSettings } from "../src/fast-computer/index.ts";

const TASK = benchmarkFixtureTasks()[0];

// ---------------------------------------------------------------- 窗口来源计划（只凭 tools/list，不开窗）
test("窗口计划：hostpc 必须能拿到驱动自有隔离浏览器，否则 fail-closed（不用日常浏览器）", () => {
	const full = ["get_window_state", "list_windows", "click", "scroll", ...DRIVER_BROWSER_TOOLS];
	const plan = planFixtureWindow({ prefix: "hostpc", tools: full });
	assert.equal(plan.ok, true);
	assert.equal(plan.kind, "driver-isolated-browser");
	// 只有 launch_app（用户默认浏览器）不算隔离 → 不 ok
	const notIsolated = planFixtureWindow({ prefix: "hostpc", tools: ["launch_app", "get_window_state", "list_windows", "click", "scroll"] });
	assert.equal(notIsolated.ok, false);
	assert.match(notIsolated.reason ?? "", /隔离浏览器/);
	assert.equal(planFixtureWindow({ prefix: "hostpc", tools: null }).ok, false);
});

test("窗口计划：助理电脑需要工具齐全 + 已证实宿主别名，否则 fail-closed", () => {
	const tools = ["launch_app", "get_window_state", "list_windows", "click", "scroll"];
	assert.equal(planFixtureWindow({ prefix: "computer", tools, gateway: { ok: true } }).kind, "sandbox-app");
	// 有驱动自有浏览器能力时优先隔离浏览器（独立 profile / 窗口）。
	assert.equal(planFixtureWindow({ prefix: "computer", tools: [...tools, ...DRIVER_BROWSER_TOOLS], gateway: { ok: true } }).kind, "driver-isolated-browser");
	assert.match(planFixtureWindow({ prefix: "computer", tools, gateway: { ok: false } }).reason ?? "", /网关/);
	assert.match(planFixtureWindow({ prefix: "computer", tools: ["launch_app"], gateway: { ok: true } }).reason ?? "", /缺少/);
});

// ---------------------------------------------------------------- browser_prepare / get_browser_state 返回收紧
// 下面的响应字面量取自 **cua-driver 0.35.4 实机真实返回**（2026-10-25 隔离浏览器 owned session，已关闭）：
//  prepare → {status:"ok",action:"launched_isolated_browser",prepared:true,prepared_pid:8814,side_effects:{…}}
//  bind    → {status:"ok",mode:"bind",binding_quality:"exact",mutation_allowed:true,target_id:"bt-…",tabs:[{active:true,tab_id,url,title}]}
//  snapshot→ {status:"ok",mode:"snapshot",page:{url},snapshot:{id:"p1",format:"semantic_v2"},refs:[{ref:"p1:0"}],outline}
const REAL_PREPARED = {
	status: "ok",
	action: "launched_isolated_browser",
	prepared: true,
	prepared_pid: 8814,
	attachment: null,
	endpoint_ownership: { method: "spawned_by_driver", owner_pid: 8814 },
	side_effects: { launched_browser: true, created_profile: true, foregrounded_window: false, copied_profile_data: false },
	message: "Launched a separate driver-owned isolated Chromium process; no existing browser process was modified or terminated.",
};
const REAL_BIND = {
	status: "ok",
	mode: "bind",
	binding_quality: "exact",
	binding_route: "native_cdp_window",
	endpoint_transport: "dev_tools_active_port",
	endpoint_access_class: "driver_owned",
	mutation_allowed: true,
	native_title: "about:blank",
	target_id: "bt-c8e09cba-ba25-471e-b01b-5c1387887afc",
	tabs: [{ active: true, tab_id: "tab-a996b19e-5606-4feb-82f8-43c063ab5549", title: "about:blank", url: "about:blank" }],
};
const REAL_SNAPSHOT = {
	status: "ok",
	mode: "snapshot",
	target_id: "bt-c8e09cba-ba25-471e-b01b-5c1387887afc",
	tab_id: "tab-a996b19e-5606-4feb-82f8-43c063ab5549",
	page: { title: "laya-fixture-n1", url: "http://127.0.0.1:8787/api/fast-computer/benchmark/fixture/fx-1?nonce=n-1" },
	snapshot: { id: "p1", format: "semantic_v2", complete: true, scope: "tab", continuation: null, selected_nodes: 2, total_nodes: 2, node_budget: 2000, omitted: { budget: 0, css_hidden: 0, offscreen: 0, no_layout: 0, page_occluded: 0, unknown: 0, unprovable_frame: 0 } },
	outline: '- heading "fixture fx-nonce-n1"\n- button "Click me" [focusable=true]',
	refs: [{ ref: "p1:0", role: "button", name: "Click me", frame: "main", actions: ["click"], states: { focusable: true }, visibility: "in_viewport", value: null }],
	content_refs: [],
	oopif: { status: "none", frames: 0 },
};

test("隔离浏览器：prepare 只认 prepared_pid；bind 只要 exact + 可变更 + target_id/tabs（真实 bind 没有快照 id）", () => {
	// 官方 isolated_new 只返回 prepared_pid，没有 target_id / window_id；拿不到 pid 就 fail-closed。
	assert.deepEqual(parsePreparedBrowser(REAL_PREPARED), { preparedPid: 8814 });
	assert.deepEqual(parsePreparedBrowser({ preparedPid: 99 }), { preparedPid: 99 });
	assert.equal(parsePreparedBrowser({ profile: "isolated_new", message: "ok" }), null, "没有 prepared_pid fail-closed");

	// 回归：beta.29 在这里要求 bind 返回 snapshot_id → 真实 driver 永远不给 → 点开始就报 pin fail-closed。
	const b = parseBrowserBind(REAL_BIND);
	assert.equal(b.ok, true);
	assert.equal(b.targetId, REAL_BIND.target_id);
	assert.equal(b.tabId, REAL_BIND.tabs[0].tab_id, "tab_id 来自 tabs[]，不是顶层");
	assert.equal(b.url, "about:blank");
	assert.equal(b.token, undefined, "bind 阶段不产生页面快照 pin");
	assert.equal(parseBrowserBind({ ...REAL_BIND, binding_quality: "heuristic" }).ok, false);
	assert.match(parseBrowserBind({ ...REAL_BIND, binding_quality: undefined }).reason ?? "", /binding_quality=exact/);
	assert.match(parseBrowserBind({ ...REAL_BIND, mutation_allowed: false }).reason ?? "", /不可变更/);
	assert.match(parseBrowserBind({ ...REAL_BIND, mutation_allowed: undefined }).reason ?? "", /mutation_allowed=true/);
	assert.match(parseBrowserBind({ ...REAL_BIND, target_id: undefined }).reason ?? "", /target_id/);
	assert.match(parseBrowserBind({ ...REAL_BIND, tabs: [] }).reason ?? "", /标签/);
	assert.match(parseBrowserBind({ ...REAL_BIND, tabs: [{ tab_id: "a", active: null }, { tab_id: "b", active: null }] }).reason ?? "", /多个标签/);
	// 多标签但能证明唯一 active 时照常放行。
	assert.equal(parseBrowserBind({ ...REAL_BIND, tabs: [{ tab_id: "a", active: false }, { tab_id: "b", active: true }] }).tabId, "b");
	assert.equal(parseBrowserBind(undefined).ok, false);
});

test("隔离浏览器：快照 pin 取官方 snapshot.id；非本次 fixture 的 URL 拒绝", () => {
	const s = parseBrowserSnapshot(REAL_SNAPSHOT, { fixtureId: "fx-1", nonce: "n-1" });
	assert.equal(s.ok, true);
	assert.equal(s.token, "p1", "pin 必须是真实 snapshot.id（refs 前缀 p1:0）");
	assert.equal(s.url, REAL_SNAPSHOT.page.url);
	assert.match(parseBrowserSnapshot({ ...REAL_SNAPSHOT, snapshot: { format: "semantic_v2" } }, { fixtureId: "fx-1", nonce: "n-1" }).reason ?? "", /快照 id/);
	assert.match(parseBrowserSnapshot({ ...REAL_SNAPSHOT, page: { url: "http://127.0.0.1:8787/api/x?nonce=other" } }, { fixtureId: "fx-1", nonce: "n-1" }).reason ?? "", /URL/);
	assert.match(parseBrowserSnapshot({ ...REAL_SNAPSHOT, page: undefined }, { fixtureId: "fx-1", nonce: "n-1" }).reason ?? "", /URL/);
	assert.equal(parseBrowserSnapshot(REAL_SNAPSHOT, { fixtureId: "fx-1", nonce: "n-1" }).ok, true);
	// 兼容旧 dom_refs_v1 顶层 snapshot_id（真实来源仍是驱动返回，绝不自己编）。
	assert.equal(parseBrowserSnapshot({ status: "ok", snapshot_id: "s0000001e", url: REAL_SNAPSHOT.page.url }, { fixtureId: "fx-1", nonce: "n-1" }).token, "s0000001e");
	assert.equal(fixtureUrlMatches("http://h/p/fx-1?nonce=n-1", "fx-1", "n-1"), true);
	assert.equal(fixtureUrlMatches("http://h/p/fx-1?nonce=n-2", "fx-1", "n-1"), false);
});

// ---------------------------------------------------------------- 真实 driver：隔离浏览器 bootstrap 序列
test("driver：driver-isolated-browser 走 prepare(prepared_pid)→list_windows→bind→navigate→snapshot.pin（官方真实序列）", async () => {
	const calls: { tool: string; args: Record<string, unknown> }[] = [];
	let phased = true;
	const invoke = async (_prefix: "hostpc" | "computer", tool: string, args: Record<string, unknown>): Promise<InvokeResult> => {
		calls.push({ tool, args });
		// 官方 isolated_new 只返回 prepared_pid；没有 target_id。
		if (tool === "browser_prepare") return { isError: false, structuredContent: REAL_PREPARED };
		if (tool === "list_windows") return { isError: false, structuredContent: { windows: [{ pid: 8814, window_id: 16821, title: "about:blank", url: "about:blank" }] } };
		if (tool === "browser_navigate") return { isError: false, structuredContent: { status: "ok", target_id: args.target_id, tab_id: args.tab_id, url: args.url, refs_invalidated: true } };
		if (tool === "get_browser_state") {
			// 真实 driver：bind 模式不返回 snapshot；snapshot 模式返回 snapshot.id。
			if (phased && args.pid !== undefined) return { isError: false, structuredContent: REAL_BIND };
			phased = false;
			return { isError: false, structuredContent: REAL_SNAPSHOT };
		}
		return { isError: true, contentText: `unexpected ${tool}` };
	};
	let closedPid: number | undefined;
	const driver = createInvokeBenchmarkDriver({
		target: () => ({ prefix: "hostpc" as const }),
		invoke: async (p, t, a) => (t === "kill_app" ? ((closedPid = Number(a.pid)), { isError: false }) : invoke(p, t, a)),
		fixtureUrl: (path) => `http://127.0.0.1:8787${path}`,
		windowKindOf: () => "driver-isolated-browser",
		capable: () => ({ ok: true }),
	});
	const fixtureId = "fx-1";
	const nonce = "n-1";
	const { handle, close } = await driver.openFixtureWindow({ url: `/api/fast-computer/benchmark/fixture/${fixtureId}?nonce=${nonce}`, fixtureId, nonce, target: "hostpc" });
	assert.equal(handle.pid, 8814);
	assert.equal(handle.windowId, 16821);
	assert.equal(handle.windowToken, "p1", "pin 应是导航后快照的 snapshot.id");
	// 关键：prepare 必须 allow_launch + isolated_new（不是用户日常 profile）
	const prep = calls.find((c) => c.tool === "browser_prepare");
	assert.equal(prep?.args.allow_launch, true);
	assert.deepEqual(prep?.args.profile, { mode: "isolated_new" });
	// bind 阶段不能要 snapshot_format（官方 bind 不开页面快照）
	const binds = calls.filter((c) => c.tool === "get_browser_state");
	assert.equal(binds[0].args.snapshot_format, undefined, "bind 不传 snapshot_format");
	assert.equal(binds[0].args.pid, 8814);
	assert.equal(binds[1].args.snapshot_format, "semantic_v2");
	// 顺序：list_windows(pid) → bind(pid+window_id) → navigate(target_id+tab_id) → snapshot
	const order = calls.map((c) => c.tool);
	assert.ok(order.indexOf("list_windows") < order.indexOf("browser_navigate"));
	assert.deepEqual(calls.find((c) => c.tool === "list_windows")?.args.pid, 8814);
	const nav = calls.find((c) => c.tool === "browser_navigate");
	assert.equal(nav?.args.target_id, REAL_BIND.target_id);
	assert.equal(nav?.args.tab_id, REAL_BIND.tabs[0].tab_id, "navigate 必须带 tabs[] 里的 tab_id");
	assert.ok(String(nav?.args.url).includes(nonce));
	// 关闭只 kill 驱动自有 pid（prepared_pid）
	await close();
	assert.equal(closedPid, 8814);
});

test("driver：驱动拒绝时给一行可读错误，不把整段内部 payload 披给用户", async () => {
	const driver = createInvokeBenchmarkDriver({
		target: () => ({ prefix: "hostpc" as const }),
		invoke: async (_p, tool) =>
			tool === "browser_prepare"
				? { isError: true, contentText: JSON.stringify({ code: "browser_requires_setup", message: "browser requires setup", detail: { next_call: "browser_prepare", elements: new Array(50).fill("x") } }) }
				: { isError: false, structuredContent: REAL_PREPARED },
		fixtureUrl: (p) => `http://127.0.0.1:8787${p}`,
		windowKindOf: () => "driver-isolated-browser",
		capable: () => ({ ok: true }),
	});
	await assert.rejects(
		() => driver.openFixtureWindow({ url: "/fixture/f?nonce=n", fixtureId: "f", nonce: "n", target: "hostpc" }),
		(e: Error) => e.message.length < 120 && e.message.includes("browser requires setup") && !e.message.includes("elements"),
	);
});

test("driver：受限权限桥拦截时不派发（暂停 / 只看档位）", async () => {
	let invoked = 0;
	const driver = createInvokeBenchmarkDriver({
		target: () => ({ prefix: "hostpc" as const }),
		invoke: async () => (invoked++, { isError: false }),
		fixtureUrl: (p) => `http://127.0.0.1:8787${p}`,
		windowKindOf: () => "driver-isolated-browser",
		guard: () => ({ ok: false, reason: "电脑已暂停" }),
		capable: () => ({ ok: true }),
	});
	await assert.rejects(() => driver.openFixtureWindow({ url: "/fixture/f?nonce=n", fixtureId: "f", nonce: "n", target: "hostpc" }), /暂停/);
	assert.equal(invoked, 0, "被权限桥拒绝时不派发任何 backend 调用");
});

// ---------------------------------------------------------------- 受限权限桥
test("权限桥：暂停拒绝一切；只看档位拒绝输入、允许读取；其余档位允许", () => {
	assert.equal(benchmarkToolGuard({ prefix: "hostpc", tool: "click", paused: true, tier: "full" }).ok, false);
	assert.equal(benchmarkToolGuard({ prefix: "hostpc", tool: "get_window_state", paused: true, tier: "full" }).ok, false);
	assert.match(benchmarkToolGuard({ prefix: "hostpc", tool: "click", paused: false, tier: "observe" }).reason ?? "", /只看/);
	assert.equal(benchmarkToolGuard({ prefix: "hostpc", tool: "get_window_state", paused: false, tier: "observe" }).ok, true);
	assert.equal(benchmarkToolGuard({ prefix: "hostpc", tool: "click", paused: false, tier: "bounded" }).ok, true);
	assert.equal(benchmarkToolGuard({ prefix: "computer", tool: "click", paused: false }).ok, true);
	assert.equal(benchmarkToolGuard({ prefix: "hostpc", tool: "run_script", paused: false, tier: "full" }).ok, false, "不能借基准逃 run_script 规则");
	assert.equal(isBenchmarkReadOnly("mcp__hostpc__list_windows"), true);
});

// ---------------------------------------------------------------- 网关别名解析 + origin
test("网关别名：Docker Desktop / Lima 给确认过的别名；Linux docker / 未知 fail-closed（绝不给 0.0.0.0）", () => {
	assert.equal(resolveComputerFixtureBaseUrl({ port: 8787, kind: "docker", platform: "darwin" }), "http://host.docker.internal:8787");
	assert.equal(resolveComputerFixtureBaseUrl({ port: 8787, kind: "lima", platform: "darwin" }), "http://host.lima.internal:8787");
	assert.equal(resolveComputerFixtureBaseUrl({ port: 8787, kind: "docker", platform: "linux" }), null);
	assert.equal(resolveComputerFixtureBaseUrl({ port: 8787, kind: "unknown", platform: "darwin" }), null);
	assert.equal(fixtureOriginAllowed({ origin: "http://127.0.0.1:8787", selfOrigin: "http://127.0.0.1:8787" }), true);
	assert.equal(fixtureOriginAllowed({ origin: "http://evil.example", selfOrigin: "http://127.0.0.1:8787" }), false);
	assert.equal(fixtureOriginAllowed({ origin: null, referer: null, selfOrigin: "http://127.0.0.1:8787" }), true);
	assert.equal(isFixtureGatewayPath("/api/fast-computer/benchmark/fixture/fx"), true);
});

// ---------------------------------------------------------------- 窄网关：真实本地 HTTP（模拟 guest 代理）
test("窄网关 HTTP：能取 fixture 页 + 上报状态；非白名单路径 403；跨源上报 403", async () => {
	_resetBenchmarks();
	_resetFastComputerState();
	saveFastComputerSettings({ enabled: true, kind: "chat", provider: "p", id: "m" });
	const store = new BenchmarkFixtureStateStore();
	const app = new Hono();
	mountFastComputerRoutes(app, { host: { availability: () => ({ cuaReady: false, modelReady: false, fixtureReady: false, reasons: [] }), start: async () => { throw new Error("no"); } }, store });
	const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
	await new Promise((r) => setTimeout(r, 50));
	const addr = server.address();
	const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
	try {
		store.arm("fx-http", "n-http", "t-http");
		const page = await fetch(`${base}/api/fast-computer/benchmark/fixture/fx-http?nonce=n-http`);
		assert.equal(page.status, 200);
		assert.match(await page.text(), /n-http/);
		const post = await fetch(`${base}/api/fast-computer/benchmark/fixture/fx-http/state?nonce=n-http`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-bench-fixture-token": "t-http", origin: base },
			body: JSON.stringify({ clicked: "submit" }),
		});
		assert.deepEqual(await post.json(), { ok: true });
		// 非白名单路径：窄网关 403，不暴露其它 API
		const catchAll = await fetch(`${base}/api/fast-computer/benchmark/fixture/fx-http/anything`);
		assert.equal(catchAll.status, 403);
		// 跨源上报 403
		const cross = await fetch(`${base}/api/fast-computer/benchmark/fixture/fx-http/state?nonce=n-http`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-bench-fixture-token": "t-http", origin: "http://evil.example" },
			body: JSON.stringify({ clicked: "cancel" }),
		});
		assert.equal(cross.status, 403);
	} finally {
		server.close();
	}
});

// ---------------------------------------------------------------- GET availability 不开窗；POST 才开窗
test("availability 只报可准备（不开窗）；start 才创窗口、pin、再跑", async () => {
	_resetBenchmarks();
	_resetFastComputerState();
	saveFastComputerSettings({ enabled: true, kind: "chat", provider: "p", id: "m" });
	const store = new BenchmarkFixtureStateStore();
	let opened = 0;
	const driver: BenchmarkDriver = {
		target: () => ({ prefix: "computer" }),
		capable: () => ({ ok: true }),
		windowKind: () => "sandbox-app",
		async openFixtureWindow({ fixtureId, nonce }) {
			opened++;
			const handle: FixtureWindowHandle = { prefix: "computer", pid: 1, windowId: 2, windowToken: "t", fixtureId, url: "/f" };
			return { handle, close: async () => {} };
		},
		async readWindow(handle) {
			return { prefix: "computer", pid: 1, window_id: 2, window_token: "t", fixture_id: handle.fixtureId };
		},
		async observe() {
			return { ok: true as const, structured: { elements: [{ role: "button", label: "提交", element_token: "tok-submit", actions: [], element_index: 0, value: "" }] } };
		},
		async execute() {
			return { isError: false };
		},
	};
	const host = createBenchmarkHost({ driver, store, tasks: [TASK], warmup: 0, maxTrials: 1, chooserFor: () => createMockChooser((r) => ({ kind: "selected", candidateId: r.candidates[0].id })) });
	const avail = host.availability();
	assert.equal(avail.preparable, true);
	assert.equal(avail.targetKind, "sandbox-app");
	assert.equal(opened, 0, "GET availability 绝不开窗口");
	await host.start({});
	assert.equal(opened, 1, "点了开始才创建 fixture 窗口");
});

// ---------------------------------------------------------------- 浏览器 fixture：页面快照 → 同一套 elements
// 下面两条用 0.35.4 真实 semantic_v2 形状（refs 动作节点 + content_refs 内容节点，实测抓取）：
test("浏览器 fixture：快照归一成 elements（refs 带动作、content_refs 只作文本证据、按 ref 去重）", async () => {
	const { browserSnapshotAsWindow } = await import("../src/fast-computer/benchmark-driver.ts");
	const { clickCandidatesFromBrowserRefs } = await import("../src/fast-computer/tool.ts");
	const normalized = browserSnapshotAsWindow({
		status: "ok",
		mode: "snapshot",
		page: { title: "fixture", url: "http://127.0.0.1:8787/x?nonce=n" },
		snapshot: { id: "p1", format: "semantic_v2" },
		refs: [
			{ ref: "p1:1", role: "button", name: "提交", actions: ["click"], value: null },
			{ ref: "p1:2", role: "combobox", name: null, actions: ["click", "pointer"], value: "请选择城市" },
		],
		content_refs: [
			{ ref: "p1:1", role: "button", name: "提交" },
			{ ref: "p1:8", role: "status", name: null },
			{ ref: "p1:9", role: "statictext", name: "提交完成" },
		],
	});
	const els = normalized.elements as { element_token: string; role?: string; label?: string; actions?: string[] }[];
	assert.deepEqual(els.map((e) => e.element_token), ["p1:1", "p1:2", "p1:8", "p1:9"], "按 ref 去重、动作节点在前");
	assert.deepEqual(els[0].actions, ["click"]);
	assert.deepEqual(els[2].actions, [], "内容节点不是动作能力");
	assert.equal(normalized.snapshot_id, "p1", "pin 仍是 snapshot.id");
	assert.equal(normalized.url, "http://127.0.0.1:8787/x?nonce=n");

	// 候选只取有动作的 ref，并且走驱动的 browser_click{target_id,tab_id,ref}
	const candidates = clickCandidatesFromBrowserRefs("mcp__hostpc__", { target_id: "bt-1", tab_id: "tab-1" }, normalized);
	assert.deepEqual(candidates.map((c) => c.label), ["button：提交", "combobox"]);
	assert.equal(candidates[0].tool, "mcp__hostpc__browser_click");
	assert.equal(candidates[0].args.target_id, "bt-1");
	assert.equal(candidates[0].args.tab_id, "tab-1");
	assert.equal(candidates[0].args.element_token, "p1:1");
	assert.equal(candidates[0].semantic?.role, "button");
});

test("驱动：浏览器 fixture 动作前复核复用刚观察的 pin（不新取快照，避免作废即将点击的 ref）", async () => {
	const calls: string[] = [];
	const invoke = async (_p: "hostpc" | "computer", tool: string, args: Record<string, unknown>): Promise<InvokeResult> => {
		calls.push(tool);
		if (tool === "browser_prepare") return { isError: false, structuredContent: REAL_PREPARED };
		if (tool === "list_windows") return { isError: false, structuredContent: { windows: [{ pid: 8814, window_id: 16821, url: "about:blank" }] } };
		if (tool === "get_browser_state") {
			return { isError: false, structuredContent: args.pid !== undefined ? REAL_BIND : REAL_SNAPSHOT };
		}
		return { isError: false, structuredContent: { status: "ok" } };
	};
	const driver = createInvokeBenchmarkDriver({
		target: () => ({ prefix: "hostpc" as const }),
		invoke,
		fixtureUrl: (p) => `http://127.0.0.1:8787${p}`,
		windowKindOf: () => "driver-isolated-browser",
		capable: () => ({ ok: true }),
	});
	const { handle } = await driver.openFixtureWindow({ url: "/f/fx-1?nonce=n-1", fixtureId: "fx-1", nonce: "n-1", target: "hostpc" });
	assert.equal(handle.targetId, REAL_BIND.target_id);
	assert.equal(handle.tabId, REAL_BIND.tabs[0].tab_id);
	const before = calls.filter((t) => t === "get_browser_state").length;
	const observed = await driver.observe(handle);
	assert.equal(observed.ok, true);
	const identity = await driver.readWindow(handle);
	assert.equal(identity?.window_token, "p1", "身份复核用的是刚观察的快照 pin");
	const after = calls.filter((t) => t === "get_browser_state").length;
	assert.equal(after - before, 1, "观察 1 次 + 复核 0 次：复核不得再取快照");
});
