/**
 * 快速操作模型 · 真实操控基准测试（fast-model-benchmark）—— 契约、可注入 runner、聚合与判定。
 *
 * 定位（2026-10-22 用户纠正后的方向）：**不是**测模型 API 连接 / 固定 choice 题的时延，
 * 而是让快速模型在**专用隔离的本地 fixture 测试窗口**里真实走一遍操控闭环：
 * 观察 → 候选 → classifier/快速模型选一个 → 执行前用**精确窗口身份**fail-closed 重校验 →
 * 经既有电脑工具派发 click/select/type → 用**独立双证据**（fixture 机器状态 reporter + 独立 UI 观测）判分。
 *
 * 本文件是**纯逻辑 + 契约**：
 *  - 不直接调 CUA、不碰 secret/凭据、不读配置单例、不认识具体模型服务；
 *  - 所有与真实世界交互（观察 / 派发 / 机器状态 / UI 观测 / 窗口身份 / 时钟）都由注入的依赖提供，
 *    因此核心状态机、取消、fail-closed、聚合、判定都能用假时钟 / 假依赖在单测里完整验证；
 *  - 真实 CUA 运行需要「操作这台电脑」或助理电脑就绪，未就绪时上层必须明确 blocked，**不静默降级成 mock 冒充 real**。
 *
 * 安全不变量（与 fast-computer/index.ts 一致，只是加了「基准」这一层诊断）：
 *  - 只允许作用在给定 `window`（prefix + pid + window_id + session + **精确 window_token** + fixture_id）上；
 *    每次派发前重新校验，任一不符立即中止整轮，绝不派发、绝不切到用户其它窗口 / app / 账号 / 文件 / 付款 / 发送；
 *  - 快速模型只 click（避免把「程序固定输入」冒充成模型的 typing 能力）；type 不计入本基准的模型能力结论；
 *  - 任务集合固定、有限、synthetic，不接任意外部 URL / Key，不自动跑付费模型列表；
 *  - 判分用机器状态 + 独立 UI 观测双证据，**绝不采信模型自评**；
 *  - 结果只做 advisory，慢 / 不稳**不 hard-disable** 任何配置。
 */

import type { VerifyOutcome } from "./index.ts";

/** 基准任务类型。`type` 只为覆盖输入框场景，本基准**不**把模型的 type 能力计入结论（type 由程序固定输入）。 */
export type BenchTaskKind = "click" | "select" | "type" | "multistep";

/** 一个固定、有界的 synthetic 任务（由应用 fixture 提供，不是用户任意输入）。 */
export interface FastBenchmarkTask {
	id: string;
	kind: BenchTaskKind;
	/** 界面/结果里展示的一句话说明 */
	title: string;
	/** 交给快速模型的目标描述（只描述意图，不含工具名 / 坐标 / 参数） */
	goal: string;
	timeoutMs: number;
	/** 多步任务需要的动作步数（默认 1）；每步都重新观察 → 选 → 派发 */
	steps?: number;
	/** 预期后置条件：fixture 机器状态字段 + 独立 UI 观测共同判定（见 validateTrial） */
	expect: BenchmarkExpectation;
}

/** 预期后置条件 = 机器状态断言 + UI 观测断言（两者都来自 fixture，不由模型给）。 */
export interface BenchmarkExpectation {
	/** fixture 页面的机器状态（例如 { clicked: "submit" }）；用 declared 字段做精确比较 */
	machine?: Record<string, unknown>;
	/** 独立 UI 观测（例如 { role: "button", label_contains: "完成" }），走 verifyExpectation 语义 */
	ui?: { role?: string; label_contains?: string; value_equals?: string; action_contains?: string; exists?: boolean };
}

// ---------------------------------------------------------------- 精确窗口身份（fail-closed）

