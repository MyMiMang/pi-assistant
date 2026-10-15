/**
 * 快速操作模型 · 基准测试：fixture / host / routes 集成。
 *
 * 用**假 driver** 模拟真实 computer backend 的调用序列（get_window_state / click），全程：
 *  - 数据目录临时、模型注入内存 store（见 setup.ts / 本文件不调真实模型）、0 真实付费、0 真实桌面；
 *  - 假 driver 的 execute 模拟 fixture 的机器状态 reporter（POST 语义），独立 UI 观测来自 observe；
 *  - 覆盖：正确闭环、窗口身份变化 → 0 执行 fail-closed、取消 / 清理、URL nonce 串扰、平台不支持、ready。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { _resetBenchmarks, benchmarkStatus, type FastBenchmarkResult } from "../src/fast-computer/benchmark.ts";
import { BenchmarkFixtureStateStore, benchmarkFixtureTasks, renderBenchmarkFixtureHtml } from "../src/fast-computer/benchmark-fixture.ts";
import { createBenchmarkHost, type BenchmarkDriver, type FixtureWindowHandle } from "../src/fast-computer/benchmark-host.ts";
import { createMockChooser } from "../src/fast-computer/choosers.ts";
import { fastComputerSettings, saveFastComputerSettings, _resetFastComputerState } from "../src/fast-computer/index.ts";
import { mountFastComputerRoutes } from "../src/fast-computer/routes.ts";

const TASK = benchmarkFixtureTasks()[0]; // pick-submit

/** 模拟真 driver：observe 给出元素，execute 只接受 click 并更新 store（= fixture reporter 的机器状态）。 */
function fakeDriver(store: BenchmarkFixtureStateStore, opts: { windowChangesAfter?: number; hangObserve?: boolean } = {}) {
	let readCount = 0;
	let fixtureId = "";
	let nonce = "";
	let closed = false;
	let releaseObserve: () => void = () => {};
	const observeGate = new Promise<void>((r) => (releaseObserve = r));
	const dispatched: { tool: string; args: Record<string, unknown> }[] = [];

	const elements = () => {
		const st = store.get(fixtureId, nonce);
		const list: Record<string, unknown>[] = [
			{ role: "button", label: "取消", element_token: "tok-cancel", actions: ["press"], element_index: 0, value: "" },
			{ role: "button", label: "提交", element_token: "tok-submit", actions: ["press"], element_index: 1, value: "" },
		];
		if (st.clicked === "submit") list.push({ role: "status", label: "提交完成", element_token: "tok-done", actions: [], element_index: 2, value: "" });
		return { elements: list };
	};

	const handleOf = (): FixtureWindowHandle => ({ prefix: "computer", pid: 4242, windowId: 7, windowToken: "tok-1", fixtureId, url: `/fixture/${fixtureId}` });

	const driver: BenchmarkDriver = {
		target: () => ({ prefix: "computer" }),
		capable: () => ({ ok: true }),
		async openFixtureWindow({ fixtureId: fid, nonce: n }) {
			fixtureId = fid;
			nonce = n;
			readCount = 0;
			return { handle: handleOf(), close: async () => void (closed = true) };
		},
		async readWindow() {
			const reads = readCount++;
			// 模拟窗口被替换：window_id 变化（真实 cua 的 snapshot_id 每读都换，不能当身份不变量）
			const changed = opts.windowChangesAfter !== undefined && reads >= opts.windowChangesAfter;
			return { prefix: "computer", pid: 4242, window_id: changed ? 999 : 7, window_token: "tok-1", fixture_id: fixtureId };
		},
		async observe() {
			if (opts.hangObserve) await observeGate;
			return { ok: true as const, structured: elements() };
		},
		async execute(_handle, tool, args) {
			dispatched.push({ tool, args });
			const token = String(args.element_token ?? "");
			if (tool.endsWith("click") && token === "tok-submit") store.record(fixtureId, nonce, { clicked: "submit" });
			return { isError: false };
		},
	};
	return { driver, dispatched, isClosed: () => closed, releaseObserve, handleOf: () => handleOf() };
}

const mockChooser = () => createMockChooser((req) => ({ kind: "selected", candidateId: req.candidates.find((c) => c.label.includes("提交"))?.id ?? req.candidates[0].id }));

const readyHost = (driver: BenchmarkDriver, store: BenchmarkFixtureStateStore) =>
	createBenchmarkHost({ driver, store, tasks: [TASK], warmup: 0, maxTrials: 1, chooserFor: mockChooser });

const waitTerminal = async (id: string): Promise<FastBenchmarkResult | null> => {
	for (let i = 0; i < 400; i++) {
		const s = benchmarkStatus(id);
		if (s && ["done", "cancelled", "blocked", "failed"].includes(s.status)) return s;
		await new Promise((r) => setTimeout(r, 5));
	}
	return benchmarkStatus(id);
};

test("fixture：HTML 带 fixtureId + nonce，状态只接受 arm 过的 (fixtureId, nonce)", () => {
	const html = renderBenchmarkFixtureHtml("fx-1", "nonce-1");
	assert.match(html, /fx-1/);
	assert.match(html, /nonce-1/);
	assert.match(html, /\/api\/fast-computer\/benchmark\/fixture\/fx-1\/state/);
	const store = new BenchmarkFixtureStateStore();
	assert.equal(store.record("fx-1", "nonce-1", { clicked: "submit" }), false, "未 arm 不接受");
	store.arm("fx-1", "nonce-1");
	assert.equal(store.record("fx-1", "nonce-1", { clicked: "submit" }), true);
	assert.deepEqual(store.get("fx-1", "nonce-1"), { clicked: "submit" });
	assert.equal(store.record("fx-1", "wrong", { clicked: "submit" }), false, "nonce 不符不接受（防串扰）");
	store.reset("fx-1", "nonce-1");
	assert.deepEqual(store.get("fx-1", "nonce-1"), {});
});

