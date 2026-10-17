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
	/** 本轮最后一段回复（只用来判断这一轮是不是明显没做成，不做措辞来源） */
	reply?: string;
	/** 这一轮没有明显失败/中断（不代表“任务已完成”）；不知道时不传 */
	ok?: boolean;
}

/**
 * 建议卡片上给用户看的具体用途：由模型在**同一次**隐藏回合里根据本轮上下文总结，
 * 宿主只做校验（非空、长度、不像通用模板），不拿工具名去猜；复用当前会话的一次建议轮，不另设模型服务。
 */
export interface SkillPurpose {
	/** 这件事本身（如“会议纪要整理”） */
	subject: string;
	/** 做什么：实际做了哪几步（说人话，不是工具名） */
	does: string;
	/** 什么时候用得上（如“下次整理会议录音”） */
	when: string;
	/** 能给你什么（这一轮真的产出过的东西） */
	gives: string;
}
interface SuggestionBase {
	topic: string;
}
export type Suggestion = ({ kind: "create"; similar?: string } & SuggestionBase) | ({ kind: "update"; skill: string } & SuggestionBase);

const IGNORE_TOOLS = /^(skill_|memory_|routine_|ask_user$|deliver_file$)/;
const CORRECTION = /不对|不是这样|改成|换成|以后都|下次|别再|不要再|应该先|而是|按我说的/;
const DAY = 86_400_000;

// ---------------------------------------------------------------- 建议的“用途说明”

const short = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const LEAD = /^(?:帮我|帮忙|请帮我|请你帮我|请你|请|麻烦你|麻烦|给我|能不能|可不可以|可以帮我|可以|你帮我|你|我要你|我想让你|我要|我想|再帮我|再)\s*/;
/** 用户原话去掉“帮我/请/麻烦…吧/呢”这类客套，留下这件事本身 */
function cleanRequest(text: string) {
	let s = text.replace(/\s+/g, " ").trim();
	for (let i = 0; i < 4; i++) {
		const n = s.replace(LEAD, "");
		if (n === s) break;
		s = n;
	}
	const trimmed = s
		.replace(/^[，,。.、:：;；\s]+/, "")
		.replace(/[。.!！?？~～\s]*(?:吧|呢|啊|呀|哦|嘛|谢谢|多谢|好吗|行吗)?[。.!！?？~～\s]*$/, "")
		.trim();
	return trimmed || text.replace(/\s+/g, " ").trim();
}
/** 只剩“继续/检查/再看看/可以了”这类没有具体对象的话 → 证据不足，不硬凑建议 */
const VAGUE_ONLY = /(继续|接着|然后|再来|再试一次|再试|重试|检查|查一下|看一下|看看|看一眼|确认|处理|弄|搞|做一下|试试|下一步|还有吗|还有呢|好了|可以了|行吧|好的|嗯|收到|随便|看着办|你自己看|照做|同上|再查|继续吧)/g;
const SOFT_WORDS = /(的|了|吧|呢|啊|呀|哦|嘛|一下|一遍|一次|先|再|又|都|也|就|把|给|我|你|它|这|那|个|些|点|有没有|问题|怎么样|怎么|如何|是否|吗)/g;
function vagueRequest(cleaned: string) {
	const rest = cleaned
		.replace(VAGUE_ONLY, "")
		.replace(SOFT_WORDS, "")
		.replace(/[\s\p{P}\p{S}\d]+/gu, "");
	return rest.length < 3;
}
// ---------------------------------------------------------------- 提议（模型总结用途 → 宿主校验 → 卡片）

/** 提议窗口：模型在这段时间内提交用途，否则这条候选作废（用户看到卡片后不受此限） */
export const PROPOSAL_TTL = 3 * 60_000;
export const SUGGEST_OPTIONS = ["做成技能", "这次不用", "别再提醒"];