/** 基准确认要作用的那一个窗口：prefix + pid + window_id + session + 精确 token + fixture id。 */
export interface BenchmarkWindow {
	/** `hostpc` = 用户电脑；`computer` = 助理电脑 */
	prefix: "hostpc" | "computer";
	pid: number;
	windowId: number;
	session?: string;
	/** cua 读取窗口状态时给出的精确窗口身份 token（每次读取都可能变，必须逐次相等比较） */
	windowToken: string;
	/** fixture 实例 id（测试页窗口标题里带的稳定标记），防止命中同名窗口 */
	fixtureId: string;
}

/** 实际观测到的窗口身份（由 cua get_window_state 的元数据回填）。 */
export interface ObservedWindow {
	prefix: string;
	pid: number;
	window_id: number;
	session?: string;
	window_token: string;
	fixture_id?: string;
}

/**
 * 精确比较窗口身份。返回 null = 一致；否则返回不一致原因（fail-closed）。
 * 逐项严格相等，缺一不可；`fixture_id` 必须与给定 fixtureId 一致（没有则视为不一致，绝不「大概是它」）。
 */
export function windowIdentityMismatch(expected: BenchmarkWindow, observed: ObservedWindow | null | undefined): string | null {
	if (!observed) return "读不到窗口身份";
	if (observed.prefix !== expected.prefix) return "电脑目标不一致";
	if (observed.pid !== expected.pid) return `pid 不一致（期望 ${expected.pid}，实际 ${observed.pid}）`;
	if (observed.window_id !== expected.windowId) return `window_id 不一致（期望 ${expected.windowId}，实际 ${observed.window_id}）`;
	if ((observed.session ?? "") !== (expected.session ?? "")) return "cua session 不一致";
	if (!observed.window_token || observed.window_token !== expected.windowToken) return "窗口 token 已变化";
	if (observed.fixture_id !== expected.fixtureId) return "fixture id 不一致";
	return null;
}

/** 派发前窗口身份失配 / 失焦时抛出；runner 捕获后立即中止整轮（blocked），绝不继续。 */
export class WindowIdentityError extends Error {
	constructor(public readonly reason: string) {
		super(`测试窗口身份校验失败：${reason}`);
		this.name = "WindowIdentityError";
	}
}

// ---------------------------------------------------------------- 判分（独立双证据）

export type GroundtruthOutcome = "correct" | "incorrect" | "unknown";

const norm = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/** 机器状态断言：declared 的每个字段都必须存在且精确相等，任一不符 → fail，缺字段 → unknown（不臆断）。 */
export function matchMachineExpectation(expected: Record<string, unknown> | undefined, machine: unknown): VerifyOutcome {
	if (!expected || Object.keys(expected).length === 0) return "unknown";
	if (!machine || typeof machine !== "object") return "unknown";
	const m = machine as Record<string, unknown>;
	let sawUnknown = false;
	for (const [k, v] of Object.entries(expected)) {
		if (!(k in m)) {
			sawUnknown = true;
			continue;
		}
		if (!Object.is(m[k], v) && norm(m[k]) !== norm(v)) return "unsatisfied";
	}
	return sawUnknown ? "unknown" : "confirmed";
}

/**
 * 双证据判分：机器状态 + 独立 UI 观测。
 *  - 两者都 confirmed → correct；
 *  - 任一 unsatisfied → incorrect（有正向反证）；
 *  - 其余（unknown）→ unknown，**不计入 success**，也绝不当成正确。
 * 模型自己的「我觉得点对了」不参与判分。
 */
export function validateTrial(opts: { expect: BenchmarkExpectation; machine: unknown; ui: unknown; verifyUi: (expected: BenchmarkExpectation["ui"], observed: unknown) => VerifyOutcome }): { outcome: GroundtruthOutcome; reason: string } {
	const machineOutcome = matchMachineExpectation(opts.expect.machine, opts.machine);
	const uiOutcome = opts.expect.ui ? opts.verifyUi(opts.expect.ui, opts.ui) : "unknown";
	if (machineOutcome === "unsatisfied" || uiOutcome === "unsatisfied") return { outcome: "incorrect", reason: `反证（machine=${machineOutcome}, ui=${uiOutcome}）` };
	if (machineOutcome === "confirmed" && uiOutcome === "confirmed") return { outcome: "correct", reason: "双证据通过" };
	return { outcome: "unknown", reason: `证据不足（machine=${machineOutcome}, ui=${uiOutcome}）` };
}

