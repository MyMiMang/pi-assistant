/**
 * 技能的“智能”部分（与 Pi 无关，纯服务端逻辑）：
 *  - 版本历史 + 回滚（每次保存记一个版本）
 *  - 相似技能检索（中文友好的字二元组 Dice 相似度；以后接入向量模型时在这里替换/叠加）
 *  - 建议做成技能：记录每轮任务的“指纹”（工具序列 + 用户原话），发现重复的多步任务或刚完成一个较长的流程时，
 *    用选项卡片问“要不要做成技能？”，用户同意后才让助理去创建（并优先更新相似技能）
 *  - 偏离技能：本轮用了某个技能、用户又纠正了做法 → 让助理起草更新，用 diff 审批卡片确认后才写入
 *  - 节流：同一对话 24 小时最多 1 次、全局 2 小时最多 1 次；拒绝过的同类话题不再提；可以整体关闭
 */
import { createTwoFilesPatch } from "diff";
import { db, getSetting, now, setSetting, uid } from "./db.ts";
import { getSkill, listSkills, saveSkill, type Skill } from "./skills.ts";

// ---------------------------------------------------------------- 版本

export interface SkillVersion {
	name: string;
	version: number;
	description: string;
	body: string;
	source: "user" | "agent" | "rollback" | "initial";
	note: string | null;
	created_at: number;
}

export function listVersions(name: string): SkillVersion[] {
	return db.prepare("SELECT name, version, description, body, source, note, created_at FROM skill_versions WHERE name = ? ORDER BY version DESC").all(name) as unknown as SkillVersion[];
}
function latestVersion(name: string) {
	return (db.prepare("SELECT MAX(version) v FROM skill_versions WHERE name = ?").get(name) as { v: number | null }).v ?? 0;
}
function recordVersion(s: { name: string; description: string; body: string }, source: SkillVersion["source"], note?: string) {
	const v = latestVersion(s.name) + 1;
	db.prepare("INSERT INTO skill_versions(name, version, description, body, source, note, created_at) VALUES(?,?,?,?,?,?,?)").run(s.name, v, s.description, s.body.trim(), source, note ?? null, now());
	return v;
}

/** 保存技能并记录版本（替代直接调用 saveSkill）。旧技能第一次被改时，先把改之前的内容记为版本 1。 */
export function saveSkillVersioned(input: { name: string; description: string; body: string; previousName?: string }, source: SkillVersion["source"], note?: string): Skill & { version: number } {
	const prevName = input.previousName ?? input.name;
	const prev = getSkill(prevName);
	if (prev && !prev.builtin && latestVersion(prev.name) === 0) recordVersion(prev, "initial");
	if (prev && !prev.builtin && input.previousName && input.previousName !== input.name)
		db.prepare("UPDATE skill_versions SET name = ? WHERE name = ?").run(input.name.trim().toLowerCase(), input.previousName);
	const s = saveSkill(input);
	const cur = listVersions(s.name)[0];
	const version = cur && cur.description === s.description && cur.body === s.body.trim() ? cur.version : recordVersion(s, source, note);
	return { ...s, version };
}

export function rollbackSkill(name: string, version: number) {
	const v = listVersions(name).find((x) => x.version === version);
	if (!v) throw new Error("没有这个版本");
	return saveSkillVersioned({ name, description: v.description, body: v.body }, "rollback", `回滚到 v${version}`);
}

export function skillDiff(name: string, before: { description: string; body: string } | null, after: { description: string; body: string }) {
	const fmt = (x: { description: string; body: string } | null) => (x ? `description: ${x.description}\n\n${x.body.trim()}\n` : "");
	return createTwoFilesPatch(`${name} (现在)`, `${name} (修改后)`, fmt(before), fmt(after), "", "", { context: 2 })
		.split("\n")
		.slice(2)
		.join("\n")
		.trim();
}

// ---------------------------------------------------------------- 相似度

