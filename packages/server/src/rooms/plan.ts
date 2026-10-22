/**
 * 项目方案（docs/design/group-team.md §3）的纯逻辑：规范化 / 截断、按名字解析分工、渲染成给模型看的文字。
 * 不碰数据库，便于单测；存取和生命周期在 projects.ts。
 */

export interface PlanRole {
	member: string;
	agentId?: string;
	does: string;
}
export interface PlanStage {
	name: string;
	output: string;
}
export interface ProjectPlan {
	goal: string;
	doneCriteria: string;
	assumptions: string[];
	roles: PlanRole[];
	stages: PlanStage[];
	checkpoints: string[];
	deliverables: string;
	needs: string;
	scale: string;
}

const str = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const list = (v: unknown, max: number, n: number) => (Array.isArray(v) ? v.map((x) => str(x, n)).filter(Boolean).slice(0, max) : []);
const objs = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object").slice(0, max) : []);

/** 项目名：≤40 字；没写就取目标前 40 字。 */
export const clipTitle = (title: unknown, goal = "") => str(title, 40) || str(goal, 40);

/** 把任意输入整理成一份完整的 ProjectPlan（缺的字段给空值，超长截断，空行去掉）。 */
export function normalizePlan(raw: unknown): ProjectPlan {
	const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	return {
		goal: str(p.goal, 1000),
		doneCriteria: str(p.doneCriteria, 2000),
		assumptions: list(p.assumptions, 10, 300),
		roles: objs(p.roles, 12)
			.map((r) => ({ member: str(r.member, 40).replace(/^[@＠]/, "").trim(), ...(typeof r.agentId === "string" && r.agentId ? { agentId: r.agentId } : {}), does: str(r.does, 300) }))
			.filter((r) => r.member),
		stages: objs(p.stages, 10)
			.map((s) => ({ name: str(s.name, 60), output: str(s.output, 300) }))
			.filter((s) => s.name || s.output),
		checkpoints: list(p.checkpoints, 6, 300),
		deliverables: str(p.deliverables, 1000),
		needs: str(p.needs, 500),
		scale: str(p.scale, 300),
	};
}

/** 只有目标和完成标准的方案（迁移旧的自主推进、旧的目标卡确认时用）。 */
export const goalOnlyPlan = (goal: string, doneCriteria: string) => normalizePlan({ goal, doneCriteria });

/**
 * 出方案前的检查：目标、完成标准、交付物不能空；分工至少一条且名字都是群成员（含管理者）；至少一个阶段。
 * 通过时给分工补上 agentId（按名字解析，忽略大小写和开头的 @）。
 */
export function checkPlan(plan: ProjectPlan, members: { id: string; name: string }[]): { plan: ProjectPlan; error?: undefined } | { error: string; plan?: undefined } {
	const missing = [!plan.goal && "goal（要做成什么）", !plan.doneCriteria && "doneCriteria（怎样算完成）", !plan.deliverables && "deliverables（最后交给用户什么）", !plan.roles.length && "roles（分工，至少一条）", !plan.stages.length && "stages（阶段，至少一个）"].filter(Boolean);
	if (missing.length) return { error: `方案还不完整，缺：${missing.join("、")}。补齐后再出方案卡。` };
	const find = (name: string) => members.find((m) => m.name === name) ?? members.find((m) => m.name.toLowerCase() === name.toLowerCase());
	const bad = plan.roles.filter((r) => !find(r.member)).map((r) => r.member);
	if (bad.length) return { error: `分工里这些不是群成员：${bad.join("、")}。分工只能写群里的成员（含你自己）：${members.map((m) => m.name).join("、")}。` };
	return { plan: { ...plan, roles: plan.roles.map((r) => { const m = find(r.member)!; return { member: m.name, agentId: m.id, does: r.does }; }) } };
}

/** 给模型看的方案摘要：项目名 / 编号 / 目标 / 完成标准 / 分工 / 阶段（群规则、管理者被唤醒时共用）。 */
export function planText(p: { id: string; title: string; plan: ProjectPlan }) {
	const { plan } = p;
	return [
		`项目「${p.title}」（项目编号 ${p.id}）`,
		`目标：${plan.goal || "（未写）"}`,
		`完成标准：${plan.doneCriteria || "（未写）"}`,
		...(plan.roles.length ? [`分工：${plan.roles.map((r) => `${r.member}：${r.does || "（未写）"}`).join("；")}`] : []),
		...(plan.stages.length ? [`阶段：${plan.stages.map((s, i) => `${i + 1}. ${s.name}${s.output ? ` → ${s.output}` : ""}`).join("；")}`] : []),
		...(plan.deliverables ? [`交付物：${plan.deliverables}`] : []),
		...(plan.checkpoints.length ? [`关键点（到了请用户看一眼，用 room_checkpoint）：${plan.checkpoints.join("；")}`] : []),
	].join("\n");
}