// ---------------------------------------------------------------- 单次试验指标

export interface TrialMetrics {
	/** 独立双证据判分结果（不由模型自评） */
	correctness: GroundtruthOutcome;
	error?: string;
	timeout?: boolean;
	/** 本试验实际派发的动作数 */
	actions: number;
	/** fast 路径未选中 / 需重试的累计（reobserve / 目标变化 / 执行错误等，诊断用） */
	retries: number;
	/** **真正执行了主模型回退**的次数；基准不执行主模型回退，所以恒为 0（不把「未选中」冒充回退） */
	fallbackCount: number;
	/** 是否 abstain（快速模型拿不准）——计入稳定性诊断，不算错误 */
	abstain: boolean;
}

// ---------------------------------------------------------------- 聚合结果 DTO（UI 与 API 共用）

export interface FastBenchmarkAdvisory {
	verdict: "ok" | "slow" | "unstable" | "blocked";
	/** 是否建议改用主模型 / 云端 */
	recommended: boolean;
	message: string;
	reason: string;
}

export type BenchmarkStatus = "running" | "done" | "cancelled" | "blocked" | "failed";

export interface FastBenchmarkResult {
	id: string;
	status: BenchmarkStatus;
	provider: string;
	model: string;
	/** 实际版本（真实调用后由 provider 回填）；未知写 "unknown"，不编造 */
	modelVersion: string;
	/** 本次测试作用的电脑 + fixture（只安全元数据，无凭据） */
	target: { prefix: "hostpc" | "computer"; fixtureId: string };
	/** 开始 / 结束时间（UTC ISO） */
	startedAt: string;
	finishedAt: string | null;
	/** 试次统计 */
	warmup: number;
	samples: number;
	/** 冷启动单独列，**不进** p50/p95 */
	coldStartMs: number | null;
	p50Ms: number | null;
	p95Ms: number | null;
	/** p95 是否只是粗略值（样本不足，不能当稳定结论） */
	p95Approx: boolean;
	timeouts: number;
	errors: number;
	successRatio: number;
	actions: number;
	retries: number;
	fallbackCount: number;
	abstains: number;
	/** 本轮 bench task 正确率（**不是**泛化 accuracy），未知为 null */
	correctness: number | null;
	correctTrials: number;
	/** 诊断说明（例如「推理时延仅诊断子项」「样本少，结论有限」） */
	note: string;
	advisory: FastBenchmarkAdvisory;
	/** 中止 / 阻塞原因（status=blocked/failed/cancelled 时） */
	reason: string | null;
	/** 结果落地时间（UTC）；持久化只允许安全元数据，过时需要提示 */
	createdAt: string;
}

// ---------------------------------------------------------------- 可注入 runner

export interface BenchmarkRunInput {
	id?: string;
	provider: string;
	model: string;
	modelVersion?: string;
	window: BenchmarkWindow;
	tasks: FastBenchmarkTask[];
	/** 预热次数（默认 1，预热不进统计）；第一条无论预热与否都记为冷启动 */
	warmup?: number;
	/** 最多测多少条非预热试次（默认 8，小样本；上限 50） */
	maxTrials?: number;
	/** 并发（默认 1；上限 4）——CUA 操控同窗口默认串行，避免互相干扰 */
	concurrency?: number;
	/** 产品目标响应预算（ms），仅用于 advisory，不是行业标准（默认 1000） */
	responseBudgetMs?: number;
	/** p95 视为粗略值的样本数下限（默认 20） */
	p95MinSamples?: number;
	/** 连续错误达到该数就中止整轮（默认 3） */
	failCap?: number;
	signal?: AbortSignal;
}

