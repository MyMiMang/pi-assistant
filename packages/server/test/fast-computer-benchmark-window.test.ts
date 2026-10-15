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
import { planFixtureWindow, parsePreparedBrowser, parseBrowserBinding, fixtureUrlMatches, DRIVER_BROWSER_TOOLS } from "../src/fast-computer/benchmark-window.ts";
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
test("隔离浏览器：prepare 只认 prepared_pid；绑定必须 exact + 可变更 + 有快照 id（导航后再校非ce）", () => {
	// 官方 isolated_new 只返回 prepared_pid，没有 target_id；拿不到 pid 就 fail-closed。
	assert.deepEqual(parsePreparedBrowser({ prepared_pid: 99, message: "Launched a separate driver-owned isolated Chromium process" }), { preparedPid: 99 });
	assert.deepEqual(parsePreparedBrowser({ preparedPid: 99 }), { preparedPid: 99 });
	assert.equal(parsePreparedBrowser({ profile: "isolated_new", message: "ok" }), null, "没有 prepared_pid fail-closed");

	// 绑定初始 URL 是空白，不传 fixture → 只看绑定证据 + 快照 id。
	const bound = { binding_quality: "exact", mutation_allowed: true, url: "about:blank", snapshot_id: "s1", pid: 99, tab_id: "tab1", target_id: "t1" };
	const b = parseBrowserBinding(bound);
	assert.equal(b.ok, true);
	assert.equal(b.ownerPid, 99);
	assert.equal(b.token, "s1");
	assert.equal(b.targetId, "t1");
	assert.equal(b.tabId, "tab1");
	// 导航后的复核：URL 必须带本次 nonce。
	const state = { ...bound, url: "http://127.0.0.1:8787/api/fast-computer/benchmark/fixture/fx-1?nonce=n-1" };
	assert.equal(parseBrowserBinding(state, { fixtureId: "fx-1", nonce: "n-1" }).ok, true);
	assert.match(parseBrowserBinding({ ...state, binding_quality: "heuristic" }, { fixtureId: "fx-1", nonce: "n-1" }).reason ?? "", /精确绑定/);
	assert.match(parseBrowserBinding({ ...bound, binding_quality: undefined }, {}).reason ?? "", /binding_quality=exact/);
	assert.match(parseBrowserBinding({ ...state, mutation_allowed: false }, { fixtureId: "fx-1", nonce: "n-1" }).reason ?? "", /不可变更/);
	assert.match(parseBrowserBinding({ ...bound, mutation_allowed: undefined }, {}).reason ?? "", /mutation_allowed=true/);
	assert.match(parseBrowserBinding({ ...state, url: "http://x/fixture/fx-1?nonce=other" }, { fixtureId: "fx-1", nonce: "n-1" }).reason ?? "", /URL/);
	assert.match(parseBrowserBinding({ ...state, snapshot_id: undefined }, { fixtureId: "fx-1", nonce: "n-1" }).reason ?? "", /快照 id/);
	assert.equal(parseBrowserBinding(undefined, { fixtureId: "fx-1", nonce: "n-1" }).ok, false);
	assert.equal(fixtureUrlMatches("http://h/p/fx-1?nonce=n-1", "fx-1", "n-1"), true);
	assert.equal(fixtureUrlMatches("http://h/p/fx-1?nonce=n-2", "fx-1", "n-1"), false);
});

// ---------------------------------------------------------------- 真实 driver：隔离浏览器 bootstrap 序列
test("driver：driver-isolated-browser 走 prepare(prepared_pid)→list_windows→bind→navigate→复核→pin（官方真实序列）", async () => {
	const calls: { tool: string; args: Record<string, unknown> }[] = [];
	let navigatedUrl = "http://x/blank";
	let boundTarget = "";
	const invoke = async (_prefix: "hostpc" | "computer", tool: string, args: Record<string, unknown>): Promise<InvokeResult> => {
		calls.push({ tool, args });
		// 官方 isolated_new 只返回 prepared_pid；没有 target_id。
		if (tool === "browser_prepare") return { isError: false, structuredContent: { prepared_pid: 4242, message: "Launched a separate driver-owned isolated Chromium process" } };
		if (tool === "list_windows") return { isError: false, structuredContent: { windows: [{ pid: 4242, window_id: 8, title: "Chromium", url: "about:blank" }] } };
		if (tool === "browser_navigate") {
			navigatedUrl = String(args.url ?? "");
			return { isError: false, structuredContent: { ok: true } };
		}
		if (tool === "get_browser_state") {
			boundTarget = String(args.target_id ?? boundTarget);
			return { isError: false, structuredContent: { binding_quality: "exact", mutation_allowed: true, url: navigatedUrl, snapshot_id: navigatedUrl.includes("nonce") ? "snap-2" : "snap-1", pid: 4242, tab_id: "tab1", target_id: "t1" } };
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
	const fixtureId = "bench-abc";
	const nonce = "nonce-xyz";
	const { handle, close } = await driver.openFixtureWindow({ url: `/api/fast-computer/benchmark/fixture/${fixtureId}?nonce=${nonce}`, fixtureId, nonce, target: "hostpc" });
	assert.equal(handle.pid, 4242);
	assert.equal(handle.windowId, 8);
	assert.equal(handle.windowToken, "snap-2", "pin 的应是导航后复核列的快照 id");
	// 关键：prepare 必须 allow_launch + isolated_new（不是用户日常 profile）
	const prep = calls.find((c) => c.tool === "browser_prepare");
	assert.equal(prep?.args.allow_launch, true);
	assert.deepEqual(prep?.args.profile, { mode: "isolated_new" });
	// 顺序：先 list_windows(pid) 再 bind（pid+window_id），最后 navigate(target_id)
	const order = calls.map((c) => c.tool);
	assert.ok(order.indexOf("list_windows") < order.indexOf("browser_navigate"), "必须先 list_windows/bind 再 navigate");
	assert.deepEqual(calls.find((c) => c.tool === "list_windows")?.args.pid, 4242);
	assert.equal(boundTarget, "t1", "navigate/复核应用 bind 返回的 target_id");
	// 关闭只 kill 驱动自有 pid（prepared_pid）
	await close();
	assert.equal(closedPid, 4242);
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