const LIMITS: Record<keyof SkillPurpose, [number, number]> = { subject: [2, 40], does: [4, 160], when: [4, 80], gives: [2, 80] };
const GENERIC_FIELD = /^(?:完成|处理|执行|做|弄|搞|操作|使用工具|调用工具|按步骤|根据上下文|同类任务|类似任务|这个任务|该任务|上述任务|用户需求|用户的要求|各种任务|其他任务|相关任务|任务|事情|操作|工作|流程)(?:任务|事情|操作|工作|流程)?$/;
const GENERIC_PHRASE = /(同类任务|类似任务|根据上下文|按需处理|视情况而定|相关任务|其他类似|本次任务|上述任务|用户的需求|完成用户要求|使用工具完成)/;
/** 只报工具名的“做什么”（读文件/写文件/运行命令…）不算具体用途 */
const TOOL_WORD = /(?:读|看|写|查|改|运行|执行)(?:文件|命令|数据)|操作电脑|使用工具|调用工具|浏览器操作|工具调用/g;
const toolSpeak = (does: string) => does.replace(TOOL_WORD, "").replace(/[、,，和及与\s。.]/g, "").length === 0;

function normalizePurpose(p: SkillPurpose): SkillPurpose {
	const t = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
	return { subject: t(p.subject), does: t(p.does), when: t(p.when), gives: t(p.gives) };
}
/** 校验模型给的用途：字段非空/长度合适/不是通用模板；返回错误说明，通过时返回 null */
export function validatePurpose(input: SkillPurpose): string | null {
	const p = normalizePurpose(input);
	if (p.does && toolSpeak(p.does)) return "does 不要只写工具名（读文件/写文件/运行命令），要用一句话说清实际做了什么";
	for (const k of ["subject", "does", "when", "gives"] as const) {
		const [min, max] = LIMITS[k];
		if (!p[k]) return `${k} 不能为空`;
		if (p[k].length < min || p[k].length > max) return `${k} 长度要在 ${min}-${max} 字之间`;
		if (GENERIC_FIELD.test(p[k]) || GENERIC_PHRASE.test(p[k])) return `${k} 太笼统了，要说这一轮具体做了什么、什么时候用、给出什么`;
	}
	if (vagueRequest(p.subject)) return "subject 太笼统了，要说清是哪件事";
	return null;
}

interface SuggestionRow {
	id: string;
	agent_id: string;
	conversation_id: string | null;
	kind: string;
	skill: string | null;
	topic: string;
	purpose: string | null;
	status: string;
	created_at: number;
	resolved_at: number | null;
}
export function suggestionById(id: string) {
	return db.prepare("SELECT id, agent_id, conversation_id, kind, skill, topic, purpose, status, created_at, resolved_at FROM skill_suggestions WHERE id = ?").get(id) as SuggestionRow | undefined;
}
export function suggestionPurpose(row: { purpose: string | null }): SkillPurpose | null {
	if (!row.purpose) return null;
	try {
		const p = JSON.parse(row.purpose) as SkillPurpose;
		return validatePurpose(p) ? null : normalizePurpose(p);
	} catch {
		return null;
	}
}

/** 候选成立后先记一条 proposing（还没卡片、还没打扰用户），再把总结任务交给同一次隐藏回合 */
export function beginProposal(agentId: string, conversationId: string | null, s: Suggestion) {
	const id = uid("sg");
	db.prepare("INSERT INTO skill_suggestions(id, agent_id, conversation_id, kind, skill, topic, purpose, status, created_at) VALUES(?,?,?,?,?,?,NULL,'proposing',?)").run(
		id,
		agentId,
		conversationId,
		s.kind,
		"skill" in s ? s.skill : null,
		s.topic,
		now(),
	);
	return id;
}

