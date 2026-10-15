/**
 * 快速操作模型 · 真实操控基准测试：契约、可注入 runner（状态 / 取消 / fail-closed）、
 * 精确窗口身份、双证据判分、聚合（冷启动单列 / p95 粗略标记 / advisory 不 hard-disable）。
 *
 * 全程假依赖、假时钟、0 真实付费、0 真实 CUA、无副作用工具。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastSelectResult } from "../src/fast-computer/index.ts";
import {
	_resetBenchmarks,
	benchmarkStatus,
	cancelBenchmark,
	startBenchmark,
	validateTrial,
	windowIdentityMismatch,
	WindowIdentityError,
	type BenchmarkWindow,
	type FastBenchmarkTask,
	type TrialMetrics,
} from "../src/fast-computer/benchmark.ts";
import { createCuaTrialRunner, BENCHMARK_ALLOWED_TOOLS } from "../src/fast-computer/benchmark-cua.ts";
import { evaluateBenchmarkCapability, BENCHMARK_REQUIRED_TOOLS } from "../src/fast-computer/benchmark-capability.ts";
import { verifyExpectation } from "../src/fast-computer/index.ts";

const win = (patch: Partial<BenchmarkWindow> = {}): BenchmarkWindow => ({ prefix: "computer", pid: 4242, windowId: 7, windowToken: "tok-1", fixtureId: "fixture-bench", ...patch });
const observed = (patch: Record<string, unknown> = {}) => ({ prefix: "computer", pid: 4242, window_id: 7, window_token: "tok-1", fixture_id: "fixture-bench", ...patch });

const task = (patch: Partial<FastBenchmarkTask> = {}): FastBenchmarkTask => ({
	id: "t1",
	kind: "click",
	title: "点提交",
	goal: "点击提交按钮",
	timeoutMs: 2000,
	expect: { machine: { clicked: "submit" }, ui: { role: "button", label_contains: "提交" } },
	...patch,
});

const metrics = (patch: Partial<TrialMetrics> = {}): TrialMetrics => ({ correctness: "correct", actions: 1, programAssists: 0, retries: 0, fallbackCount: 0, abstain: false, ...patch });

const waitFor = async (id: string, statuses: string[]) => {
	for (let i = 0; i < 200; i++) {
		const s = benchmarkStatus(id);
		if (s && statuses.includes(s.status)) return s;
		await new Promise((r) => setTimeout(r, 5));
	}
	return benchmarkStatus(id);
};

test("窗口身份 fail-closed：任一字段不符都返回原因", () => {
	assert.equal(windowIdentityMismatch(win(), observed()), null);
	// snapshot_id 每次读取都会换新，token 不等不再算失配；缺失才算读不到
	assert.equal(windowIdentityMismatch(win(), observed({ window_token: "tok-2" })), null, "token 换新不算失配");
	assert.match(windowIdentityMismatch(win(), observed({ window_token: "" })) ?? "", /token/);
	assert.match(windowIdentityMismatch(win(), observed({ pid: 1 })) ?? "", /pid/);
	assert.match(windowIdentityMismatch(win(), observed({ window_id: 9 })) ?? "", /window_id/);
	assert.match(windowIdentityMismatch(win(), observed({ fixture_id: "other" })) ?? "", /fixture/);
	assert.match(windowIdentityMismatch(win({ session: "s1" }), observed()) ?? "", /session/);
	assert.match(windowIdentityMismatch(win(), null) ?? "", /读不到/);
});

test("双证据判分：两者 confirmed 才 correct；任一反证 incorrect；未知不算成功", () => {
	const verifyUi = (e: unknown, s: unknown) => verifyExpectation(e as never, s);
	assert.equal(validateTrial({ expect: task().expect, machine: { clicked: "submit" }, ui: { elements: [{ role: "button", label: "提交", value: "1", actions: [] }] }, verifyUi }).outcome, "correct");
	assert.equal(validateTrial({ expect: task().expect, machine: { clicked: "other" }, ui: { elements: [{ role: "button", label: "提交", value: "1", actions: [] }] }, verifyUi }).outcome, "incorrect");
	assert.equal(validateTrial({ expect: { machine: { clicked: "submit" } }, machine: { clicked: "submit" }, ui: {}, verifyUi }).outcome, "unknown");
	assert.equal(validateTrial({ expect: task().expect, machine: {}, ui: {}, verifyUi }).outcome, "unknown");
});

test("双证据判分：机器状态 freshness —— 早于本轮 / 无时间戳一律不能 confirmed", () => {
	const verifyUi = (e: unknown, s: unknown) => verifyExpectation(e as never, s);
	const ui = { elements: [{ role: "button", label: "提交", value: "1", actions: [] }] };
	// 时间戳早于本轮开始 → 降为 unknown，不能当正证据
	const stale = validateTrial({ expect: task().expect, machine: { clicked: "submit" }, machineUpdatedAt: 100, machineFreshAfter: 200, ui, verifyUi });
	assert.equal(stale.outcome, "unknown");
	assert.match(stale.reason, /过期/);
	// 缺少时间戳 → unknown
	assert.equal(validateTrial({ expect: task().expect, machine: { clicked: "submit" }, machineUpdatedAt: null, machineFreshAfter: 200, ui, verifyUi }).outcome, "unknown");
	// 本轮之后写的才 confirmed
	assert.equal(validateTrial({ expect: task().expect, machine: { clicked: "submit" }, machineUpdatedAt: 300, machineFreshAfter: 200, ui, verifyUi }).outcome, "correct");
});

test("能力探测：就绪 + 隔离窗口 + 工具齐全 + 网关 → ok；缺任一样 fail-closed", () => {
	const tools = ["launch_app", ...BENCHMARK_REQUIRED_TOOLS];
	assert.equal(evaluateBenchmarkCapability({ ready: true, tools, openTool: "launch_app", sandbox: true }).ok, true);
	assert.match(evaluateBenchmarkCapability({ ready: false, tools, openTool: "launch_app", sandbox: true }).reason ?? "", /未就绪/);
	assert.match(evaluateBenchmarkCapability({ ready: true, tools, openTool: "launch_app", sandbox: false }).reason ?? "", /隔离/);
	assert.match(evaluateBenchmarkCapability({ ready: true, tools: null, openTool: "launch_app", sandbox: true }).reason ?? "", /能力清单/);
	assert.match(evaluateBenchmarkCapability({ ready: true, tools: ["launch_app", "click"], openTool: "launch_app", sandbox: true }).reason ?? "", /缺少/);
	assert.match(evaluateBenchmarkCapability({ ready: true, tools, openTool: "launch_app", sandbox: true, gateway: { ok: false } }).reason ?? "", /网关/);
});

test("runner：完成并聚合，冷启动单列、p95 样本不足标粗略、advisory 不 hard-disable", async () => {
	_resetBenchmarks();
	let clock = 0;
	const lat = [500, 100, 120, 110, 130, 140, 150, 160, 170];
	let i = 0;
	const started = startBenchmark(
		{ provider: "p", model: "m", window: win(), tasks: [task()], warmup: 1, maxTrials: 8, responseBudgetMs: 1000, p95MinSamples: 20 },
		{ now: () => clock, runTrial: async () => { clock += lat[Math.min(i++, lat.length - 1)]; return metrics(); } },
	);
	assert.equal(started.status, "running");
	const s = await waitFor(started.id, ["done"]);
	assert.ok(s);
	assert.equal(s.status, "done");
	assert.equal(s.samples, 8);
	assert.equal(s.coldStartMs, 500, "冷启动单独记录");
	assert.ok(s.p50Ms !== null && s.p95Ms !== null);
	assert.equal(s.p95Approx, true, "样本 8 < 20 → 粗略");
	assert.equal(s.successRatio, 1);
	assert.equal(s.correctness, 1);
	assert.equal(s.advisory.verdict, "ok");
	assert.equal(s.advisory.recommended, false);
	assert.match(s.note, /冷启动/);
	assert.match(s.note, /粗粗|粗略/);
});

test("runner：慢 → advisory slow 但仍 recommended 只建议，不 hard-disable", async () => {
	_resetBenchmarks();
	let t = 0;
	const started = startBenchmark({ provider: "p", model: "m", window: win(), tasks: [task()], warmup: 0, maxTrials: 6, responseBudgetMs: 500 }, { now: () => (t += 900), runTrial: async () => metrics() });
	const s = await waitFor(started.id, ["done"]);
	assert.equal(s?.advisory.verdict, "slow");
	assert.equal(s?.advisory.recommended, true);
	assert.equal(s?.status, "done", "慢不改变可执行状态");
});

test("runner：低稳定 → advisory unstable 建议排查，不封死配置", async () => {
	_resetBenchmarks();
	let t = 0;
	const started = startBenchmark({ provider: "p", model: "m", window: win(), tasks: [task()], warmup: 0, maxTrials: 5, failCap: 10 }, { now: () => (t += 100), runTrial: async () => metrics({ correctness: "unknown", error: "x" }) });
	const s = await waitFor(started.id, ["done"]);
	assert.equal(s?.advisory.verdict, "unstable");
	assert.equal(s?.advisory.recommended, false);
});

test("runner：取消后不再派发，状态 cancelled 且结果不完整", async () => {
	_resetBenchmarks();
	let dispatched = 0;
	let release: () => void = () => {};
	const gate = new Promise<void>((r) => (release = r));
	const started = startBenchmark(
		{ provider: "p", model: "m", window: win(), tasks: [task()], warmup: 0, maxTrials: 6 },
		{
			now: () => Date.now(),
			runTrial: async () => {
				dispatched++;
				if (dispatched === 2) await gate;
				return metrics();
			},
		},
	);
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(cancelBenchmark(started.id), true);
	release();
	const s = await waitFor(started.id, ["cancelled"]);
	assert.equal(s?.status, "cancelled");
	assert.ok(dispatched <= 2, `取消后不应继续派发，实际 ${dispatched}`);
});

test("runner：并发上限被遵守", async () => {
	_resetBenchmarks();
	let active = 0;
	let peak = 0;
	const started = startBenchmark(
		{ provider: "p", model: "m", window: win(), tasks: [task()], warmup: 0, maxTrials: 6, concurrency: 2 },
		{
			now: () => Date.now(),
			runTrial: async () => {
				active++;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 5));
				active--;
				return metrics();
			},
		},
	);
	await waitFor(started.id, ["done"]);
	assert.ok(peak <= 2, `并发峰值 ${peak} 不应超过 2`);
});

test("runner：连续错误达到 failCap → failed 并中止", async () => {
	_resetBenchmarks();
	const started = startBenchmark({ provider: "p", model: "m", window: win(), tasks: [task()], warmup: 0, maxTrials: 10, failCap: 3, concurrency: 1 }, { now: () => Date.now(), runTrial: async () => metrics({ correctness: "unknown", error: "boom" }) });
	const s = await waitFor(started.id, ["failed"]);
	assert.equal(s?.status, "failed");
	assert.ok((s?.samples ?? 0) <= 3);
});

// ---------------------------------------------------------------- CUA 真实执行器（假 CUA 依赖）

function cuaHarness(overrides: Partial<Parameters<typeof createCuaTrialRunner>[1]> = {}) {
	const dispatched: { tool: string; args: Record<string, unknown> }[] = [];
	const deps: Parameters<typeof createCuaTrialRunner>[1] = {
		readWindow: async () => observed(),
		observe: async () => ({ ok: true, structured: { elements: [{ role: "button", label: "提交", value: "v", actions: ["press"], element_token: "tk-1" }] } }),
		collectCandidates: () => [{ id: "el-0", label: "按钮：提交", tool: "mcp__computer__click", args: { pid: 4242, window_id: 7, element_token: "tk-1" }, semantic: { role: "button", label: "提交", value: "v", actions: ["press"] } }],
		choose: async (): Promise<FastSelectResult> => ({ kind: "selected", candidate: { id: "el-0", label: "按钮：提交", tool: "mcp__computer__click", args: { pid: 4242, window_id: 7, element_token: "tk-1" }, semantic: { role: "button", label: "提交", value: "v", actions: ["press"] } }, captureId: "cap-1", uncalibrated: true }),
		execute: async (tool, args) => {
			dispatched.push({ tool, args });
			return { isError: false };
		},
		readMachineState: async () => ({ state: { clicked: "submit" }, updatedAt: Date.now() }),
		...overrides,
	};
	return { deps, dispatched };
}

const runOne = (runner: ReturnType<typeof createCuaTrialRunner>, t = task()) => runner(t, { trialIndex: 0, coldStart: true, signal: new AbortController().signal });

test("CUA 执行器：真实闭环用双证据判 correct，只派发 click", async () => {
	const { deps, dispatched } = cuaHarness();
	const r = await runOne(createCuaTrialRunner(win(), deps));
	assert.equal(r.correctness, "correct");
	assert.equal(r.actions, 1);
	assert.deepEqual(dispatched.map((d) => d.tool), ["mcp__computer__click"]);
	assert.ok(BENCHMARK_ALLOWED_TOOLS.includes("click"));
});

test("CUA 执行器：候选为非 click（type）不派发，计 unknown（不伪造 typing 能力）", async () => {
	const { deps, dispatched } = cuaHarness({ choose: async (): Promise<FastSelectResult> => ({ kind: "selected", candidate: { id: "el-x", label: "输入框", tool: "mcp__computer__type_text", args: {}, semantic: { role: "textfield", label: "金额" } }, captureId: "cap-1", uncalibrated: true }) });
	const r = await runOne(createCuaTrialRunner(win(), deps), task({ kind: "type" }));
	assert.equal(r.correctness, "unknown");
	assert.match(r.error ?? "", /白名单/);
	assert.equal(dispatched.length, 0);
});

test("CUA 执行器：程序侧滚动辅助 —— 先走正式 backend scroll（无坐标），再只 click；计入 programAssists", async () => {
	const { deps, dispatched } = cuaHarness();
	const scrollTask = task({ id: "scroll-target", kind: "click", goal: "点击最下面的「深度目标」", programAssist: { scroll: { direction: "down", amount: 8 } }, expect: { machine: { clicked: "submit" }, ui: { role: "button", label_contains: "提交" } } });
	const r = await runOne(createCuaTrialRunner(win(), deps), scrollTask);
	assert.equal(dispatched[0]?.tool, "scroll", "程序侧先滚动");
	assert.deepEqual(Object.keys(dispatched[0]?.args ?? {}).sort(), ["amount", "direction", "pid", "window_id"].sort(), "滚动只给方向，不给坐标");
	assert.equal((dispatched[0]?.args as { direction?: string }).direction, "down");
	assert.equal(dispatched[1]?.tool, "mcp__computer__click", "模型只 click");
	assert.equal(r.programAssists, 1, "滚动计入程序辅助");
	assert.equal(r.actions, 1, "模型动作只有 1 次 click");
});

test("CUA 执行器：窗口身份变化（pid）→ fail-closed 中止（抛 WindowIdentityError）", async () => {
	const { deps } = cuaHarness({ readWindow: async () => observed({ pid: 9999 }) });
	await assert.rejects(() => runOne(createCuaTrialRunner(win(), deps)), (e) => e instanceof WindowIdentityError && /pid/.test((e as Error).message));
});

test("CUA 执行器：快速路径 fallback/abstain 不派发任何动作", async () => {
	const { deps, dispatched } = cuaHarness({ choose: async (): Promise<FastSelectResult> => ({ kind: "fallback", reason: "abstain", detail: "拿不准" }) });
	const r = await runOne(createCuaTrialRunner(win(), deps));
	assert.equal(dispatched.length, 0);
	assert.equal(r.fallbackCount, 0, "未真正执行主模型回退 → fallbackCount 必须为 0");
	assert.equal(r.retries, 0);
	assert.equal(r.abstain, true);
});

test("CUA 执行器：0 真实付费——chooser 只在候选内选，不触发任何额外模型调用", async () => {
	let chooseCalls = 0;
	const { deps } = cuaHarness({
		choose: async (): Promise<FastSelectResult> => {
			chooseCalls++;
			return { kind: "selected", candidate: { id: "el-0", label: "按钮：提交", tool: "mcp__computer__click", args: { pid: 4242, window_id: 7, element_token: "tk-1" }, semantic: { role: "button", label: "提交", value: "v", actions: ["press"] } }, captureId: "cap-1", uncalibrated: true };
		},
	});
	await runOne(createCuaTrialRunner(win(), deps));
	assert.equal(chooseCalls, 1);
});
