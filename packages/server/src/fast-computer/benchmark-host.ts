/**
 * 快速操作模型 · 真实操控基准测试 —— 运行时宿主（把 fixture / 模型 / 电脑通道接成一条真实闭环）。
 *
 * 职责：
 *  - `availability()`：目标电脑（hostpc / computer，由用户显式选择）、快速模型、fixture 是否就绪；任一不就绪明确 blocked；
 *  - `start()`：**只为本次运行**打开一个受控 fixture 窗口并 pin 精确身份（prefix/pid/window_id/session/window_token/fixture_id/nonce），
 *    用与正式操控同一条路径（selectFastAction + createCuaTrialRunner）真实跑，结束后 **只关闭自己打开的那个 fixture 窗口 / 标签页**，
 *    绝不杀用户浏览器、绝不关别的窗口；
 *  - 全局并发互斥：同一时刻只允许一次真实运行，避免两次运行互相抢窗口；
 *  - 目标电脑未授权 / 助理电脑未启动 → 明确 blocked（不偷偷起 VM、不改用用户窗口）。
 *
 * 所有与真实世界交互都经注入的 `BenchmarkDriver`；测试注入假 driver，生产注入经统一 computer backend 的真实 driver。
 */
import { selectFastAction, fastComputerSettings, type FastActionChooser, type FastComputerSettings } from "./index.ts";
import { clickCandidatesFromWindowState, buildChooser, type FastTarget } from "./tool.ts";
import { createCuaTrialRunner } from "./benchmark-cua.ts";
import {
	onBenchmarkUpdate,
	startBenchmark,
	type BenchmarkAvailability,
	type BenchmarkProvenance,
	type BenchmarkWindow,
	type FastBenchmarkResult,
	type FastBenchmarkTask,
	type ObservedWindow,
} from "./benchmark.ts";
import { BenchmarkFixtureStateStore, benchmarkFixturePagePath, benchmarkFixtureTasks } from "./benchmark-fixture.ts";

/** 已 pin 身份的受控 fixture 窗口句柄。 */
export interface FixtureWindowHandle {
	prefix: "hostpc" | "computer";
	session?: string;
	pid: number;
	windowId: number;
	windowToken: string;
	fixtureId: string;
	url: string;
}

/**
 * 目标电脑驱动：真实实现经统一 computer backend（cua MCP / 浏览器 CDP）调用；
 * 测试注入假实现（模拟真 driver 调用序列），源码仍是真路径。
 */
export interface BenchmarkDriver {
	/** 用户显式选择的目标电脑；未授权 / 未启动返回 null（附原因）。传入 requested 表示用户点名要哪台。 */
	target(requested?: "hostpc" | "computer"): { prefix: "hostpc" | "computer"; session?: string } | null;
	/** 这台平台是否能拿到**独立受控 fixture 窗口**的证明；拿不到就必须 false（fail-closed，不假装 ready）。默认 true。 */
	capable?(): { ok: boolean; reason?: string };
	/** 本次驱动来源：真实 CUA 返回 "cua"，测试 / 假驱动返回 "fixture"；不实现则按 unknown。 */
	provenance?(): BenchmarkProvenance;
	/** 打开属于本次运行的 fixture 窗口并 pin 身份；失败抛错。close 只关自己打开的窗口 / 标签页。 */
	openFixtureWindow(input: { url: string; fixtureId: string; nonce: string; target?: "hostpc" | "computer" }): Promise<{ handle: FixtureWindowHandle; close: () => Promise<void> }>;
	/** 读取窗口身份（fail-closed 用）；读不到返回 null。 */
	readWindow(handle: FixtureWindowHandle): Promise<ObservedWindow | null>;
	/** 读取窗口状态（含 elements 与 element_token）。 */
	observe(handle: FixtureWindowHandle): Promise<{ ok: true; structured: unknown } | { ok: false; error: string }>;
	/** 派发动作；真实实现经统一 backend 的 guard / 审批 / 暂停。 */
	execute(handle: FixtureWindowHandle, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ isError: boolean }>;
}

export interface BenchmarkHostOptions {
	driver: BenchmarkDriver;
	store: BenchmarkFixtureStateStore;
	tasks?: FastBenchmarkTask[];
	/** 测试注入：覆盖默认 chooser 构建（生产不传，走 buildChooser）。 */
	chooserFor?: (s: FastComputerSettings) => FastActionChooser | null;
	now?: () => number;
	warmup?: number;
	maxTrials?: number;
	/** 目标未就绪时的额外说明（例如「先在设置 › 电脑里开启操作这台电脑」）。 */
	notReadyReason?: string;
}

export interface BenchmarkHost {
	availability(): BenchmarkAvailability;
	start(input: { provider?: string; model?: string; maxTrials?: number; warmup?: number; target?: "hostpc" | "computer" }): Promise<FastBenchmarkResult>;
}

const TERMINAL = new Set(["done", "cancelled", "blocked", "failed"]);

