/**
 * 快速执行者：`computer_quick_steps` / `hostpc_quick_steps` 工具 + 执行循环。
 *
 * 大模型一次写好几步（`{do, what, value}`），这里自己循环：读一次页面结构 → 列候选 → 问决策模型挑一个
 * （`ctx.modelRegistry.classify`）→ 用 cua 执行（`ctx.executeTool`，照常走 tool_call 闸门的档位 / 受保护动作 /
 * 敏感动作审批）→ 再读一次核对。**要填的值只来自大模型写的 `value`**，决策模型只挑元素编号。
 * 纯逻辑（解析、过滤排序、问题、判断、拼调用、核对）在 quick-steps.ts；设计见 docs/design/fast-executor-impl.md。
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { observe as observePage, sleep, textOf, type ExecContext } from "./quick-io.ts";
import { buildCall, buildClassifierContext, decide, describeStep, emptyObservation, exactMatch, filterByKind, MAX_STEPS, rankCandidates, summarize, verifyStep, type Candidate, type Observation, type QuickStep, type QuickTarget, type StepResult, type StopInfo } from "./quick-steps.ts";
import { registerQuickOpen } from "./quick-open.ts";
import { runGoal, type GoalContext } from "./quick-goal-run.ts";
import { DEFAULT_GOAL_STEPS, MAX_GOAL_STEPS, type GoalInput } from "./quick-goal.ts";
export * from "./quick-steps.ts";
export * from "./quick-open.ts";
export * from "./quick-goal.ts";
export * from "./quick-goal-run.ts";

/** 快速执行用的决策模型（每次执行时重新求值，设置改了下一条消息就生效） */
export interface QuickStepsConfig {
	provider: string;
	id: string;
	/** 允许把截图一起发给决策模型（模型不支持看图时自动不带） */
	images: boolean;
}
export interface QuickStepsOptions {
	/** cua 工具名前缀（`mcp__computer__` / `mcp__hostpc__`） */
	prefix: string;
	target: "sandbox" | "host";
	/** 是否支持网页目标（助理电脑的网页走 ext-browser，cua 浏览器工具是隐藏的；“限定”档位也没有浏览器工具） */
	browser: boolean;
	/** 返回 null = 不提供这个工具 */
	config: () => QuickStepsConfig | null;
	/** 记住最近一次打开 / 操作的目标（quick_open 成功时调用） */
	remember?: (t: QuickTarget) => void;
}

/** 系统提示：让大模型知道什么时候该打开、一次交出去、还是走目标模式 */
export const quickStepsPrompt = (steps: string, open: string) => `<quick-steps>
电脑操作尽量少来回，每一轮都要好几秒：
1. 打开网页或应用用 ${open}；已经知道要做什么，就把 steps（或 goal + inputs）一起传给它，打开和做事一次完成。
2. 之后在同一个页面上接着做，用 ${steps}，target 可以省略（默认用最近打开 / 操作的那个）。
3. 结果里已经写了「新出现 / 变了的内容」和最后的页面内容，够用就直接回答，不要再读一遍、不要再截图核对。
4. 互不依赖的准备（比如先找文件路径）和打开放在同一轮里一起调用。
5. 要提交 / 发送 / 删除之类的，goal 或 steps 里要明确写出来；停下时按原因和元素列表用普通工具接着做，被拒绝的动作不要换方式重试。
每个动作照常按用户的权限档位审批。
</quick-steps>`;

/** 助理电脑上注册的工具名对应的提示词（host 上工具名不同，提示词要跟着换） */
export const QUICK_STEPS_PROMPT = quickStepsPrompt("computer_quick_steps", "computer_quick_open");

const STEP_KINDS = ["click", "type", "select", "check", "press", "upload"] as const;

/** `ctx.executeTool` 的结果类型见 quick-io.ts */
type StepOutcome = { ok: true; obs: Observation; result: StepResult } | { ok: false; reason: string; obs: Observation };
type AskResult = { candidate: Candidate; probability: number } | { reobserve: true } | { stop: string };

/** target 的形状校验：助理电脑 / 没有浏览器工具的档位只允许窗口 */
function targetError(t: QuickTarget | undefined, o: QuickStepsOptions): string | null {
	if (!t || typeof t !== "object") return "target 必须是 {kind:\"browser\",tab_id} 或 {kind:\"window\",pid,window_id}";
	if (t.kind === "browser") {
		if (!o.browser) return "这个目标不能直接操作网页：请用 get_window_state + {kind:\"window\"}，或者用普通浏览器工具";
		return t.tab_id ? null : "browser 目标要带 tab_id（先用 get_browser_state 拿到）";
	}
	if (t.kind === "window") return typeof t.pid === "number" && typeof t.window_id === "number" ? null : "window 目标要带 pid 和 window_id";
	return "target.kind 只能是 browser 或 window";
}

