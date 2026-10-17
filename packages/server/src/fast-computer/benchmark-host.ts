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
import { clickCandidatesFromBrowserRefs, clickCandidatesFromWindowState, buildChooser, type FastTarget } from "./tool.ts";
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
	/** 驱动自有浏览器 fixture：由 `get_browser_state` 绑定铸的会话级浏览器能力（页面观察/动作走它，不走原生 AX）。 */
	targetId?: string;
	tabId?: string;
}

/**
 * 目标电脑驱动：真实实现经统一 computer backend（cua MCP / 浏览器 CDP）调用；
 * 测试注入假实现（模拟真 driver 调用序列），源码仍是真路径。
 */
export interface BenchmarkDriver {
	/** 用户显式选择的目标电脑；未授权 / 未启动返回 null（附原因）。传入 requested 表示用户点名要哪台。 */
	target(requested?: "hostpc" | "computer"): { prefix: "hostpc" | "computer"; session?: string } | null;
	/** 这台平台是否能拿到**独立受控 fixture 窗口**的证明；拿不到就必须 false（fail-closed，不假装 ready）。默认 fail-closed。
	 *  传 requested 表示按用户点名的那台电脑判定（不传按当前默认目标）。 */
	capable?(requested?: "hostpc" | "computer"): { ok: boolean; reason?: string };
	/** 该目标用哪种隔离窗口来源（元数据，供 UI 显示；不自动开窗）。 */
	windowKind?(prefix: "hostpc" | "computer"): "driver-isolated-browser" | "sandbox-app" | null;
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

/** 一次基准评估的输入：显式点名的 provider/model（点哪条测哪条）+ 目标电脑。 */
export interface BenchmarkTargetInput {
	provider?: string;
	model?: string;
	target?: "hostpc" | "computer";
}

export interface BenchmarkStartInput extends BenchmarkTargetInput {
	maxTrials?: number;
	warmup?: number;
}

/**
 * 解析某个 provider/model 是否**真的**能跑：已注册进分类器目录且凭据可用。
 * 不能只看前端传的字符串或全局「已选定」。返回 startable 表示可按既有流程启动（本地 Laya 已装未运行）。
 */
export type BenchmarkModelResolver = (provider: string, model: string) => { ok: boolean; reason?: string; startable?: boolean };

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
	/** 按具体 provider/model 校验真实可用性；不提供时只认该目标电脑的快速操作设置里的选中项。 */
	resolveModel?: BenchmarkModelResolver;
}

export interface BenchmarkHost {
	availability(input?: BenchmarkTargetInput): BenchmarkAvailability;
	start(input: BenchmarkStartInput): Promise<FastBenchmarkResult>;
}

const TERMINAL = new Set(["done", "cancelled", "blocked", "failed"]);