/** 单次试验执行器（真实实现走 CUA；测试注入假实现）。抛 WindowIdentityError = fail-closed 中止。 */
export type BenchmarkTrialRunner = (task: FastBenchmarkTask, ctx: { trialIndex: number; coldStart: boolean; signal: AbortSignal }) => Promise<TrialMetrics>;

export interface BenchmarkDeps {
	runTrial: BenchmarkTrialRunner;
	now?: () => number;
	/** 运行状态变化回调（可选，供 WS / 轮询） */
	onUpdate?: (r: FastBenchmarkResult) => void;
}

interface RunState {
	input: BenchmarkRunInput;
	trials: { taskId: string; metrics: TrialMetrics; latencyMs: number; coldStart: boolean; warmup: boolean }[];
	status: BenchmarkStatus;
	reason: string | null;
	coldStartMs: number | null;
	controller: AbortController;
	startedAt: number;
	finishedAt: number | null;
	subscribers: Set<(r: FastBenchmarkResult) => void>;
}

const runs = new Map<string, RunState>();
let seq = 0;

const nowMs = (deps: BenchmarkDeps) => deps.now ?? (() => Date.now());

const iso = (ms: number) => new Date(ms).toISOString();

const clampInt = (v: unknown, min: number, max: number, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : dflt);

function percentile(sorted: number[], p: number): number | null {
	if (!sorted.length) return null;
	if (sorted.length === 1) return sorted[0];
	const idx = (sorted.length - 1) * p;
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo];
	return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

/** 聚合一次 run 的当前快照（running 时也能给进度）。 */
export function snapshot(state: RunState): FastBenchmarkResult {
	const { input, trials } = state;
	const warmup = clampInt(input.warmup, 0, 10, 1);
	const maxTrials = clampInt(input.maxTrials, 1, 50, 8);
	const budget = typeof input.responseBudgetMs === "number" && Number.isFinite(input.responseBudgetMs) ? Math.max(100, input.responseBudgetMs) : 1000;
	const p95Min = clampInt(input.p95MinSamples, 2, 200, 20);
	const measured = trials.filter((t) => !t.warmup);
	const lat = measured.map((t) => t.latencyMs).sort((a, b) => a - b);
	const timeouts = measured.filter((t) => t.metrics.timeout).length;
	const errors = measured.filter((t) => t.metrics.error && !t.metrics.timeout).length;
	const success = measured.filter((t) => !t.metrics.error && !t.metrics.timeout && t.metrics.correctness === "correct").length;
	const correctTrials = measured.filter((t) => t.metrics.correctness === "correct").length;
	const total = measured.length;
	return {
		id: state.input.id ?? "",
		status: state.status,
		provider: input.provider,
		model: input.model,
		modelVersion: input.modelVersion || "unknown",
		target: { prefix: input.window.prefix, fixtureId: input.window.fixtureId },
		startedAt: iso(state.startedAt),
		finishedAt: state.finishedAt ? iso(state.finishedAt) : null,
		warmup,
		samples: total,
		coldStartMs: state.coldStartMs,
		p50Ms: total >= 2 ? percentile(lat, 0.5) : null,
		p95Ms: total >= 2 ? percentile(lat, 0.95) : null,
		p95Approx: total > 0 && total < p95Min,
		timeouts,
		errors,
		successRatio: total ? success / total : 0,
		actions: sum(measured, (t) => t.metrics.actions),
		retries: sum(measured, (t) => t.metrics.retries),
		fallbackCount: sum(measured, (t) => t.metrics.fallbackCount),
		abstains: measured.filter((t) => t.metrics.abstain).length,
		correctness: total ? correctTrials / total : null,
		correctTrials,
		note: noteFor(total, state.coldStartMs, p95Min, maxTrials),
		advisory: advisoryFor({ status: state.status, reason: state.reason, total, budget, p50: total >= 2 ? percentile(lat, 0.5) : null, successRatio: total ? success / total : 0, errors, timeouts, fallbackCount: sum(measured, (t) => t.metrics.fallbackCount) }),
		reason: state.reason,
		createdAt: iso(state.finishedAt ?? state.startedAt),
	};
}