/** 模型提交用途：校验归属（助理/对话/建议 id）、一次性、有界 TTL、字段质量；通过后返回要展示的卡片正文 */
export function submitProposal(input: { agentId: string; conversationId: string | null; suggestionId: string; purpose: SkillPurpose }): { ok: true; question: string; topic: string } | { ok: false; error: string } {
	const row = suggestionById(input.suggestionId);
	if (!suggestSettings().enabled) return { ok: false, error: "主动技能建议已关闭" };
	if (!row) return { ok: false, error: "没有这条待提议的候选（suggestionId 不对）" };
	if (row.agent_id !== input.agentId || (row.conversation_id ?? null) !== (input.conversationId ?? null)) return { ok: false, error: "这条候选不属于当前助理/对话" };
	if (row.status !== "proposing") return { ok: false, error: "这条候选已经处理过了，不能重复提交" };
	if (row.created_at <= now() - PROPOSAL_TTL) {
		expireProposal(row.id);
		return { ok: false, error: "这条候选已经过期" };
	}
	const bad = validatePurpose(input.purpose);
	if (bad) return { ok: false, error: bad };
	const purpose = normalizePurpose(input.purpose);
	// 一次性：只有仍处于 proposing 的那一次能落到 pending 并出卡片
	const r = db.prepare("UPDATE skill_suggestions SET purpose = ?, status = 'pending' WHERE id = ? AND status = 'proposing'").run(JSON.stringify(purpose), row.id);
	if (!r.changes) return { ok: false, error: "这条候选已经处理过了，不能重复提交" };
	return { ok: true, question: suggestionQuestion(purpose), topic: row.topic };
}

/** nudge 结束仍未提交（或失败/中断）→ 作废，不留半条 pending；已经出卡片的保持不动 */
export function expireProposal(id: string) {
	db.prepare("UPDATE skill_suggestions SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'proposing'").run(now(), id);
}

/** 建议卡片的正文：具体做什么、什么时候用、能给你什么（内容来自模型对本轮的总结） */
export function suggestionQuestion(p: SkillPurpose) {
	return [`把「${p.subject}」存成技能？`, `做什么：${p.does}`, `什么时候用：${p.when}`, `能给你：${p.gives}`].join("\n");
}

/** 当前会话的建议轮：基于上下文总结用途，看不清就结束；会使用一次正常模型推理，不另设服务或切模型。 */
export function proposalPrompt(s: Suggestion, suggestionId: string) {
	return [
		"（技能建议的内部步骤，用户看不到这段，也不用向用户复述）刚才这一轮结束了。只根据这一轮对话里实际做过的事，判断这套做法值不值得存成技能：",
		"这一步只允许调用一次 skill_propose，或无输出结束。不要输出正文、思考复述或调用其他工具；未得到该工具返回的明确同意之前，不要 skill_search、skill_save 或写文件。",
		`- 这件事：${short(s.topic, 120)}`,
		"如果看得清“做什么、什么时候会再用、能给出什么”，就调用 skill_propose（suggestionId 用 " + suggestionId + "），字段都写这一轮的实际内容：",
		"  subject：这件事的短名字（如“会议纪要整理”），不要写成工具名；",
		"  does：实际做了哪几步，说人话（如“从录音整理议题、决定和负责人”），不要写“读文件/写文件/运行命令”；",
		"  when：以后什么时候用得上（如“下次整理会议录音”）；",
		"  gives：这一轮真的给出过的东西（如“带待办清单的纪要”）。",
		"看不清、这一轮没做成、或者只是“继续/再看看”这类没有具体对象的事，就直接结束：不要调用 skill_propose，也不要向用户提技能建议。",
	].join("\n");
}

/** 提交成功后的卡片 + 用户决定（提问由宿主注入，便于测试）；同意才记 accepted 供创建 grant 使用 */
export async function proposeAndAsk(input: {
	agentId: string;
	conversationId: string | null;
	suggestionId: string;
	purpose: SkillPurpose;
	ask: (question: string, options: string[]) => Promise<string | undefined>;
}): Promise<{ status: "accepted" | "declined" | "muted" | "expired" | "rejected"; error?: string }> {
	const r = submitProposal(input);
	if (!r.ok) return { status: "rejected", error: r.error };
	return awaitProposalAnswer({ suggestionId: input.suggestionId, question: r.question, ask: input.ask });
}

/** 等卡片决定与模型轮解耦：宿主可先结束提议轮，用户晚点回答仍有效。 */
export async function awaitProposalAnswer(input: { suggestionId: string; question: string; ask: (question: string, options: string[]) => Promise<string | undefined> }): Promise<{ status: "accepted" | "declined" | "muted" | "expired" }> {
	try {
		const answer = await input.ask(input.question, SUGGEST_OPTIONS);
		// 停止/取消是系统终止，不当成用户拒绝，避免永久拉黑话题。
		const status = /（.*(?:停止|取消)/.test(answer ?? "") ? "expired" : answer === SUGGEST_OPTIONS[0] ? "accepted" : answer === SUGGEST_OPTIONS[2] ? "muted" : answer ? "declined" : "expired";
		resolveSuggestion(input.suggestionId, status);
		return { status };
	} catch {
		resolveSuggestion(input.suggestionId, "expired");
		return { status: "expired" };
	}
}