/** 快速执行 / 快速打开共用的执行参数（两个工具的 steps / goal / inputs / max_steps 完全一致） */
export const QUICK_ACTION_PARAMS = {
	steps: Type.Optional(
		Type.Array(
			Type.Object({
				do: Type.Union(STEP_KINDS.map((k) => Type.Literal(k))),
				what: Type.String({ description: "屏幕上看得到的名字，例如「名称」「提交」" }),
				value: Type.Optional(Type.String({ description: "要填 / 要选的内容（只有你写值）" })),
				files: Type.Optional(Type.Array(Type.String(), { description: "upload 要上传的文件（绝对路径）" })),
				key: Type.Optional(Type.String({ description: "press 要按的键，例如 return" })),
			}),
			{ minItems: 1, maxItems: MAX_STEPS, description: `按顺序做的 1–${MAX_STEPS} 步（和 goal 二选一）` },
		),
	),
	goal: Type.Optional(Type.String({ description: "要达到的结果，一句话，例如「把表单填好并提交」（和 steps 二选一）" })),
	inputs: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String({ description: "这个值是什么意思，例如「名称」「参考图片」" }),
				value: Type.Optional(Type.String({ description: "要填 / 要选的内容" })),
				files: Type.Optional(Type.Array(Type.String(), { description: "要上传的文件（绝对路径）" })),
			}),
			{ maxItems: 20, description: "目标模式要用的值（0–20 个）；值只能来自这里" },
		),
	),
	max_steps: Type.Optional(Type.Number({ description: `目标模式最多做多少步（默认 ${DEFAULT_GOAL_STEPS}，最多 ${MAX_GOAL_STEPS}）` })),
};

/** 快速执行 / 快速打开传给执行函数的参数 */
export interface QuickActionParams {
	steps?: QuickStep[];
	goal?: string;
	inputs?: GoalInput[];
	max_steps?: number;
}

/** 执行循环用到的上下文（Pi 的 executeTool + 决策模型） */
export interface QuickActionContext extends ExecContext {
	modelRegistry: {
		findOfType(type: string, provider: string, id: string): unknown;
		classify(model: unknown, context: never, opts?: { signal?: AbortSignal }): Promise<{ stopReason: string; answers: Record<string, unknown>; errorMessage?: string }>;
	};
}

/**
 * 快速执行 / 快速打开共用的执行主体：参数校验 → 挑元素 → cua 执行 → 核对 → 拼结果。
 * 两个工具都调这里，不复制循环代码。
 */
