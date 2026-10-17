/**
 * 快速操作模型 · 真实 CUA 试验执行器（生产接线）。
 *
 * 通过注入的电脑工具钩子（与 `fast_pick_action` 用的**同一套** ctx.executeTool / get_window_state）真实走：
 *   读窗口身份（fail-closed）→ 观察 → 收集候选人 → 快速模型选 → 执行前重读窗口身份 + 目标新鲜度 → 派发 → 双证据判分。
 *
 * 不变量：
 *  - 真实运行、**不允许 mock 冒充 real**：本模块只负责执行，测试注入的是假 CUA 依赖；
 *  - 快速模型只 click；type / 下拉固定输入由程序侧 `afterSelect` 完成，**不计入模型 typing 能力**；
 *  - 候选白名单只允许 `click`（其余一律 error，不派发）；
 *  - 每次派发前重新读窗口身份，token / pid / window / fixture 任一变化 → 抛 WindowIdentityError 中止整轮；
 *  - 判分只采信 `readMachineState` + 独立 UI 观测，绝不用模型自评。
 */
import type { FastActionCandidate } from "./types.ts";
import type { FastSelectResult, VerifyOutcome } from "./index.ts";
import { resolveFreshCandidate, verifyExpectation } from "./index.ts";
import { WindowIdentityError, validateTrial, windowIdentityMismatch, type BenchmarkTrialRunner, type BenchmarkWindow, type FastBenchmarkTask, type ObservedWindow, type TrialMetrics } from "./benchmark.ts";

/** 每次派发允许的模型动作（快速路径只点击）：原生窗口是 `click`，驱动自有浏览器 fixture 是 `browser_click`（同一语义，走 CDP 精确 ref）。 */
export const BENCHMARK_ALLOWED_TOOLS = ["click", "browser_click"] as const;
/** 等 fixture 上报本轮机器证据的上界与轮询间隔（页面 POST 是异步的，不等就会把成功误判成「证据不足」）。 */
export const MACHINE_EVIDENCE_WAIT_MS = 2500;
export const MACHINE_EVIDENCE_POLL_MS = 120;
/** 程序侧辅助动作（不计入模型操控能力）：目前只有按方向滚动。 */
export const BENCHMARK_PROGRAM_TOOLS = ["scroll"] as const;

const bareTool = (t: string) => t.replace(/^mcp__[a-z0-9_-]+__/, "");

export interface CuaBenchmarkDeps {
	/** 读取当前窗口身份（pid/window_id/session/token/fixture）；读不到返回 null。 */
	readWindow(): Promise<ObservedWindow | null>;
	/** 读取当前窗口状态（含 elements 与 element_token）。 */
	observe(): Promise<{ ok: true; structured: unknown } | { ok: false; error: string }>;
	/** 从窗口状态收集 click 候选（程序预构建，模型看不到 tool/args）。 */
	collectCandidates(structured: unknown): FastActionCandidate[];
	/** 快速模型选择（复用 selectFastAction / chooser 闭环）。 */
	choose(goal: string, candidates: FastActionCandidate[], signal: AbortSignal): Promise<FastSelectResult>;
	/** 派发一个动作（走既有电脑工具钩子，权限 / 审批 / 暂停原样生效）。失败时可带一行原因。 */
	execute(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ isError: boolean; error?: string }>;
	/** 程序侧固定输入（type / 选择项由程序完成，不计模型能力）；可选。 */
	afterSelect?(task: FastBenchmarkTask, selected: FastActionCandidate, signal: AbortSignal): Promise<void>;
	/** fixture 页面的机器状态 reporter（独立证据 1）：状态 + 最后上报时间（freshness）。 */
	readMachineState(task: FastBenchmarkTask): Promise<{ state: unknown; updatedAt: number | null }>;
}