export function acceptedProposalPrompt(topic: string, p: SkillPurpose) {
	return `（技能建议，用户已同意创建）用户同意把「${p.subject}」存成技能。来源任务：${topic}。批准的用途：做什么：${p.does}；什么时候用：${p.when}；能给你：${p.gives}。先用 skill_search 查重，再 skill_save（有相似的就同名更新，保留差异审批）；description 和步骤只覆盖本轮实际做过的这些用途。完成后用一句话告诉用户技能名。`;
}

/** 重启后卡片由 requests 过期；相应候选也作废，不继续占用 pending 节流。 */
export function expireStaleSuggestions() {
	db.prepare("UPDATE skill_suggestions SET status = 'expired', resolved_at = ? WHERE status IN ('proposing','pending')").run(now());
}

function recentlySuggested(agentId: string, conversationId: string | null) {
	const t = now();
	const conv = db.prepare("SELECT 1 FROM skill_suggestions WHERE conversation_id IS ? AND status <> 'expired' AND created_at > ?").get(conversationId, t - DAY);
	const global = db.prepare("SELECT 1 FROM skill_suggestions WHERE agent_id = ? AND status <> 'expired' AND created_at > ?").get(agentId, t - 2 * 3_600_000);
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

	// 1) 偏离已有技能：这轮用了某个我的技能，用户又纠正了做法（走原 diff 流程）
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
	// 证据不足就不提：泛泛的“继续 / 检查一下 / 再看看”没有具体对象；明显失败/报错的一轮也不提。
	if (vagueRequest(cleanRequest(topic))) return null;
	if (o.ok === false) return null;
	if (o.reply && /(没有成功|没能完成|失败了|出错了|无法完成|做不到|中断了)/.test(o.reply)) return null;
	// 用途不在这里猜：交给同一次隐藏回合的模型总结（见 proposalPrompt），这里只给候选。
	const similar = searchSkills(topic, { limit: 1 }).find((s) => !s.builtin && s.score >= DUP_THRESHOLD);
	return similar ? { kind: "update", topic, skill: similar.name } : { kind: "create", topic };
}

export function recordSuggestion(agentId: string, conversationId: string | null, s: Suggestion) {
	const id = uid("sg");
	db.prepare("INSERT INTO skill_suggestions(id, agent_id, conversation_id, kind, skill, topic, purpose, status, created_at) VALUES(?,?,?,?,?,?,NULL, 'pending', ?)").run(id, agentId, conversationId, s.kind, "skill" in s ? s.skill : null, s.topic, now());
	return id;
}
export function resolveSuggestion(id: string, status: "accepted" | "declined" | "muted" | "expired", requestId?: string) {
	db.prepare("UPDATE skill_suggestions SET status = ?, resolved_at = ?, request_id = COALESCE(?, request_id) WHERE id = ?").run(status, now(), requestId ?? null, id);
}

/** 用户同意了建议后的一段时间内（同一对话 30 分钟），助理新建技能不再额外弹审批 */
export function hasCreateGrant(conversationId: string | null) {
	return !!db.prepare("SELECT 1 FROM skill_suggestions WHERE conversation_id IS ? AND status = 'accepted' AND resolved_at > ?").get(conversationId, now() - 30 * 60_000);
}

/** 更新已有技能：用户会在 diff 审批卡片上决定（新建走 skill_propose → 卡片 → skill_save 的流程，不用这段） */
export function suggestionPrompt(s: { kind: "update"; skill: string; topic: string }) {
	return `（技能建议，用户已同意）用户这次的做法和技能「${s.skill}」不一样：「${s.topic}」。请读取这个技能，按这次的实际做法修改它，然后调用 skill_save 保存（同名即更新；系统会把修改前后的差异给用户审批）。只改需要改的部分，完成后用一句话说明改了什么。`;
}
