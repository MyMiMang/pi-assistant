/**
 * 主动做事的研判入口（决策 0025）：巡检里 proactive_advance 的一切先过这里——
 *  1. 模式：off 不推进；auto 自动；trial 试运行（只记「本来会做」卡片，等用户点「就这么做」/「这类以后别做」）；
 *  2. 规则研判校验（proactive-rules.ts）：缺研判 / 未知或重复规则 → 拒绝并说明；
 *  3. 放行：用户明确交代的、已有事情里能帮上的、或命中「可以放心做的事」规则的去做，否则转成提醒；
 *  4. 去哪做：单聊（conversationId）走 advanceConversation，群（roomId）走 advanceRoom；
 *  5. 每次判断记一行（proactive-log.ts），提醒面板里可看。
 */
import { now } from "./db.ts";
import { type AdvanceResult, advanceConversation, advanceRoom, itemVisible } from "./proactive-advance.ts";
import { type Outcome, judgmentOfItem, recordJudgment, setOutcome } from "./proactive-log.ts";
import { type JudgeInput, type Verdict, gate, judgeRules } from "./proactive-rules.ts";
import { roomHandler } from "./proactive-room.ts";
import { actOnItem, agentOf, cfgOf, changed, evaluateSurface, surface } from "./proactive.ts";

export interface HeartbeatAdvance extends JudgeInput {
	/** 在哪个单聊里推进（和 roomId 二选一） */
	conversationId?: string;
	/** 在哪个群里推进：叫醒自己在群里发言 */
	roomId?: string;
	kind: string;
	title: string;
	body: string;
	importance: number;
	dedupeKey?: string;
}
const reject = (reason: string): AdvanceResult => ({ status: "rejected", reason });

/** 依据一句话：明确交代 / 命中的规则（带理由）/ 原话，写进给主会话（或群里）的指令和判断记录。 */
function basisOf(v: Extract<Verdict, { ok: true }>, rules: { id: string; text: string }[], j: HeartbeatAdvance): string {
	const hit = (j.ruleAssessments ?? []).filter((a) => v.matched.includes(a.ruleId)).map((a) => `规则「${rules.find((r) => r.id === a.ruleId)?.text ?? a.ruleId}」（${a.reason.trim()}）`);
	return [v.explicit ? "用户明确交代过" : "", v.helpful ? "已有事情里能帮上的一步" : "", ...hit, v.evidence ? `原话：${v.evidence}` : ""].filter(Boolean).join("；");
}

export async function advanceForHeartbeat(agentId: string, i: HeartbeatAdvance, t = now()): Promise<AdvanceResult> {
	const a = agentOf(agentId);
	if (!a) return reject("助理不存在");
	const cfg = cfgOf(a);
	if (cfg.autonomy === "off") return reject("用户关闭了这个助理的主动做事，只能用 proactive_surface 提醒");
	if (!!i.conversationId === !!i.roomId) return reject("conversationId（单聊）和 roomId（群）二选一");
	if (i.roomId && !roomHandler()?.isMember(agentId, i.roomId)) return reject("指定的群不存在，或你已不在这个群里");
	const v = judgeRules(cfg.rules, i);
	if (!v.ok) return reject(v.error);
	const basis = basisOf(v, cfg.rules, i);
	const log = (outcome: Outcome, reason: string | null, itemId?: string) =>
		recordJudgment({ agentId, itemId, conversationId: i.conversationId, roomId: i.roomId, kind: i.kind, title: i.title, basis, rules: (i.ruleAssessments ?? []).filter((x) => x.matched).map((x) => ({ ruleId: x.ruleId, reason: x.reason })), mode: cfg.autonomy, outcome, reason, input: { conversationId: i.conversationId, roomId: i.roomId, kind: i.kind, title: i.title, body: i.body, importance: i.importance, dedupeKey: i.dedupeKey, basis } }, t);

	if (gate(v) === "to_reminder") {
		// 不是用户交代的、不在已有事情里、也没对上规则：不去做，转成普通提醒（走去重 / 预算 / 免打扰）
		const s = surface(agentId, { kind: i.kind, title: i.title, body: i.body, importance: i.importance, dedupeKey: i.dedupeKey, conversationId: i.conversationId ?? null }, t);
		const reason = `是全新的事、也没对上「可以放心做的事」规则，没有自动去做，已转成提醒${s.reason ? `（${s.reason}）` : ""}`;
		if (s.status !== "rejected") log("to_reminder", reason, s.id);
		return { status: s.status === "rejected" ? "rejected" : s.status === "held" ? "held" : "inbox", reason: s.status === "rejected" ? s.reason : reason, id: s.id };
	}
	if (cfg.autonomy === "trial") {
		const d = evaluateSurface(agentId, { kind: i.kind, title: i.title, body: i.body, importance: i.importance, dedupeKey: i.dedupeKey, conversationId: i.conversationId ?? null }, t, { forAdvance: true, scope: i.roomId ? `room:${i.roomId}` : i.conversationId });
		if (d.status === "rejected") return { status: "rejected", reason: d.reason };
		itemVisible(d.id, "试运行：本来会做，等你决定（点「就这么做」才真做）", t);
		log("trial", "试运行：没有真做", d.id);
		changed(agentId);
		return { status: "inbox", reason: "试运行模式：没有真做，已记成「本来会做」卡片放进收件箱", id: d.id };
	}
	const base = { kind: i.kind, title: i.title, body: i.body, importance: i.importance, dedupeKey: i.dedupeKey, basis };
	const r = i.roomId ? await advanceRoom(agentId, { ...base, roomId: i.roomId }, t) : await advanceConversation(agentId, { ...base, conversationId: i.conversationId! }, t);
	if (r.status !== "rejected") log(r.status, r.reason ?? null, r.id);
	return r;
}

/** 试运行卡片上点「就这么做」：照当时的判断真做一次（不再看模式）；没做起来保留卡片，原因返回给界面。 */
export async function confirmTrial(itemId: string, t = now()): Promise<AdvanceResult> {
	const j = judgmentOfItem(itemId);
	if (!j || j.outcome !== "trial") throw new Error("这不是等你决定的试运行卡片");
	const inp = JSON.parse(j.input) as HeartbeatAdvance & { basis?: string };
	const base = { kind: inp.kind, title: inp.title, body: inp.body, importance: inp.importance, dedupeKey: `confirm:${j.id}`, basis: inp.basis };
	const r = inp.roomId ? await advanceRoom(j.agent_id, { ...base, roomId: inp.roomId }, t) : await advanceConversation(j.agent_id, { ...base, conversationId: inp.conversationId! }, t);
	if (["started", "steered", "queued"].includes(r.status)) {
		setOutcome(j.id, "confirmed", `你点了「就这么做」：${r.reason ?? "已开始"}`, t);
		actOnItem(itemId, "done");
	}
	return r;
}
/** 试运行卡片上点「这类以后别做」：记成否定，之后巡检提示里带上，同类判断不再做。 */
export function vetoTrial(itemId: string, t = now()) {
	const j = judgmentOfItem(itemId);
	if (!j || j.outcome !== "trial") throw new Error("这不是等你决定的试运行卡片");
	setOutcome(j.id, "vetoed", "你点了「这类以后别做」", t);
	actOnItem(itemId, "dismiss");
}