/** 构造真实 CUA 试验执行器，强限定到给定 window。 */
export function createCuaTrialRunner(window: BenchmarkWindow, deps: CuaBenchmarkDeps): BenchmarkTrialRunner {
	return async (task, ctx) => {
		const trialStartedAt = Date.now();
		let actions = 0;
		let programAssists = 0;
		let retries = 0;
		let fallbackCount = 0;
		let abstain = false;
		const steps = Math.max(1, Math.min(20, task.steps ?? 1));

		// 程序侧辅助（不计模型能力）：第一轮观察前，用正式 backend 的 scroll 工具按方向滚动，
		// 不写 DOM 脚本、不给坐标、不透露 groundtruth；模型仍只在屏幕上出现的候选里 click。
		if (task.programAssist?.scroll && !ctx.signal.aborted) {
			const assist = task.programAssist.scroll;
			const mismatch = windowIdentityMismatch(window, await deps.readWindow());
			if (mismatch) throw new WindowIdentityError(mismatch);
			const out = await deps.execute("scroll", { pid: window.pid, window_id: window.windowId, ...(window.session ? { session: window.session } : {}), direction: assist.direction, ...(assist.amount ? { amount: assist.amount } : {}) }, ctx.signal);
			programAssists++;
			if (out.isError) return { correctness: "unknown", error: "程序侧滚动执行失败", actions, programAssists, retries, fallbackCount, abstain };
		}

		for (let step = 0; step < steps; step++) {
			if (ctx.signal.aborted) break;
			// 1) fail-closed：每次动作前重新确认精确窗口身份
			const mismatch = windowIdentityMismatch(window, await deps.readWindow());
			if (mismatch) throw new WindowIdentityError(mismatch);

			// 2) 观察
			const observed = await deps.observe();
			if ("error" in observed) return { correctness: "unknown", error: `观察失败：${observed.error}`, actions, programAssists, retries, fallbackCount, abstain };

			// 3) 收集候选（模型只看 id/label）
			const candidates = deps.collectCandidates(observed.structured);
			if (!candidates.length) return { correctness: "unknown", error: "没有可点击候选", actions, programAssists, retries, fallbackCount, abstain };

			// 4) 快速模型选择（abstain / fallback / error 都记诊断，不派发）
			let result: FastSelectResult;
			try {
				result = await deps.choose(task.goal, candidates, ctx.signal);
			} catch (e) {
				if (ctx.signal.aborted) break;
				result = { kind: "fallback", reason: "model_error", detail: e instanceof Error ? e.message : String(e) };
			}
			if (result.kind === "disabled") return { correctness: "unknown", error: "快速操作模型未开启", actions, programAssists, retries, fallbackCount, abstain };
			if (result.kind === "fallback") {
				// 基准只测快速路径本身：这里不真的执行主模型回退，因此 fallbackCount 保持 0
				// （「未选中」只记进 retries / abstain 诊断），绝不把没发生的回退计成真实回退次数。
				if (result.reason === "abstain") abstain = true;
				else retries++;
				return { correctness: "unknown", error: `快速路径未选中（${result.reason}）`, actions, programAssists, retries, fallbackCount, abstain };
			}

			// 5) 候选白名单：只允许 click（type / 下拉由程序固定输入，不冒充模型能力）
			if (!BENCHMARK_ALLOWED_TOOLS.includes(bareTool(result.candidate.tool) as (typeof BENCHMARK_ALLOWED_TOOLS)[number])) {
				return { correctness: "unknown", error: `候选动作不在基准白名单：${result.candidate.tool}`, actions, programAssists, retries, fallbackCount, abstain };
			}

			// 6) 执行前用**新一次**观察重校验语义目标唯一且未变，再用新 element_token 派发。
			//    不能用模型选择前的快照：模型推理期间页面可能已变（之前把它当「新快照」是错的）。
			//    新快照会作废旧 ref，所以身份复核（readWindow）复用这次观察的 pin，不再额外取快照。
			const freshObserved = await deps.observe();
			if ("error" in freshObserved) {
				retries++;
				return { correctness: "unknown", error: `执行前重读窗口状态失败：${freshObserved.error}`, actions, programAssists, retries, fallbackCount, abstain };
			}
			const fresh = resolveFreshCandidate(result.candidate, freshObserved.structured);
			if (!fresh.ok) {
				retries++;
				return { correctness: "unknown", error: `目标已变化（${fresh.reason}）`, actions, programAssists, retries, fallbackCount, abstain };
			}
			// 7) 再次 fail-closed 确认窗口身份后才真正派发
			const mismatch2 = windowIdentityMismatch(window, await deps.readWindow());
			if (mismatch2) throw new WindowIdentityError(mismatch2);
			const out = await deps.execute(fresh.candidate.tool, fresh.candidate.args, ctx.signal);
			actions++;
			if (out.isError) {
				// 诊断用：默认不打；PIA_BENCH_DEBUG=1 时把驱动返回的一行原因写进服务日志（不含凭据 / token）。
				if (process.env.PIA_BENCH_DEBUG === "1") console.warn(`[benchmark] 动作失败 ${fresh.candidate.tool}: ${String((out as { error?: string }).error ?? "").slice(0, 300)}`);
				retries++;
				return { correctness: "unknown", error: "执行返回错误", actions, programAssists, retries, fallbackCount, abstain };
			}
			if (deps.afterSelect) await deps.afterSelect(task, fresh.candidate, ctx.signal);
		}

		// 8) 双证据判分：机器状态 + 独立 UI 观测，模型自评不参与；机器状态还要求 fresh（本轮动作之后写）。
		//    页面上报是异步 fetch：动作返回不代表 POST 已到，所以**有界等待**本轮新证据（不是无界轮询，也不伪造）。
		const evidenceDeadline = Date.now() + MACHINE_EVIDENCE_WAIT_MS;
		let machine = await deps.readMachineState(task);
		while (
			(machine.updatedAt === null || machine.updatedAt === undefined || machine.updatedAt < trialStartedAt) &&
			!ctx.signal.aborted &&
			Date.now() < evidenceDeadline
		) {
			await new Promise((r) => setTimeout(r, MACHINE_EVIDENCE_POLL_MS));
			machine = await deps.readMachineState(task);
		}
		const uiObserved = await deps.observe();
		const ui = "error" in uiObserved ? null : uiObserved.structured;
		const judged = validateTrial({ expect: task.expect, machine: machine.state, machineUpdatedAt: machine.updatedAt, machineFreshAfter: trialStartedAt, ui, verifyUi: (expected, state): VerifyOutcome => verifyExpectation(expected as never, state) });
		return { correctness: judged.outcome, actions, programAssists, retries, fallbackCount, abstain, error: judged.outcome === "correct" ? undefined : judged.reason };
	};
}
