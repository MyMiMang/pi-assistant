/**
 * 助理工作状态（纯逻辑，便于单测）：群成员条和单聊顶部共用。
 * 数据都来自已有的推送 / 接口：群发言状态（room.state）、帮手列表（/api/subagents）、消息里没处理的审批 / 提问卡、助理 status。
 * 优先级：等你 > 在群里说话 > 帮手在做任务 > 排队 > 空闲。
 */
export type ActState = "work" | "wait" | "idle";
export interface Activity { state: ActState; text: string }
/** 帮手的精简信息（标题已经过 taskTitle 去前缀；live = 排队 / 运行 / 卡住都算在跑） */
export interface HelperBrief { agentId: string; kind?: string | null; title: string; status: string; live: boolean }
export type PendingKind = "approval" | "question";

const PENDING_TEXT: Record<PendingKind, string> = { approval: "等你审批", question: "等你回答" };
/** 群回合原因 → 在做什么（原因取值见服务端 rooms/logic.ts 的 TurnReason） */
const REASON_TEXT: Record<string, string> = { followup: "在总结", check: "在看任务进度", resume: "接着做" };

/** 消息里某个助理没处理的审批 / 提问卡（关键点确认、提问都是 question 卡，不叫「审批」）。 */
export function pendingCardOf(list: { role: string; agent_id: string; meta: Record<string, unknown> }[], agentId: string): PendingKind | undefined {
	for (let i = list.length - 1; i >= 0; i--) {
		const m = list[i];
		if (m.role === "card" && m.agent_id === agentId && m.meta.status === "pending" && (m.meta.kind === "approval" || m.meta.kind === "question")) return m.meta.kind as PendingKind;
	}
	return undefined;
}

/** 帮手在做什么：群任务写「做任务「X」」，其他帮手写「帮手在做「X」」；排队的加「排队」。 */
function helperText(h: HelperBrief) {
	const title = h.title.replace(/^任务\s*[:：]\s*/, "").trim() || "任务";
	if (h.status === "queued") return `任务「${title}」排队中`;
	return h.kind === "work" ? `做任务「${title}」` : `帮手在做「${title}」`;
}

/** 一个群成员现在的状态。 */
export function memberActivity(o: { agentId: string; current: { agentId: string; reason: string } | null; queue: string[]; pending?: PendingKind; helpers: HelperBrief[] }): Activity {
	if (o.pending) return { state: "wait", text: PENDING_TEXT[o.pending] };
	if (o.current?.agentId === o.agentId) return { state: "work", text: REASON_TEXT[o.current.reason] ?? "在群里回复" };
	const mine = o.helpers.filter((h) => h.live && h.agentId === o.agentId);
	const running = mine.find((h) => h.status !== "queued");
	if (running) return { state: "work", text: helperText(running) };
	if (o.queue.includes(o.agentId)) return { state: "work", text: "排队等发言" };
	if (mine[0]) return { state: "work", text: helperText(mine[0]) };
	return { state: "idle", text: "空闲" };
}

/** 单聊里助理的状态：主会话在跑就是工作中，没在跑但有帮手在做也算工作中。 */
export function agentActivity(o: { running: boolean; pending?: PendingKind; helpers: HelperBrief[] }): Activity {
	if (o.pending) return { state: "wait", text: PENDING_TEXT[o.pending] };
	if (o.running) return { state: "work", text: "正在工作" };
	const live = o.helpers.filter((h) => h.live);
	const running = live.find((h) => h.status !== "queued") ?? live[0];
	if (running) return { state: "work", text: live.length > 1 ? `${live.length} 个帮手在做` : helperText(running) };
	return { state: "idle", text: "空闲" };
}

/** 群的总状态：有人等你最先说；有人在干活说几个人；全停了明说「都停下了」，带最后动静的时间。 */
export function roomSummary(acts: Activity[], lastAgo = ""): Activity {
	const wait = acts.filter((a) => a.state === "wait").length;
	const work = acts.filter((a) => a.state === "work").length;
	if (wait) return { state: "wait", text: `${wait} 人等你${work ? ` · ${work} 人在干活` : ""}` };
	if (work) return { state: "work", text: `${work} 人在干活` };
	return { state: "idle", text: `都停下了${lastAgo ? ` · ${lastAgo}` : ""}` };
}
