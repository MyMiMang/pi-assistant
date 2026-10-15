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
import { planFixtureWindow, parsePreparedBrowserTarget, parseBrowserBinding, fixtureUrlMatches, DRIVER_BROWSER_TOOLS } from "../src/fast-computer/benchmark-window.ts";
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
test("隔离浏览器：prepare 返回可 pin 的 target；绑定必须 exact + 可变更 + URL 带本次 nonce", () => {
	assert.deepEqual(parsePreparedBrowserTarget({ target_id: "t1", tabs: [{ tab_id: "tab1" }], pid: 99 }), { targetId: "t1", tabId: "tab1", ownerPid: 99 });
	assert.equal(parsePreparedBrowserTarget({ profile: "isolated_new" }), null, "没有 target_id fail-closed");

	const state = { binding_quality: "exact", mutation_allowed: true, url: "http://127.0.0.1:8787/api/fast-computer/benchmark/fixture/fx-1?nonce=n-1", snapshot_id: "s1", pid: 99, tab_id: "tab1", isolated_owned: true };
	const ok = parseBrowserBinding(state, { fixtureId: "fx-1", nonce: "n-1" });
	assert.equal(ok.ok, true);
	assert.equal(ok.ownerPid, 99);
	assert.equal(ok.token, "s1");
	assert.match(parseBrowserBinding({ ...state, binding_quality: "heuristic" }, { fixtureId: "fx-1", nonce: "n-1" }).reason ?? "", /精确绑定/);
	assert.match(parseBrowserBinding({ ...state, mutation_allowed: false }, { fixtureId: "fx-1", nonce: "n-1" }).reason ?? "", /不可变更/);
	assert.match(parseBrowserBinding({ ...state, url: "http://x/fixture/fx-1?nonce=other" }, { fixtureId: "fx-1", nonce: "n-1" }).reason ?? "", /URL/);
	assert.match(parseBrowserBinding({ ...state, isolated_owned: false }, { fixtureId: "fx-1", nonce: "n-1" }).reason ?? "", /驱动自有/);
	assert.equal(parseBrowserBinding(undefined, { fixtureId: "fx-1", nonce: "n-1" }).ok, false);
	assert.equal(fixtureUrlMatches("http://h/p/fx-1?nonce=n-1", "fx-1", "n-1"), true);
	assert.equal(fixtureUrlMatches("http://h/p/fx-1?nonce=n-2", "fx-1", "n-1"), false);
});

// ---------------------------------------------------------------- 真实 driver：隔离浏览器 bootstrap 序列
test("driver：driver-isolated-browser 走 browser_prepare(allow_launch, isolated_new)→navigate→get_browser_state→pin 原生窗口", async () => {
	const calls: { tool: string; args: Record<string, unknown> }[] = [];
	let navigatedUrl = "";
	const invoke = async (_prefix: "hostpc" | "computer", tool: string, args: Record<string, unknown>): Promise<InvokeResult> => {
		calls.push({ tool, args });
		if (tool === "browser_prepare") return { isError: false, structuredContent: { target_id: "t1", tabs: [{ tab_id: "tab1" }], pid: 4242 } };
		if (tool === "browser_navigate") {
			navigatedUrl = String(args.url ?? "");
			return { isError: false, structuredContent: { ok: true } };
		}
		if (tool === "get_browser_state") return { isError: false, structuredContent: { binding_quality: "exact", mutation_allowed: true, url: navigatedUrl, snapshot_id: "s1", pid: 4242, tab_id: "tab1", isolated_owned: true } };
		if (tool === "list_windows") return { isError: false, structuredContent: { windows: [{ pid: 4242, window_id: 8, title: "Pi 快速操作测试页 bench-abc nonce-xyz", url: "http://127.0.0.1:8787/api/fast-computer/benchmark/fixture/bench-abc?nonce=nonce-xyz" }] } };
		if (tool === "get_window_state") return { isError: false, structuredContent: { snapshot_id: "snap-1", pid: 4242, window_id: 8 } };
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
	assert.equal(handle.windowToken, "snap-1");
	// 关键：prepare 必须 allow_launch + isolated_new（不是用户日常 profile）
	const prep = calls.find((c) => c.tool === "browser_prepare");
	assert.equal(prep?.args.allow_launch, true);
	assert.deepEqual(prep?.args.profile, { mode: "isolated_new" });
	// 关闭只 kill 驱动自有 pid
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