function grams(text: string) {
	const t = text
		.toLowerCase()
		.replace(/帮我|麻烦|请你|请|给我|一下|一份|一个|这个|那个|我们|然后|的|了|吧|呢|啊/g, " ")
		.replace(/[\s\p{P}\p{S}]+/gu, " ");
	const out = new Set<string>();
	for (const w of t.split(" ").filter(Boolean)) {
		if (/^[a-z0-9-]+$/.test(w)) for (const p of w.split("-")) p.length > 1 && out.add(p);
		else for (let i = 0; i < w.length - 1; i++) out.add(w.slice(i, i + 2));
	}
	return out;
}
const STOP = new Set(["帮我", "一下", "一个", "这个", "我们", "你们", "然后", "使用", "时候", "用户", "the", "and"]);
export function similarity(a: string, b: string) {
	const A = [...grams(a)].filter((g) => !STOP.has(g));
	const B = new Set([...grams(b)].filter((g) => !STOP.has(g)));
	if (!A.length || !B.size) return 0;
	const inter = A.filter((g) => B.has(g)).length;
	// Dice 系数 + 重叠系数（长短不一的文本，比如一句话 vs 技能描述，不至于被长度拖低）
	const dice = (2 * inter) / (A.length + B.size);
	const overlap = Math.min(A.length, B.size) < 4 ? dice : inter / Math.min(A.length, B.size);
	return (dice + overlap) / 2;
}

export function searchSkills(query: string, opts: { exclude?: string; limit?: number } = {}) {
	return listSkills()
		.filter((s) => s.name !== opts.exclude)
		.map((s) => ({ id: s.id, name: s.name, description: s.description, source: s.source, builtin: s.builtin, score: Math.max(similarity(query, `${s.name.replace(/-/g, " ")} ${s.description}`), 0.8 * similarity(query, s.body.slice(0, 2000))) }))
		.filter((s) => s.score > 0.15)
		.sort((a, b) => b.score - a.score)
		.slice(0, opts.limit ?? 5);
}
export const DUP_THRESHOLD = 0.45;

// ---------------------------------------------------------------- 建议

export interface SuggestSettings {
	enabled: boolean;
	minSteps: number;
	repeatSteps: number;
}
export const suggestSettings = (): SuggestSettings => ({ enabled: true, minSteps: 5, repeatSteps: 3, ...getSetting<Partial<SuggestSettings>>("skillSuggest", {}) });
export const setSuggestSettings = (p: Partial<SuggestSettings>) => setSetting("skillSuggest", { ...suggestSettings(), ...p });

export interface TurnObservation {
	agentId: string;
	conversationId: string | null;
	userText: string;
	tools: string[];
	/** 本轮读取过的技能名（读了它的 SKILL.md） */
	usedSkills: string[];
}
export type Suggestion = { kind: "create"; topic: string; similar?: string } | { kind: "update"; topic: string; skill: string };

const IGNORE_TOOLS = /^(skill_|memory_|routine_|ask_user$|deliver_file$)/;
const CORRECTION = /不对|不是这样|改成|换成|以后都|下次|别再|不要再|应该先|而是|按我说的/;
const DAY = 86_400_000;

function recentlySuggested(agentId: string, conversationId: string | null) {
	const t = now();
	const conv = db.prepare("SELECT 1 FROM skill_suggestions WHERE conversation_id IS ? AND created_at > ?").get(conversationId, t - DAY);
	const global = db.prepare("SELECT 1 FROM skill_suggestions WHERE agent_id = ? AND created_at > ?").get(agentId, t - 2 * 3_600_000);
	const pending = db.prepare("SELECT 1 FROM skill_suggestions WHERE agent_id = ? AND status = 'pending' AND created_at > ?").get(agentId, t - DAY);
	// 连续拒绝 3 次以上：一周最多问一次
	const declines = (db.prepare("SELECT status FROM skill_suggestions WHERE agent_id = ? ORDER BY created_at DESC LIMIT 3").all(agentId) as { status: string }[]).filter((r) => r.status === "declined").length;
	const weekly = declines >= 3 && db.prepare("SELECT 1 FROM skill_suggestions WHERE agent_id = ? AND created_at > ?").get(agentId, t - 7 * DAY);
	return !!(conv || global || pending || weekly);
}
function declinedTopic(topic: string, skill?: string) {
	const rows = db.prepare("SELECT topic, skill FROM skill_suggestions WHERE status IN ('declined','muted') ORDER BY created_at DESC LIMIT 200").all() as { topic: string; skill: string | null }[];
	return rows.some((r) => (skill && r.skill === skill) || similarity(topic, r.topic) >= 0.5);
}