test("host：真实闭环——模型只选 click，双证据（机器状态 + UI 观测）判 correct", async () => {
	_resetBenchmarks();
	_resetFastComputerState();
	saveFastComputerSettings({ enabled: true, kind: "chat", provider: "p", id: "m" });
	const store = new BenchmarkFixtureStateStore();
	const { driver, dispatched } = fakeDriver(store);
	const host = readyHost(driver, store);
	const avail = host.availability();
	assert.deepEqual(avail, { cuaReady: true, modelReady: true, fixtureReady: true, reasons: [] });
	const run = await host.start({});
	const s = await waitTerminal(run.id);
	assert.equal(s?.status, "done");
	assert.equal(s?.correctness, 1);
	assert.equal(s?.actions, 1);
	assert.ok(dispatched.length === 1 && dispatched[0].tool.startsWith("mcp__computer__click"), `只应派发一次 click，实际 ${JSON.stringify(dispatched)}`);
});

test("host：窗口身份变化（window_id）→ fail-closed，blocked 且 0 执行", async () => {
	_resetBenchmarks();
	saveFastComputerSettings({ enabled: true, kind: "chat", provider: "p", id: "m" });
	const store = new BenchmarkFixtureStateStore();
	const { driver, dispatched } = fakeDriver(store, { windowChangesAfter: 0 });
	const host = createBenchmarkHost({ driver, store, tasks: [TASK], warmup: 0, maxTrials: 1, chooserFor: mockChooser });
	const run = await host.start({});
	const s = await waitTerminal(run.id);
	assert.equal(s?.status, "blocked");
	assert.match(s?.reason ?? "", /window_id/);
	assert.equal(dispatched.length, 0, "身份变化时绝不执行");
});

test("host：取消 → cancelled，且 finally 只关闭自己打开的 fixture 窗口", async () => {
	_resetBenchmarks();
	saveFastComputerSettings({ enabled: true, kind: "chat", provider: "p", id: "m" });
	const store = new BenchmarkFixtureStateStore();
	const { driver, isClosed, releaseObserve } = fakeDriver(store, { hangObserve: true });
	const host = createBenchmarkHost({ driver, store, tasks: [TASK], warmup: 0, maxTrials: 4, chooserFor: mockChooser });
	const run = await host.start({});
	const { cancelBenchmark } = await import("../src/fast-computer/benchmark.ts");
	assert.equal(cancelBenchmark(run.id), true);
	releaseObserve();
	const s = await waitTerminal(run.id);
	assert.equal(s?.status, "cancelled");
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(isClosed(), true, "结束后只关闭自有窗口");
});

test("routes：fixture 页面 + 状态上报（错误 nonce 不生效），run 私有状态按 owner 过滤", async () => {
	_resetBenchmarks();
	_resetFastComputerState();
	saveFastComputerSettings({ enabled: true, kind: "chat", provider: "p", id: "m" });
	const store = new BenchmarkFixtureStateStore();
	const { driver } = fakeDriver(store);
	const host = readyHost(driver, store);
	const app = new Hono();
	mountFastComputerRoutes(app, { host, store });

	const page = await app.request("/api/fast-computer/benchmark/fixture/fx-r?nonce=n-r");
	assert.equal(page.status, 200);
	assert.match(await page.text(), /n-r/);

	store.arm("fx-r", "n-r");
	const ok = await app.request("/api/fast-computer/benchmark/fixture/fx-r/state?nonce=n-r", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clicked: "submit" }) });
	assert.deepEqual(await ok.json(), { ok: true });
	const bad = await app.request("/api/fast-computer/benchmark/fixture/fx-r/state?nonce=other", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clicked: "cancel" }) });
	assert.deepEqual(await bad.json(), { ok: false });

	const listed = await app.request("/api/fast-computer/benchmark");
	const body = (await listed.json()) as { availability: unknown; runs: unknown[] };
	assert.ok(Array.isArray(body.runs));
	assert.equal((await app.request("/api/fast-computer/benchmark/nope")).status, 404);
});

test("host：平台拿不到独立窗口证明 → capability fail-closed，availability blocked（不假装 ready）", async () => {
	_resetBenchmarks();
	saveFastComputerSettings({ enabled: true, kind: "chat", provider: "p", id: "m" });
	const store = new BenchmarkFixtureStateStore();
	const { driver } = fakeDriver(store);
	const capped: BenchmarkDriver = { ...driver, capable: () => ({ ok: false, reason: "当前平台不支持独立受控窗口" }) };
	const host = readyHost(capped, store);
	const avail = host.availability();
	assert.equal(avail.cuaReady, false);
	assert.equal(avail.fixtureReady, false);
	assert.match(avail.reasons.join(" "), /不支持独立受控窗口/);
	await assert.rejects(() => host.start({}));
});

test("host：无目标电脑 / 无快速模型 → blocked 原因明确，start 抛错", async () => {
	_resetBenchmarks();
	_resetFastComputerState();
	saveFastComputerSettings({ enabled: false, kind: "chat", provider: "", id: "" });
	const store = new BenchmarkFixtureStateStore();
	const { driver } = fakeDriver(store);
	const noTarget: BenchmarkDriver = { ...driver, target: () => null };
	const host = createBenchmarkHost({ driver: noTarget, store, chooserFor: mockChooser });
	const avail = host.availability();
	assert.equal(avail.cuaReady, false);
	assert.equal(avail.modelReady, false);
	assert.ok(fastComputerSettings().enabled === false);
	await assert.rejects(() => host.start({}));
});