/** 构造真实运行的宿主。 */
export function createBenchmarkHost(opts: BenchmarkHostOptions): BenchmarkHost {
	let active: { id: string; fixtureId: string; nonce: string; close: () => Promise<void>; unsubscribe: () => void } | null = null;

	/**
	 * 解析要评估的模型。显式传入 provider/model 时**只评估这一对**（点哪条测哪条，不需要先改全局设置）；
	 * 否则回落到该目标电脑自己的快速操作设置（`fastComputer:<scope>`），再回落到旧全局设置。
	 */
	const resolveRequestedModel = (input?: BenchmarkTargetInput): { model: { provider: string; id: string } | null; reason?: string; startable?: boolean } => {
		const requested = input?.provider && input?.model ? { provider: input.provider, id: input.model } : null;
		if (requested) {
			if (opts.resolveModel) {
				const r = opts.resolveModel(requested.provider, requested.id);
				return r.ok ? { model: requested } : { model: null, reason: r.reason ?? `快速模型 ${requested.provider}/${requested.id} 当前不可用。`, startable: !!r.startable };
			}
			// 没有注入解析器（测试 / 内部）：只认「这台电脑的快速操作设置就是它」，不凭字符串假装 ready。
			const s = fastComputerSettings(input?.target);
			if (s.enabled && s.provider === requested.provider && s.id === requested.id) return { model: requested };
			return { model: null, reason: `快速模型 ${requested.provider}/${requested.id} 当前不可用。` };
		}
		const s = fastComputerSettings(input?.target);
		if (!s.enabled || !s.provider || !s.id) return { model: null, reason: "还没选定快速操作模型（设置 › 电脑 › 快速操作模型）。" };
		if (opts.resolveModel) {
			const r = opts.resolveModel(s.provider, s.id);
			return r.ok ? { model: { provider: s.provider, id: s.id } } : { model: null, reason: r.reason ?? `快速模型 ${s.provider}/${s.id} 当前不可用。`, startable: !!r.startable };
		}
		return { model: { provider: s.provider, id: s.id } };
	};

	const availability = (input?: BenchmarkTargetInput): BenchmarkAvailability => {
		const reasons: string[] = [];
		const targetSel = opts.driver.target(input?.target);
		if (!targetSel) reasons.push(opts.notReadyReason ?? "没有可用的真实电脑通道：请先在设置 › 电脑里开启「操作这台电脑」，或启动助理电脑。");
		const capable = opts.driver.capable?.(input?.target) ?? { ok: false, reason: "未提供目标电脑能力探测（fail-closed）" };
		if (targetSel && !capable.ok) reasons.push(capable.reason ?? "当前平台无法为基准测试取得独立受控窗口（fail-closed）。");
		const resolved = resolveRequestedModel(input);
		if (!resolved.model && resolved.reason) reasons.push(resolved.reason);
		const kind = targetSel ? (opts.driver.windowKind?.(targetSel.prefix) ?? null) : null;
		return {
			cuaReady: !!targetSel && capable.ok,
			modelReady: !!resolved.model,
			fixtureReady: !!targetSel && capable.ok,
			reasons,
			// 元数据：只有点了「开始实际操作测试」才会真正开窗（POST bootstrap）；GET 这里不开任何窗口。
			preparable: !!targetSel && capable.ok,
			model: resolved.model,
			...(resolved.startable ? { modelStartable: true } : {}),
			...(kind ? { targetKind: kind } : {}),
		};
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

	const start = async (input: BenchmarkStartInput): Promise<FastBenchmarkResult> => {
		if ((input.provider && !input.model) || (!input.provider && input.model)) throw new Error("provider 和 model 必须同时指定。");
		// 用本次请求的 provider/model/target 评估，而不是全局设置：点哪条就测哪条。
		const avail = availability(input);
		if (!avail.cuaReady || !avail.modelReady || !avail.fixtureReady) throw new Error(avail.reasons.join(" "));
		if (active) throw new Error("已有一次真实操控测试在运行，请等它结束或先取消。");

		const settings = fastComputerSettings(input.target);
		const provider = avail.model!.provider;
		const model = avail.model!.id;

		const targetSel = opts.driver.target(input.target)!;
		const fixtureId = `bench-${randomToken(6)}`;
		const nonce = randomToken(10);
		// run token：页面上报机器状态时必须带（连同 nonce），杜绝别的页面 / 别的 run 伪造上报。
		const token = randomToken(24);
		opts.store.arm(fixtureId, nonce, token);

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
		const browserTarget = handle.targetId && handle.tabId ? { target_id: handle.targetId, tab_id: handle.tabId, ...(handle.session ? { session: handle.session } : {}) } : null;
		const window: BenchmarkWindow = { prefix: handle.prefix, pid: handle.pid, windowId: handle.windowId, session: handle.session, windowToken: handle.windowToken, fixtureId };

		const chooser = (opts.chooserFor ?? buildChooser)(settings);
		if (!chooser) {
			opts.store.disarm(fixtureId, nonce);
			await opened.close().catch(() => {});
			throw new Error("没有可用的快速模型选择器（请检查快速操作模型设置）。");
		}

		const collect = (structured: unknown) =>
			browserTarget ? clickCandidatesFromBrowserRefs(prefixTool, browserTarget, structured) : clickCandidatesFromWindowState(prefixTool, fastTarget, structured);

		const runner = createCuaTrialRunner(window, {
			readWindow: () => opts.driver.readWindow(handle),
			observe: () => opts.driver.observe(handle),
			collectCandidates: collect,
			choose: (goal, candidates, signal) => selectFastAction({ key: `${handle.prefix}:${handle.pid}:${handle.windowId}`, goal, candidates, chooser, settings, signal }),
			execute: (tool, args, signal) => opts.driver.execute(handle, tool, args, signal),
			// 下拉选项是**程序侧固定输入**（不计入模型的点击/输入能力）：模型只负责点开下拉，
			// 展开后由这里按任务声明的目标值点选项，再交给双证据判分。
			afterSelect: async (task, _selected, signal) => {
				const want = task.expect?.machine?.selected;
				if (typeof want !== "string" || !want) return;
				const observed = await opts.driver.observe(handle);
				if (!observed.ok) return;
				const option = collect(observed.structured).find((c) => c.label.includes(want));
				if (!option) return;
				await opts.driver.execute(handle, option.tool, option.args, signal);
			},
			readMachineState: async () => opts.store.getEvidence(fixtureId, nonce),
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
