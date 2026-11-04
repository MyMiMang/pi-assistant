/**
 * 目标模式（quick_steps 的 goal + inputs）的纯逻辑：候选动作生成、剪枝、问题构造、把选中的动作变成一步 QuickStep。
 * 不做 I/O（不调模型、不调工具）；执行循环见 quick-goal-run.ts。
 * 设计见 docs/design/fast-executor-v2-impl.md §5。
 */
import {
	KIND_ROLES,
	roleKey,
	similarity,
	type Candidate,
	type Observation,
	type QuickStep,
} from "./quick-steps.ts";
import { guardedOut } from "./words.ts";

export type GoalActionKind = "fill" | "select" | "upload" | "click" | "check" | "scroll" | "finish" | "reobserve" | "abstain";
export interface GoalAction {
	/** a1…aN */
	id: string;
	kind: GoalActionKind;
	candidate?: Candidate;
	/** inputs 下标 */
	input?: number;
	desc: string;
}
/** 目标模式里唯一的值来源 */
export interface GoalInput {
	name: string;
	value?: string;
	files?: string[];
}

export const MAX_GOAL_ACTIONS = 28;
export const MAX_GOAL_STEPS = 30;
export const DEFAULT_GOAL_STEPS = 15;

export const GOAL_INSTRUCTIONS =
	"这是电脑操作里的一步。根据目标、要用的值、已经做了的步骤和当前页面，从候选动作里挑出**下一步**最该做的那一个。要用的值都用上、目标里要求的操作都做了，才选 finish。页面还没加载好选 reobserve；要找的东西可能在下面选 scroll；拿不准、或者候选里没有该做的动作，选 abstain。";

const hasAction = (c: Candidate, name: string) => (c.actions ?? []).some((a) => a.toLowerCase().includes(name));
/** 上传类：和 filterByKind 的 upload 判断一致 */
const isUpload = (c: Candidate) => roleKey(c.role).includes("file") || hasAction(c, "upload");
const isSelect = (c: Candidate) => KIND_ROLES.select.includes(roleKey(c.role));
const isType = (c: Candidate) => KIND_ROLES.type.includes(roleKey(c.role)) || hasAction(c, "type");
const isCheck = (c: Candidate) => KIND_ROLES.check.includes(roleKey(c.role));
const isClick = (c: Candidate) => KIND_ROLES.click.includes(roleKey(c.role)) || (c.actions ?? []).some((a) => /^(click|press)$/i.test(a));

interface RawAction {
	kind: Exclude<GoalActionKind, "scroll" | "finish" | "reobserve" | "abstain">;
	candidate: Candidate;
	ci: number;
	input?: number;
	score: number;
}

/**
 * 从当前页面和还没用上的值里列候选动作：每个元素按角色归类，再用相似度剪枝
 * （每个元素最多 2 个 input、总共前 28 个），最后固定加 scroll / finish / reobserve / abstain。
 */
