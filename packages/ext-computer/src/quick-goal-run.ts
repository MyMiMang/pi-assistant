/**
 * 目标模式（quick_steps 的 goal + inputs）的执行循环：
 * 读页面 → 列候选动作 → 问决策模型挑下一步 → cua 执行 → 核对，直到完成 / 停下 / 步数用完。
 * 纯逻辑（候选、剪枝、问题、动作转步骤）在 quick-goal.ts；设计见 docs/design/fast-executor-v2-impl.md §5.6。
 */
import { buildCall, MIN_PROBABILITY, verifyStep, type Observation, type QuickTarget } from "./quick-steps.ts";
import { DEFAULT_GOAL_STEPS, MAX_GOAL_STEPS, actionToStep, buildGoalContext, goalActions, type GoalInput } from "./quick-goal.ts";
import { observe as observePage, sleep, textOf, type ExecContext } from "./quick-io.ts";
import type { QuickStepsOptions } from "./quick-steps-tool.ts";

export interface GoalParams {
	goal: string;
	inputs: GoalInput[];
	max_steps?: number;
}
/** 只用到 classify 的上下文（Pi 的 modelRegistry 形状） */
export interface GoalContext extends ExecContext {
	modelRegistry: {
		classify(model: unknown, context: never, opts?: { signal?: AbortSignal }): Promise<{ stopReason: string; answers: Record<string, unknown>; errorMessage?: string }>;
	};
}
interface GoalAnswer {
	type?: string;
	choice?: string;
	probabilities?: Record<string, number>;
	confidence?: number;
}