export async function runQuickAction(ctx: QuickActionContext, o: QuickStepsOptions, target: QuickTarget, params: QuickActionParams, signal: AbortSignal | undefined) {
	const cfg = o.config();
	if (!cfg) throw new Error("快速执行已关闭：在 设置 › 操作这台电脑 › 快速执行 里打开并选择决策模型。");
	const bad = targetError(target, o);
	if (bad) throw new Error(bad);
	const p = params;
	const steps = Array.isArray(p.steps) ? p.steps : [];
	const goal = typeof p.goal === "string" ? p.goal.trim() : "";
	if (!!steps.length === !!goal) throw new Error("steps 和 goal 必须恰好给一个：想好每一步用 steps，只知道目标用 goal + inputs。");
	if (steps.length > MAX_STEPS) throw new Error(`steps 最多 ${MAX_STEPS} 步`);
	if (goal) {
		const inputs = Array.isArray(p.inputs) ? p.inputs : [];
		if (inputs.length > 20) throw new Error("inputs 最多 20 个");
		inputs.forEach((x, i) => {
			if (!x?.name?.trim()) throw new Error(`第 ${i + 1} 个 input 缺少 name`);
			if (!x.value && !x.files?.length) throw new Error(`input「${x.name}」要有 value 或 files`);
		});
	}
	// 参数先全查一遍（用一个假候选），有错直接返回，不要做到一半才发现缺值
	if (steps.length) {
		const fake: Candidate = { id: "c1", handle: target.kind === "browser" ? "p1:1" : "s0:1", role: "button", name: "x" };
		steps.forEach((s, i) => {
			const c = buildCall(s, fake, target, o.prefix);
			if ("error" in c) throw new Error(`第 ${i + 1} 步：${c.error}`);
		});
	}
	const found = ctx.modelRegistry.findOfType("classifier", cfg.provider, cfg.id) as { input?: string[] } | undefined;
	if (!found) throw new Error(`决策模型不可用（${cfg.provider}/${cfg.id}）：请在 设置 › 操作这台电脑 › 快速执行 里重新选一个。`);
	const model = found;
	const imageOk = cfg.images && (model.input ?? []).includes("image");
	if (goal) return runGoal(ctx as unknown as GoalContext, o, target, { goal, inputs: Array.isArray(p.inputs) ? p.inputs : [], max_steps: p.max_steps }, model, imageOk, signal);

	/** 读一次页面结构（shot = 带截图）；读失败返回原因字符串 */
	const observe = (shot: boolean) => observePage(ctx, target, o.prefix, signal, shot);
	const results: StepResult[] = [];
	const done: string[] = [];
	let firstObs: Observation | null = null;
	/** 问决策模型挑元素；带图失败时去掉图再问一次 */
	const ask = async (i: number, step: QuickStep, list: Candidate[], obs: Observation, reobserved: boolean): Promise<AskResult> => {
		const withImage = imageOk && !!obs.screenshot;
		let res = await ctx.modelRegistry.classify(model, buildClassifierContext(step, i, steps.length, done, obs, list, withImage) as never, { signal });
		if (res.stopReason === "error" && withImage) res = await ctx.modelRegistry.classify(model, buildClassifierContext(step, i, steps.length, done, obs, list, false) as never, { signal });
		if (res.stopReason === "aborted") return { stop: "已中断" };
		if (res.stopReason === "error") return { stop: `决策模型出错：${res.errorMessage ?? "未知原因"}` };
		const d = decide(res.answers.pick, list, reobserved);
		if (d.kind === "pick") return { candidate: d.candidate, probability: d.probability };
		return d.kind === "reobserve" ? { reobserve: true } : { stop: d.reason };
	};
	/** 跑一步：挑元素 → 执行 → 核对；「重新读一次」最多一次 */
	const runStep = async (i: number, step: QuickStep, startObs: Observation | null): Promise<StepOutcome> => {
		let obs = startObs;
		let reobserved = false;
		let shotTried = false;
		const started = Date.now();
		for (;;) {
			if (!obs) {
				const r = await observe(shotTried ? false : imageOk);
				if (typeof r === "string") return { ok: false, reason: `读取页面失败：${r}`, obs: emptyObservation() };
				obs = r;
			}
			if (!firstObs) firstObs = obs;
			if (signal?.aborted) return { ok: false, reason: "已中断", obs };
			let picked: Candidate | null = null;
			let probability = 1;
			let exact = false;
			let call: { tool: string; args: Record<string, unknown> };
			if (step.do === "press") {
				// 按键不需要挑元素
				const c = buildCall(step, null, target, o.prefix);
				if ("error" in c) return { ok: false, reason: c.error, obs };
				call = c;
			} else {
				const list = rankCandidates(step.what, filterByKind(step.do, obs.candidates));
				if (!list.length) return { ok: false, reason: "页面上没有可操作的元素", obs };
				const hit = exactMatch(step.what, list);
				if (hit) {
					picked = hit;
					exact = true;
				} else {
					// 要问决策模型：这一步还没带图就重新读一次（只补一次）
					if (imageOk && !obs.screenshot && !shotTried) {
						shotTried = true;
						obs = null;
						continue;
					}
					const res = await ask(i, step, list, obs, reobserved);
					if ("stop" in res) return { ok: false, reason: res.stop, obs };
					if ("reobserve" in res) {
						if (reobserved) return { ok: false, reason: "页面一直没准备好", obs };
						reobserved = true;
						await sleep(800);
						obs = null;
						shotTried = false;
						continue;
					}
					picked = res.candidate;
					probability = res.probability;
				}
				const c = buildCall(step, picked, target, o.prefix);
				if ("error" in c) return { ok: false, reason: c.error, obs };
				call = c;
			}
			const out = await ctx.executeTool(call.tool, call.args, { signal });
			// 被审批拒绝 / 受保护动作没批准 / 暂停：原样告诉大模型，不许换方式重试
			if (out.isError) return { ok: false, reason: `${textOf(out).slice(0, 300) || "执行失败"}（不要换方式重试被拒绝的动作）`, obs };
			const first = await observe(false);
			if (typeof first === "string") return { ok: false, reason: `读取页面失败：${first}`, obs };
			let after = first;
			let v = verifyStep(step, picked, obs, after);
			// 点击类可能只是慢：多等一次再判
			if (!v.ok && step.do !== "type" && step.do !== "select") {
				await sleep(600);
				const second = await observe(false);
				if (typeof second !== "string") {
					after = second;
					v = verifyStep(step, picked, obs, after);
				}
			}
			if (!v.ok) return { ok: false, reason: v.reason, obs: after };
			return { ok: true, obs: after, result: { index: i, step, picked, probability, exact, note: v.note, ms: Date.now() - started } };
		}
	};

	let obs: Observation | null = null;
	let stopped: StopInfo | undefined;
	for (let i = 0; i < steps.length; i++) {
		const step = steps[i]!;
		if (signal?.aborted) {
			stopped = { index: i, reason: "已中断", obs: obs ?? emptyObservation() };
			break;
		}
		const r = await runStep(i, step, obs);
		obs = r.obs;
		if (!r.ok) {
			stopped = { index: i, reason: r.reason, obs: r.obs };
			break;
		}
		results.push(r.result);
		done.push(describeStep(step));
	}
	// 停下是正常交回（不是工具坏了），所以不设 isError
	return { content: [{ type: "text" as const, text: summarize(results, stopped, obs ?? undefined, firstObs ?? undefined) }], details: { steps: results, stopped: stopped ?? null } };
}