const sum = <T>(arr: T[], f: (x: T) => number) => arr.reduce((a, x) => a + f(x), 0);

function noteFor(samples: number, coldStartMs: number | null, p95Min: number, maxTrials: number): string {
	const parts = ["真实受控 CUA 操控；模型推理时延仅诊断子项，不作为推荐唯一依据", "type 由程序固定输入，不计入模型 typing 能力", "本轮 bench task 正确率不等于泛化 accuracy"];
	if (coldStartMs !== null) parts.push("冷启动为单独一次，未混入 p50/p95");
	if (samples === 0) parts.push("尚无有效样本");
	else if (samples < p95Min) parts.push(`样本仅 ${samples} 条（< ${p95Min}），p95 为粗略值，场景结论有限`);
	if (maxTrials > 0) parts.push(`本轮预算最多 ${maxTrials} 条非预热试次`);
	return parts.join("；");
}

function advisoryFor(o: { status: BenchmarkStatus; reason: string | null; total: number; budget: number; p50: number | null; successRatio: number; errors: number; timeouts: number; fallbackCount: number }): FastBenchmarkAdvisory {
	if (o.status === "blocked") return { verdict: "blocked", recommended: false, message: "没能完成真实操控测试，无法给出速度建议", reason: o.reason ?? "环境未就绪" };
	if (o.status === "cancelled") return { verdict: "blocked", recommended: false, message: "测试已取消，结果不完整", reason: "用户取消" };
	if (o.total === 0) return { verdict: "blocked", recommended: false, message: "没有有效样本，先确认测试窗口与模型都可用", reason: "无有效样本" };
	if (o.successRatio < 0.6 || o.errors >= 3) return { verdict: "unstable", recommended: false, message: "当前快速操作不稳定，建议排查（窗口/模型/权限），但可继续使用", reason: `成功率 ${Math.round(o.successRatio * 100)}%、错误 ${o.errors} 次` };
	if (o.p50 !== null && o.p50 > o.budget) return { verdict: "slow", recommended: true, message: "当前测试较慢，建议改用主模型/云端（仍可继续使用快速操作）", reason: `p50 ${o.p50}ms > 预算 ${o.budget}ms` };
	return { verdict: "ok", recommended: false, message: "速度与稳定性在预算内，可继续使用", reason: "达标" };
}

/** 启动一次基准（立即返回快照，后台执行）。真实执行器由调用方注入。 */
export function startBenchmark(input: BenchmarkRunInput, deps: BenchmarkDeps): FastBenchmarkResult {
	if (!input.tasks.length) throw new Error("没有测试任务");
	if (!input.provider || !input.model) throw new Error("需要先选定快速操作模型（provider/model）");
	const controller = new AbortController();
	const external = input.signal;
	if (external) {
		if (external.aborted) controller.abort();
		else external.addEventListener("abort", () => controller.abort(), { once: true });
	}
	const state: RunState = {
		input,
		trials: [],
		status: "running",
		reason: null,
		coldStartMs: null,
		controller,
		startedAt: nowMs(deps)(),
		finishedAt: null,
		subscribers: new Set(),
	};
	const id = input.id || `bench-${++seq}-${state.startedAt.toString(36)}`;
	state.input = { ...input, id };
	runs.set(id, state);
	void runAll(state, deps).catch(() => {});
	return snapshot(state);
}

export function benchmarkStatus(id: string): FastBenchmarkResult | null {
	const s = runs.get(id);
	return s ? snapshot(s) : null;
}

export function listBenchmarks(): FastBenchmarkResult[] {
	return [...runs.values()].map(snapshot);
}

/** 订阅一次 run 的状态变化；返回取消订阅函数。 */
export function onBenchmarkUpdate(id: string, cb: (r: FastBenchmarkResult) => void): () => void {
	const s = runs.get(id);
	if (!s) return () => {};
	s.subscribers.add(cb);
	return () => s.subscribers.delete(cb);
}