export function goalActions(obs: Observation, inputs: GoalInput[], pending: Set<number>, goal: string): GoalAction[] {
	const raw: RawAction[] = [];
	const name = (c: Candidate) => c.name;
	for (let ci = 0; ci < obs.candidates.length; ci++) {
		const c = obs.candidates[ci]!;
		const base = similarity(goal, name(c));
		const pick = (kind: RawAction["kind"], input: number) => raw.push({ kind, candidate: c, ci, input, score: Math.max(base, similarity(inputs[input]!.name, name(c))) });
		const driven = (kind: RawAction["kind"], has: (x: GoalInput) => boolean) => {
			const candidates = [...pending].filter((i) => has(inputs[i]!));
			// 每个元素最多给 2 个最相近的 input，候选太多决策模型会糊涂
			candidates
				.map((i) => ({ i, s: similarity(inputs[i]!.name, name(c)) }))
				.sort((a, b) => b.s - a.s)
				.slice(0, 2)
				.forEach((x) => pick(kind, x.i));
		};
		if (isSelect(c)) driven("select", (x) => !!x.value);
		else if (isType(c)) driven("fill", (x) => !!x.value);
		else if (isUpload(c)) driven("upload", (x) => !!x.files?.length);
		else if (isCheck(c)) {
			if (!guardedOut(c.name, goal)) raw.push({ kind: "check", candidate: c, ci, score: base });
		} else if (isClick(c)) {
			if (!guardedOut(c.name, goal)) raw.push({ kind: "click", candidate: c, ci, score: base });
		}
	}
	// 分数高的在前；分数相同保持原顺序（Array.sort 稳定）
	const top = raw
		.map((a, i) => ({ a, i }))
		.sort((x, y) => y.a.score - x.a.score || x.i - y.i)
		.slice(0, MAX_GOAL_ACTIONS)
		.map((x) => x.a);
	const actions: GoalAction[] = top.map((a, i) => {
		const c = a.candidate;
		const input = a.input !== undefined ? inputs[a.input]! : undefined;
		const desc =
			a.kind === "fill"
				? `在${c.role}「${c.name}」里填「${input!.name}」的值`
				: a.kind === "select"
					? `在「${c.name}」里选「${input!.value ?? ""}」`
					: a.kind === "upload"
						? `把「${input!.name}」的 ${input!.files?.length ?? 0} 个文件传到「${c.name}」`
						: a.kind === "check"
							? `勾选 / 取消「${c.name}」（当前：${c.value || "未知"}）`
							: `点击${c.role}「${c.name}」`;
		return { id: `a${i + 1}`, kind: a.kind, candidate: c, ...(a.input !== undefined ? { input: a.input } : {}), desc };
	});
	const fixed: [GoalActionKind, string][] = [
		["scroll", "往下滚动看更多"],
		["finish", "目标已经完成"],
		["reobserve", "页面还没准备好，等一下再看"],
		["abstain", "拿不准，交回大模型"],
	];
	for (const [kind, desc] of fixed) actions.push({ id: `a${actions.length + 1}`, kind, desc });
	return actions;
}

/** 拼分类请求：目标、要用的值（含状态）、已经做了的、页面内容 + 候选动作 */
export function buildGoalContext(goal: string, inputs: GoalInput[], pending: Set<number>, done: string[], obs: Observation, actions: GoalAction[], withImage: boolean) {
	return {
		state: {
			目标: goal,
			要用的值: inputs.map((x, i) => ({ 名字: x.name, 值: x.value ?? `${x.files?.length ?? 0} 个文件`, 状态: pending.has(i) ? "还没用" : "已用过" })),
			已经做了: done.slice(-8),
			页面: { 标题: obs.title ?? "", 地址: obs.url ?? "", 内容: obs.summary.slice(0, 1500) },
		},
		...(withImage && obs.screenshot ? { images: [{ type: "image" as const, data: obs.screenshot.data, mimeType: obs.screenshot.mimeType }] } : {}),
		questions: { next: { type: "choice" as const, instructions: GOAL_INSTRUCTIONS, criteria: Object.fromEntries(actions.map((a) => [a.id, a.desc])) } },
	};
}

/** 选中的动作 → 一步 QuickStep；值只来自 inputs，scroll / finish / reobserve / abstain 返回 null */
export function actionToStep(a: GoalAction, inputs: GoalInput[]): QuickStep | null {
	const c = a.candidate;
	const input = a.input !== undefined ? inputs[a.input] : undefined;
	if (a.kind === "fill" || a.kind === "select") {
		if (!c || !input?.value) return null;
		return { do: a.kind === "fill" ? "type" : "select", what: c.name, value: input.value };
	}
	if (a.kind === "upload") {
		if (!c || !input?.files?.length) return null;
		return { do: "upload", what: c.name, files: input.files };
	}
	if (a.kind === "click" || a.kind === "check") {
		if (!c) return null;
		return { do: a.kind, what: c.name };
	}
	return null;
}