export async function runGoal(ctx: GoalContext, o: QuickStepsOptions, target: QuickTarget, params: GoalParams, model: unknown, imageOk: boolean, signal: AbortSignal | undefined) {
	const inputs = params.inputs;
	const maxSteps = Math.min(Math.max(params.max_steps ?? DEFAULT_GOAL_STEPS, 1), MAX_GOAL_STEPS);
	const pending = new Set(inputs.map((_, i) => i));
	const done: string[] = [];
	const seen = new Map<string, number>();
	const rows: { step: number; kind: string; desc: string; probability: number; note: string; ms: number }[] = [];
	const lines: string[] = [];
	const read = (shot: boolean) => observePage(ctx, target, o.prefix, signal, shot);
	let obs: Observation | null = null;
	let stopped: string | undefined;
	let finished = false;
	let reobserveStreak = 0;

	for (let step = 1; step <= maxSteps; step++) {
		if (signal?.aborted) {
			stopped = "已中断";
			break;
		}
		// 需要截图时这一轮重新带图读一次（上一轮核对读的是不带图的）
		if (!obs || (imageOk && !obs.screenshot)) {
			const r = await read(imageOk);
			if (typeof r === "string") {
				stopped = `读取页面失败：${r}`;
				break;
			}
			obs = r;
		}
		const n = (seen.get(obs.fingerprint) ?? 0) + 1;
		seen.set(obs.fingerprint, n);
		if (n > 3) {
			stopped = "页面一直没变化，可能卡住了";
			break;
		}
		const actions = goalActions(obs, inputs, pending, params.goal);
		const withImage = imageOk && !!obs.screenshot;
		let res = await ctx.modelRegistry.classify(model, buildGoalContext(params.goal, inputs, pending, done, obs, actions, withImage) as never, { signal });
		// 带图出错 → 去掉图再问一次
		if (res.stopReason === "error" && withImage) res = await ctx.modelRegistry.classify(model, buildGoalContext(params.goal, inputs, pending, done, obs, actions, false) as never, { signal });
		if (res.stopReason === "aborted") {
			stopped = "已中断";
			break;
		}
		if (res.stopReason === "error") {
			stopped = `决策模型出错：${res.errorMessage ?? "未知原因"}`;
			break;
		}
		const ans = res.answers.next as GoalAnswer | undefined;
		const a = actions.find((x) => x.id === ans?.choice);
		if (!a) {
			stopped = `决策模型选了不存在的动作（${ans?.choice ?? "无"}）`;
			break;
		}
		const raw = ans?.probabilities?.[a.id] ?? ans?.confidence ?? 0;
		const p = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
		if (a.kind === "abstain") {
			stopped = "决策模型拿不准";
			break;
		}
		if (p < MIN_PROBABILITY) {
			const probs = ans?.probabilities ?? {};
			const top = actions
				.map((x) => ({ x, p: typeof probs[x.id] === "number" ? probs[x.id]! : 0 }))
				.sort((m, m2) => m2.p - m.p)
				.slice(0, 3)
				.map((m) => `${m.p.toFixed(2)} ${m.x.desc}`);
			stopped = `决策模型把握不够（${p.toFixed(2)}）${top.length ? `，最可能的：${top.join("、")}` : ""}`;
			break;
		}
		if (a.kind === "reobserve") {
			reobserveStreak++;
			if (reobserveStreak >= 2) {
				stopped = "页面一直没准备好";
				break;
			}
			await sleep(800);
			const r = await read(imageOk);
			if (typeof r === "string") {
				stopped = `读取页面失败：${r}`;
				break;
			}
			obs = r;
			continue;
		}
		reobserveStreak = 0;
		const started = Date.now();
		if (a.kind === "finish") {
			finished = true;
			break;
		}
		if (a.kind === "scroll") {
			const call =
				target.kind === "browser"
					? {
							tool: `${o.prefix}browser_pointer`,
							args: { ...(target.target_id ? { target_id: target.target_id } : {}), tab_id: target.tab_id, ...(target.session ? { session: target.session } : {}), action: "scroll", delta_y: 600 },
						}
					: { tool: `${o.prefix}scroll`, args: { pid: target.pid, window_id: target.window_id, direction: "down", by: "page" } };
			const out = await ctx.executeTool(call.tool, call.args, { signal });
			if (out.isError) {
				stopped = `${textOf(out).slice(0, 300) || "执行失败"}（不要换方式重试被拒绝的动作）`;
				break;
			}
			done.push("往下滚动");
			lines.push(`第 ${step} 步：${a.desc}，已完成，${Date.now() - started} 毫秒`);
			const r = await read(imageOk);
			if (typeof r === "string") {
				stopped = `读取页面失败：${r}`;
				break;
			}
			obs = r;
			continue;
		}
		const one = actionToStep(a, inputs);
		if (!one) {
			stopped = `这个动作没有可执行的内容：${a.desc}`;
			break;
		}
		const call = buildCall(one, a.candidate ?? null, target, o.prefix);
		if ("error" in call) {
			stopped = call.error;
			break;
		}
		const out = await ctx.executeTool(call.tool, call.args, { signal });
		if (out.isError) {
			stopped = `${textOf(out).slice(0, 300) || "执行失败"}（不要换方式重试被拒绝的动作）`;
			break;
		}
		const first = await read(false);
		if (typeof first === "string") {
			stopped = `读取页面失败：${first}`;
			break;
		}
		let after = first;
		let v = verifyStep(one, a.candidate ?? null, obs, after);
		// 点击 / 勾选可能只是慢：多等一次再判
		if (!v.ok && (a.kind === "click" || a.kind === "check")) {
			await sleep(600);
			const second = await read(false);
			if (typeof second !== "string") {
				after = second;
				v = verifyStep(one, a.candidate ?? null, obs, after);
			}
		}
		if (!v.ok) {
			stopped = v.reason;
			break;
		}
		if (a.kind === "fill" || a.kind === "select" || a.kind === "upload") pending.delete(a.input!);
		done.push(a.desc);
		const ms = Date.now() - started;
		lines.push(`第 ${step} 步：${a.desc}，概率 ${p.toFixed(2)}，${v.note}，${ms} 毫秒`);
		rows.push({ step, kind: a.kind, desc: a.desc, probability: p, note: v.note, ms });
		obs = after;
	}
	if (!finished && !stopped) stopped = "步数用完了";

	lines.push(finished ? "成功：决策模型认为目标已完成，请你核对下面的页面内容。" : `停下：${stopped}。`);
	if (pending.size) lines.push(`还没用上的值：${[...pending].map((i) => inputs[i]!.name).join("、")}`);
	if (obs?.summary) lines.push(`最后的页面内容（不用再读一遍）：\n${obs.summary}`);
	return {
		content: [{ type: "text" as const, text: lines.join("\n") }],
		details: { mode: "goal", steps: rows, stopped: finished ? null : (stopped ?? null), pending: [...pending] },
	};
}
