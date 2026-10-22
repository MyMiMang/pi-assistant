/**
 * 成员之间「可追踪的提问」的纯逻辑（docs/design/group-team.md 第 5 节、决策 0019 第 4 步）：
 * 一个问题一段小对话，来回有上限、没人答有超时，超过就交给管理者。表和流程在 asks.ts / ask-flow.ts。
 */
export type AskKind = "question" | "upstream";
export type AskStatus = "open" | "answered" | "escalated" | "closed";
export interface ThreadEntry {
	by: string;
	text: string;
	at: number;
}

/** 一段小对话最多来回几轮（问一次 + 答一次算一轮），再追问就交给管理者。 */
export const MAX_ASK_ROUNDS = 3;
/** 提问没人回答多久交给管理者（环境变量 PIA_ASK_TIMEOUT_MS 覆盖，测试用）。 */
export const ASK_TIMEOUT_MS = () => Number(process.env.PIA_ASK_TIMEOUT_MS) || 20 * 60_000;

/** 这段对话现在该怎么办：ok = 继续；too_many_rounds = 再追问就超过上限；timeout = 没人答超时。 */
export function askStep(o: { rounds: number; status: AskStatus; now: number; updatedAt: number; timeoutMs: number }): "ok" | "too_many_rounds" | "timeout" {
	if (o.status === "open" && o.now - o.updatedAt >= o.timeoutMs) return "timeout";
	if (o.status === "escalated" || o.status === "closed") return "ok";
	if (o.rounds >= MAX_ASK_ROUNDS) return "too_many_rounds";
	return "ok";
}

/** 交给管理者时带上的对话摘要：最近几条。 */
export function threadSummary(thread: ThreadEntry[], nameOf: (agentId: string) => string, last = 4): string {
	return thread
		.slice(-last)
		.map((e) => `${nameOf(e.by)}：${e.text.replace(/\s+/g, " ").slice(0, 160)}`)
		.join(" / ");
}

/** 送给被问的人的话。upstream = 下游发现前置任务的成果有问题。 */
export function askIntro(o: { id: string; kind: AskKind; fromName: string; text: string; rounds: number; targetItem?: { id: string; title: string } | null; toIsManager: boolean }): string {
	const head = o.kind === "upstream" && o.targetItem ? `${o.fromName} 发现你负责的任务「${o.targetItem.title}」（编号 ${o.targetItem.id}）的成果有问题` : `${o.fromName} 向你提问${o.rounds > 1 ? `（第 ${o.rounds} 轮追问）` : ""}`;
	const how =
		o.kind === "upstream" && o.targetItem
			? `认为确实有问题：用 work_rework（workItemId 填 ${o.targetItem.id}，why 写清楚要改什么）把任务重开重做，改好重新核验后会自动把新版本交给对方；认为没问题：用 answer_colleague 说明理由。不要直接去改对方的东西。`
			: `用 answer_colleague 回答（askId 填 ${o.id}），回答会直接送到对方手上，不用另外在群里重复。${o.toIsManager ? "涉及方案（目标 / 范围 / 交付物）的由你拍板，必要时问用户；其余直接回答或安排。" : "拿不准、涉及目标 / 范围 / 分工的，如实说并建议问管理者。"}`;
	return `${head}（提问编号 ${o.id}）：${o.text}\n${how}`;
}

/** 从一段文字里取出提问编号。 */
export const askIdOf = (text: string | null | undefined): string | null => String(text ?? "").match(/提问编号 (ask_[a-z0-9]+)/)?.[1] ?? null;