/** 记录一轮任务并判断要不要提建议（返回 null = 不打扰） */
export function observeTurn(o: TurnObservation): Suggestion | null {
	const tools = o.tools.filter((t) => !IGNORE_TOOLS.test(t));
	const usedSkill = o.usedSkills.find((n) => getSkill(n) && !getSkill(n)!.builtin) ?? null;
	const savedSkill = o.tools.some((t) => t.startsWith("skill_"));
	const topic = o.userText.replace(/\s+/g, " ").trim().slice(0, 200);
	if (!topic) return null;
	if (tools.length > 0)
		db.prepare("INSERT INTO task_patterns(id, agent_id, conversation_id, user_text, tools, steps, used_skill, created_at) VALUES(?,?,?,?,?,?,?,?)").run(uid("tp"), o.agentId, o.conversationId, topic, JSON.stringify(tools), tools.length, usedSkill, now());
	const st = suggestSettings();
	if (!st.enabled || savedSkill || recentlySuggested(o.agentId, o.conversationId)) return null;

	// 1) 偏离已有技能：这轮用了某个我的技能，用户又纠正了做法
	if (usedSkill && CORRECTION.test(o.userText)) {
		if (declinedTopic(topic, usedSkill)) return null;
		return { kind: "update", topic, skill: usedSkill };
	}
	if (usedSkill || tools.length < st.repeatSteps) return null;

	// 2) 重复的多步任务：其他对话里出现过相似的任务（话题相似 + 工具有重合）
	const toolSet = new Set(tools);
	const past = db
		.prepare("SELECT user_text, tools, conversation_id FROM task_patterns WHERE agent_id = ? AND created_at > ? AND conversation_id IS NOT ? AND steps >= ? ORDER BY created_at DESC LIMIT 300")
		.all(o.agentId, now() - 60 * DAY, o.conversationId, st.repeatSteps) as { user_text: string; tools: string; conversation_id: string | null }[];
	const repeated = past.some((p) => {
		const pt = JSON.parse(p.tools) as string[];
		const overlap = pt.filter((t) => toolSet.has(t)).length / Math.max(1, new Set(pt).size);
		return similarity(topic, p.user_text) >= 0.35 && overlap >= 0.5;
	});
	// 3) 刚完成一个比较长的多步流程
	if (!repeated && tools.length < st.minSteps) return null;
	if (declinedTopic(topic)) return null;
	const similar = searchSkills(topic, { limit: 1 }).find((s) => !s.builtin && s.score >= DUP_THRESHOLD);
	return similar ? { kind: "update", topic, skill: similar.name } : { kind: "create", topic };
}

export function recordSuggestion(agentId: string, conversationId: string | null, s: Suggestion) {
	const id = uid("sg");
	db.prepare("INSERT INTO skill_suggestions(id, agent_id, conversation_id, kind, skill, topic, status, created_at) VALUES(?,?,?,?,?,?, 'pending', ?)").run(id, agentId, conversationId, s.kind, "skill" in s ? s.skill : null, s.topic, now());
	return id;
}
export function resolveSuggestion(id: string, status: "accepted" | "declined" | "muted" | "expired", requestId?: string) {
	db.prepare("UPDATE skill_suggestions SET status = ?, resolved_at = ?, request_id = COALESCE(?, request_id) WHERE id = ?").run(status, now(), requestId ?? null, id);
}

/** 用户同意了建议后的一段时间内（同一对话 30 分钟），助理新建技能不再额外弹审批 */
export function hasCreateGrant(conversationId: string | null) {
	return !!db.prepare("SELECT 1 FROM skill_suggestions WHERE conversation_id IS ? AND status = 'accepted' AND resolved_at > ?").get(conversationId, now() - 30 * 60_000);
}

export function suggestionPrompt(s: Suggestion, accepted: "create" | "update") {
	if (accepted === "update" && s.kind === "update")
		return `（技能建议，用户已同意）用户这次的做法和技能「${s.skill}」不一样：「${s.topic}」。请读取这个技能，按这次的实际做法修改它，然后调用 skill_save 保存（同名即更新；系统会把修改前后的差异给用户审批）。只改需要改的部分，完成后用一句话说明改了什么。`;
	return `（技能建议，用户已同意）请把刚才完成的「${s.topic}」整理成一个可复用的技能。先用 skill_search 查有没有相似的技能：有就在它的基础上更新（同名保存），没有再新建。写清楚 description（做什么 + 什么时候用）和具体步骤，然后调用 skill_save。完成后用一句话告诉用户技能名。`;
}