/** 构造真实运行的宿主。 */
export function createBenchmarkHost(opts: BenchmarkHostOptions): BenchmarkHost {
	let active: { id: string; fixtureId: string; nonce: string; close: () => Promise<void>; unsubscribe: () => void } | null = null;

	const modelTarget = (): { provider: string; id: string } | null => {
		const s = fastComputerSettings();
		return s.enabled && s.provider && s.id ? { provider: s.provider, id: s.id } : null;
	};

	const availability = (): BenchmarkAvailability => {
		const reasons: string[] = [];
		const targetSel = opts.driver.target();
		if (!targetSel) reasons.push(opts.notReadyReason ?? "没有可用的真实电脑通道：请先在设置 › 电脑里开启「操作这台电脑」，或启动助理电脑。");
		const capable = opts.driver.capable?.() ?? { ok: true };
		if (targetSel && !capable.ok) reasons.push(capable.reason ?? "当前平台无法为基准测试取得独立受控窗口（fail-closed）。");
		const model = modelTarget();
		if (!model) reasons.push("还没选定快速操作模型（设置 › 模型 › 快速操作模型）。");
		return { cuaReady: !!targetSel && capable.ok, modelReady: !!model, fixtureReady: !!targetSel && capable.ok, reasons };
	};

	const armRun = (runId: string, fixtureId: string, nonce: string, close: () => Promise<void>) => {
		const unsubscribe = onBenchmarkUpdate(runId, (r: FastBenchmarkResult) => {
			if (!TERMINAL.has(r.status)) return;
			if (active?.id !== runId) return;
			active = null;
			opts.store.disarm(fixtureId, nonce);
			void close().catch(() => {});
			unsubscribe();
		});
		active = { id: runId, fixtureId, nonce, close, unsubscribe };
	};

	const start = async (input: { provider?: string; model?: string; maxTrials?: number; warmup?: number; target?: "hostpc" | "computer" }): Promise<FastBenchmarkResult> => {
		const avail = availability();
		if (!avail.cuaReady || !avail.modelReady || !avail.fixtureReady) throw new Error(avail.reasons.join(" "));
		if (active) throw new Error("已有一次真实操控测试在运行，请等它结束或先取消。");

		const settings = fastComputerSettings();
		const provider = input.provider || settings.provider;
		const model = input.model || settings.id;
		if (!provider || !model) throw new Error("需要先选定快速操作模型（provider/model）。");

		const targetSel = opts.driver.target(input.target)!;
		const fixtureId = `bench-${randomToken(6)}`;
		const nonce = randomToken(10);
		opts.store.arm(fixtureId, nonce);

		let opened: { handle: FixtureWindowHandle; close: () => Promise<void> };
		try {
			opened = await opts.driver.openFixtureWindow({ url: benchmarkFixturePagePath(fixtureId, nonce), fixtureId, nonce, target: input.target });
		} catch (e) {
			opts.store.disarm(fixtureId, nonce);
			throw e;
		}
		const handle = opened.handle;
		const prefixTool = handle.prefix === "hostpc" ? "mcp__hostpc__" : "mcp__computer__";
		const fastTarget: FastTarget = { pid: handle.pid, window_id: handle.windowId, ...(handle.session ? { session: handle.session } : {}) };
		const window: BenchmarkWindow = { prefix: handle.prefix, pid: handle.pid, windowId: handle.windowId, session: handle.session, windowToken: handle.windowToken, fixtureId };

		const chooser = (opts.chooserFor ?? buildChooser)(settings);
		if (!chooser) {
			opts.store.disarm(fixtureId, nonce);
			await opened.close().catch(() => {});
			throw new Error("没有可用的快速模型选择器（请检查快速操作模型设置）。");
		}

		const runner = createCuaTrialRunner(window, {
			readWindow: () => opts.driver.readWindow(handle),
			observe: () => opts.driver.observe(handle),
			collectCandidates: (structured) => clickCandidatesFromWindowState(prefixTool, fastTarget, structured),
			choose: (goal, candidates, signal) => selectFastAction({ key: `${handle.prefix}:${handle.pid}:${handle.windowId}`, goal, candidates, chooser, settings, signal }),
			execute: (tool, args, signal) => opts.driver.execute(handle, tool, args, signal),
			readMachineState: async () => opts.store.get(fixtureId, nonce),
		});

		let started: FastBenchmarkResult;
		try {
			started = startBenchmark(
				{ provider, model, provenance: opts.driver.provenance?.() ?? "unknown", window, tasks: opts.tasks ?? benchmarkFixtureTasks(), warmup: opts.warmup ?? 1, maxTrials: opts.maxTrials ?? 6, concurrency: 1 },
				{
					now: opts.now,
					runTrial: async (task, ctx) => {
						// 每轮试次开始前清空 fixture 状态，杜绝上一轮遗留把本轮误判成通过。
						opts.store.reset(fixtureId, nonce);
						return runner(task, ctx);
					},
				},
			);
		} catch (e) {
			opts.store.disarm(fixtureId, nonce);
			await opened.close().catch(() => {});
			throw e;
		}
		armRun(started.id, fixtureId, nonce, opened.close);
		return started;
	};

	return { availability, start };
}

const randomToken = (n: number) => {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let out = "";
	for (let i = 0; i < n; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
	return out;
};