/** 取消一次 run：中止在跑试次，状态置 cancelled，不再派发任何动作。 */
export function cancelBenchmark(id: string): boolean {
	const s = runs.get(id);
	if (!s || s.status !== "running") return false;
	s.controller.abort();
	s.status = "cancelled";
	s.reason = "用户取消";
	s.finishedAt = Date.now();
	publish(s);
	return true;
}

function publish(s: RunState) {
	const snap = snapshot(s);
	for (const cb of s.subscribers) {
		try {
			cb(snap);
		} catch {
			/* 订阅者异常不影响 run */
		}
	}
}

/** 仅供测试：清空所有 run 状态。 */
export function _resetBenchmarks() {
	runs.clear();
	seq = 0;
}

async function runAll(state: RunState, deps: BenchmarkDeps) {
	const { input } = state;
	const now = nowMs(deps);
	const warmup = clampInt(input.warmup, 0, 10, 1);
	const maxTrials = clampInt(input.maxTrials, 1, 50, 8);
	const concurrency = clampInt(input.concurrency, 1, 4, 1);
	const failCap = clampInt(input.failCap, 1, 20, 3);

	// 试次队列：先 warmup 条，再 maxTrials 条；任务在给定集合内循环取。
	const plan: { task: FastBenchmarkTask; warmup: boolean; coldStart: boolean }[] = [];
	const total = warmup + maxTrials;
	for (let i = 0; i < total; i++) {
		const task = input.tasks[i % input.tasks.length];
		plan.push({ task, warmup: i < warmup, coldStart: i === 0 });
	}

	let cursor = 0;
	let consecutiveErrors = 0;
	let aborted = false;

	const worker = async () => {
		while (!aborted) {
			if (state.controller.signal.aborted) return;
			const index = cursor++;
			if (index >= plan.length) return;
			const item = plan[index];
			const started = now();
			let metrics: TrialMetrics;
			try {
				metrics = await deps.runTrial(item.task, { trialIndex: index, coldStart: item.coldStart, signal: state.controller.signal });
			} catch (e) {
				if (e instanceof WindowIdentityError) {
					aborted = true;
					state.status = "blocked";
					state.reason = e.reason;
					return;
				}
				if (state.controller.signal.aborted) return;
				metrics = { correctness: "unknown", error: e instanceof Error ? e.message : String(e), actions: 0, retries: 0, fallbackCount: 0, abstain: false };
			}
			const latencyMs = Math.max(0, now() - started);
			state.trials.push({ taskId: item.task.id, metrics, latencyMs, coldStart: item.coldStart, warmup: item.warmup });
			if (item.coldStart) state.coldStartMs = latencyMs;
			if (metrics.error && !metrics.timeout) consecutiveErrors++;
			else consecutiveErrors = 0;
			if (consecutiveErrors >= failCap) {
				aborted = true;
				state.status = "failed";
				state.reason = `连续 ${consecutiveErrors} 次执行错误，已中止`;
			}
			publish(state);
			if (aborted) return;
		}
	};

	try {
		await Promise.all(Array.from({ length: concurrency }, () => worker()));
	} finally {
		if (state.status === "running") state.status = "done";
		state.finishedAt = now();
		publish(state);
	}
}

// ---------------------------------------------------------------- 执行前契约（供 UI / runtime 协作）

/** 基准是否可以在当前环境下真实运行——由 runtime/registry 提供；任一不满足都必须明确 blocked，不 mock 冒充 real。 */
export interface BenchmarkAvailability {
	/** 真实 CUA 通道是否可用（hostpc 已开且授权 / 助理电脑就绪） */
	cuaReady: boolean;
	/** 是否已选定 classifier / 快速模型（provider + model） */
	modelReady: boolean;
	/** fixture 测试窗口是否已就绪（由应用提供的 sandbox 本地 fixture） */
	fixtureReady: boolean;
	/** 不满足时的中文原因（供 UI 显示，不隐藏） */
	reasons: string[];
}