export function registerQuickSteps(pi: ExtensionAPI, o: QuickStepsOptions): void {
	// 注册时求值一次：没配决策模型就完全不提供这个工具
	if (!o.config()) return;
	/** 最近一次打开 / 操作的目标；quick_steps 的 target 可以省略 */
	let current: QuickTarget | null = null;
	const name = o.target === "host" ? "hostpc_quick_steps" : "computer_quick_steps";
	const openName = o.target === "host" ? "hostpc_quick_open" : "computer_quick_open";
	pi.on("before_agent_start", async (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${quickStepsPrompt(name, openName)}` }));
	pi.registerTool({
		name,
		label: "快速执行",
		description:
			"已经想好的连续几步（填表、选下拉、勾选、上传、逐个点按钮、按键）一次交出去：每步自己读页面结构、从真实存在的元素里挑一个、执行、再核对，比一步一步调普通工具快得多。\n" +
			"target 可以省略，默认用最近一次打开 / 操作的那个；要指定时，网页用 {kind:\"browser\", tab_id}（先用 get_browser_state 拿到 tab_id）；窗口用 {kind:\"window\", pid, window_id}。\n" +
			"steps[].do：click 点击 / type 填写 / select 选下拉 / check 勾选 / press 按键 / upload 上传文件。what 写屏幕上看得到的名字；type、select 必须给 value，press 必须给 key，upload 必须给 files——要填的内容只来自你写的 value，执行者不会自己编。\n" +
			"也可以改用 goal + inputs（和 steps 二选一）：goal 写要达到的结果，inputs 写要用的值；决策模型每一步从页面真实元素里挑一个动作，做到完成或拿不准就停下。\n" +
			"每个动作照常按用户的权限档位审批；被拒绝时在这一步停下，原样告诉你原因，不要换方式重试。停下时按返回的原因和元素列表用普通工具接着做；拿不准的一步、要看画面判断的一步、打开网址 / 切标签页用快速打开或普通工具。",
		promptSnippet: `${name}: 已经想好的连续几步（填表、选择、逐个点）一次交出去，快速执行`,
		// 它自己不碰外部：每个动作都经 ctx.executeTool 单独过审批。不声明的话通用审批（ext-approval）会把它当成可能有副作用的工具，多弹一张看不懂的卡
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		parameters: Type.Object({
			target: Type.Optional(
				o.target === "host" && o.browser
					? Type.Union([
							Type.Object({ kind: Type.Literal("browser"), tab_id: Type.String({ description: "get_browser_state 返回的 tab_id" }), target_id: Type.Optional(Type.String()), session: Type.Optional(Type.String()) }),
							Type.Object({ kind: Type.Literal("window"), pid: Type.Number(), window_id: Type.Number() }),
						])
					: Type.Object({ kind: Type.Literal("window"), pid: Type.Number(), window_id: Type.Number() }),
			),
			...QUICK_ACTION_PARAMS,
			stop_if: Type.Optional(Type.String({ description: "遇到什么情况就停下（写在返回说明里提醒自己）" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const p = params as QuickActionParams & { target?: QuickTarget };
			const target = p.target ?? current;
			if (!target) throw new Error(`没有当前目标：先用 ${openName} 打开，或传 target`);
			const bad = targetError(target, o);
			if (bad) throw new Error(bad);
			current = target;
			return runQuickAction(ctx as unknown as QuickActionContext, o, target, p, signal);
		},
	});
	// 打开工具和快速执行共用同一个配置判断（在上面已经确认不为 null）
	registerQuickOpen(pi, {
		...o,
		remember: (t) => {
			current = t;
			o.remember?.(t);
		},
	});
}
