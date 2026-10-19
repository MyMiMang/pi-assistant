/** DESIGN §21：子代理状态与完成通知落库，执行仍复用 runtime 的 Pi 会话。 */
import { bus } from "./bus.ts";
import { db, getSetting, setSetting, uid } from "./db.ts";
import { insertMessage, updateMessage } from "./messages.ts";
import { isStopCommand } from "./interject.ts";
import { modelProfiles } from "./rooms/model-pick.ts";
import { inferNeeds, pickModel } from "./model-profile.ts";
import { isThinkingLevel } from "./models.ts";
import { requests } from "./requests.ts";
import { classifyResume, RESTART_RESUME_PROMPT, sessionResumeSafety, verifyResumePrompt } from "./subagent-resume.ts";
import { repeatBlocked, stuckRestartPrompt, SUBAGENT_STALL_MS, superviseFinish, superviseStall, type StuckHooks } from "./subagent-stuck.ts";
import { claimSubagentWake, markSubagentWakeDelivered, releaseSubagentWake, subagentWakeOwner, wakeClaimKey } from "./task-waits.ts";

export type ModelRef = { provider: string; id: string }; export type HelperKind = "task" | "routine" | "heartbeat" | "work";
export type SubagentStatus = "queued" | "running" | "stalled" | "done" | "failed" | "stopped" | "timeout" | "lost";
export interface Subagent {
	id: string; agent_id: string; conversation_id: string; parent_message_id: string | null;
	task: string; context: string; model_provider: string; model_id: string; model_reason: string;
	/** 单个子代理的思考强度覆盖（Pi 档位）；null = 继承助理的子代理默认设置 */
	thinking: string | null;
	/** 单个子代理的请求级 Fast 覆盖（1=开 / 0=关）；null = 跟随所属助理 */
	fast: number | null;
	status: SubagentStatus; last_activity_at: number; error_reason: string | null; notified_at: number | null;
	result_summary: string | null; created_at: number; finished_at: number | null;
	session_file: string | null; run_started_at: number | null; pending_input: string | null; resume: number | null; /** 卡住上报（JSON，见 subagent-stuck.ts） */ escalation?: string | null; /** 来源（决策 0014）：null = 主会话派的帮手；task 后台任务 / routine 定时任务 / heartbeat 主动巡检 */ kind?: HelperKind | null; title?: string | null; routine_run_id?: string | null; /** 第 5 步：派它的上一层帮手（最多一层）/ 群里的角色范围（下一层继承）/ 群任务的这次执行 */ parent_subagent_id?: string | null; scope?: string | null; work_run_id?: string | null;
	/** 已经开始的轮次数（含每次原任务续跑）；工具摘要用 */
	attempt: number;
	/** 有界退避重试的下一次时间（毫秒），不在退避中为 null；工具摘要用 */
	retry_at: number | null;
	/** 派活时解析出的候选模型顺序（JSON 数组，第一项是实际用的；池内 fallback 按这个顺序，空 = 只跟随主会话）。 */
	model_pool: string | null;
}
/** 子代理行 + 恢复决策的安全摘要（给 subagent_list / 接口，不含内部提示词或凭据）。 */
export interface SubagentSummary extends Subagent { retryable: boolean; resumeReason: string; canResume: boolean; waitingRetry: boolean; /** 已派发但结果未落库的工具调用存在：续跑前必须先核验副作用（自动续跑会被拒绝）。 */ needsVerify?: boolean; pendingToolNames?: string[] }
export interface SubagentEvent { id: string; subagent_id: string; kind: string; reason: string; created_at: number; delivered_at: number | null; /** 终态代际（= 当时的 finished_at）：同一帮手续聊多次结束时区分每一代唤醒 */ generation: number | null }
/** 全局子代理设置只保留任务侧参数：并发上限与最长运行时间。子代理模型改由每个助理的候选池决定（见 DESIGN §21.5）。 */
export interface SubagentSettings { maxMinutes: number; maxConcurrent: number }
/**
 * 助理级覆盖（独立键 `subagentLimits:<agentId>`）：只存**显式覆盖**的字段，缺省 = 继承全局默认。
 * 绝不把全局值 copy 成每个助理的覆盖（旧行为不变，只做加法）。
 */
export interface SubagentLimitsOverride { maxConcurrent?: number; maxMinutes?: number }
/** 保存设置时的入参：两个字段都可省略 —— 省略时保留当前值，绝不重置（旧客户端 / 只改一项的界面不传另一个字段）。 */
export type SubagentSettingsInput = { maxMinutes?: number; maxConcurrent?: number };
/** PUT 助理级上限：省略 = 保留，`null` = 清除覆盖（继承全局默认），数字 = 校验后写入覆盖。 */
export type SubagentLimitsInput = { maxConcurrent?: number | null; maxMinutes?: number | null };
/** `GET/PUT /api/agents/:id/subagents/settings` 的 DTO。 */
export interface AgentSubagentSettings { settings: SubagentSettings; overrides: SubagentLimitsOverride; defaults: SubagentSettings }
/** 助理级：候选模型池。空池 = 跟随主会话当前模型。 */
export type AgentSubagentPool = { pool: ModelRef[] };
/** @deprecated 旧助理级设置形状，仅为兼容旧客户端保留，读写都会转成候选池。 */
export type AgentSubagentChoice = { mode: "follow" } | { mode: "fixed"; model: ModelRef };
/** 助理的子代理默认思考强度：跟随主会话（默认）或指定一个 Pi 档位（实际用时会按子代理实际模型收敛）。 */
export type SubagentThinking = { mode: "follow" } | { mode: "fixed"; level: string };
/** 并发上限的默认值与允许范围（按助理计算，见 pumpSubagents）。 */
export const SUBAGENT_CONCURRENCY = { default: 10, min: 1, max: 100 } as const;
const ACTIVE = "('running','stalled')";
/** 未到终态的状态：运行中、暂无进展、排队等空位。 */
const LIVE = "('queued','running','stalled')";
export const isActiveSubagent = (s: string) => s === "running" || s === "stalled";
export const isQueuedSubagent = (s: string) => s === "queued";
export const isLiveSubagent = (s: string) => isActiveSubagent(s) || isQueuedSubagent(s);

db.exec(`CREATE TABLE IF NOT EXISTS subagents (
 id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, conversation_id TEXT NOT NULL, parent_message_id TEXT,
 task TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', model_provider TEXT NOT NULL, model_id TEXT NOT NULL, model_reason TEXT NOT NULL,
 status TEXT NOT NULL, last_activity_at INTEGER NOT NULL, error_reason TEXT, notified_at INTEGER, result_summary TEXT,
 created_at INTEGER NOT NULL, finished_at INTEGER);
 CREATE INDEX IF NOT EXISTS subagents_conv ON subagents(conversation_id, created_at);
 CREATE TABLE IF NOT EXISTS subagent_events (
 id TEXT PRIMARY KEY, subagent_id TEXT NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER);
`);
const columns = db.prepare("PRAGMA table_info(subagents)").all() as { name: string }[];
for (const [name, type] of [["session_file", "TEXT"], ["run_started_at", "INTEGER"], ["pending_input", "TEXT"], ["resume", "INTEGER"], ["model_pool", "TEXT"], ["thinking", "TEXT"], ["fast", "INTEGER"], ["attempt", "INTEGER DEFAULT 0"], ["retry_at", "INTEGER"], ["escalation", "TEXT"], ["kind", "TEXT"], ["title", "TEXT"], ["routine_run_id", "TEXT"], ["parent_subagent_id", "TEXT"], ["scope", "TEXT"], ["work_run_id", "TEXT"]]) {
	if (!columns.some((c) => c.name === name)) db.exec(`ALTER TABLE subagents ADD COLUMN ${name} ${type}`);
}
// 事件记录当时的终态代际：同一子代理续聊后多次结束时，用每一代自己的 finished_at 去重
if (!(db.prepare("PRAGMA table_info(subagent_events)").all() as { name: string }[]).some((c) => c.name === "generation")) db.exec("ALTER TABLE subagent_events ADD COLUMN generation INTEGER");
export const getSubagent = (id: string) => db.prepare("SELECT * FROM subagents WHERE id = ?").get(id) as Subagent | undefined;
export const listSubagents = (agentId?: string, conv?: string) => db.prepare(`SELECT * FROM subagents${conv ? " WHERE conversation_id = ?" : agentId ? " WHERE agent_id = ?" : ""} ORDER BY created_at DESC LIMIT 100`).all(...(conv ? [conv] : agentId ? [agentId] : [])) as unknown as Subagent[];
const activeSubagents = (agentId?: string) => db.prepare(`SELECT * FROM subagents WHERE status IN ${ACTIVE}${agentId ? " AND agent_id = ?" : ""}`).all(...(agentId ? [agentId] : [])) as unknown as Subagent[];
const liveSubagents = (agentId?: string) => db.prepare(`SELECT * FROM subagents WHERE status IN ${LIVE}${agentId ? " AND agent_id = ?" : ""}`).all(...(agentId ? [agentId] : [])) as unknown as Subagent[];
const activeCount = (agentId: string) => (db.prepare(`SELECT COUNT(*) n FROM subagents WHERE agent_id = ? AND status IN ${ACTIVE}`).get(agentId) as { n: number }).n;
/** 这个助理还有没有空位跑新子代理（按助理计算；上限走该助理的有效设置）。 */
export const hasSubagentCapacity = (agentId: string) => activeCount(agentId) < getSubagentSettings(agentId).maxConcurrent;
const clampConcurrent = (n: unknown) => {
	const v = Math.round(Number(n));
	return Number.isFinite(v) ? Math.min(SUBAGENT_CONCURRENCY.max, Math.max(SUBAGENT_CONCURRENCY.min, v)) : SUBAGENT_CONCURRENCY.default;
};
/** 读全局默认（旧 `subagentModels`）；兼容旧库里没有 maxConcurrent 的记录，并忽略已废弃的模型指定/挑选字段。 */
export const subagentSettings = (): SubagentSettings => {
	const raw = getSetting<Partial<SubagentSettings>>("subagentModels", {});
	return {
		maxMinutes: raw.maxMinutes && raw.maxMinutes > 0 ? raw.maxMinutes : 60,
		maxConcurrent: clampConcurrent(raw.maxConcurrent),
	};
};
/** 助理的显式覆盖（只在 `subagentLimits:<id>` 里存覆盖字段；坏数据字段忽略）。 */
export function agentSubagentLimits(agentId: string): SubagentLimitsOverride {
	const raw = getSetting<unknown>(`subagentLimits:${agentId}`, null);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const o = raw as { maxConcurrent?: unknown; maxMinutes?: unknown };
	const out: SubagentLimitsOverride = {};
	const c = Number(o.maxConcurrent);
	if (Number.isInteger(c) && c >= SUBAGENT_CONCURRENCY.min && c <= SUBAGENT_CONCURRENCY.max) out.maxConcurrent = c;
	const m = Number(o.maxMinutes);
	if (Number.isFinite(m) && m > 0) out.maxMinutes = m;
	return out;
}
/**
 * 有效子代理设置：助理覆盖 > 全局默认。**唯一集中入口**：spawn / queue pump / deadline / resume
 * 都传自己的 owner agentId，不再各自读全局值，也不接受工具参数自报的 agent。
 */
export function getSubagentSettings(agentId?: string): SubagentSettings {
	const d = subagentSettings();
	if (!agentId) return d;
	const o = agentSubagentLimits(agentId);
	return { maxConcurrent: o.maxConcurrent ?? d.maxConcurrent, maxMinutes: o.maxMinutes ?? d.maxMinutes };
}
/** 助理级上限的 DTO（GET 返回；`settings` = 有效值，`overrides` = 显式覆盖，`defaults` = 全局默认）。 */
export function agentSubagentSettingsDto(agentId: string): AgentSubagentSettings {
	return { settings: getSubagentSettings(agentId), overrides: agentSubagentLimits(agentId), defaults: subagentSettings() };
}
/**
 * 保存助理级上限（patch 语义）：只写这个助理的独立键，绝不改全局 `subagentModels`、也不动其它助理。
 * 新值在**下一次 pump / 下一个任务**生效（不回溯改正在跑的任务）。
 */
export function saveAgentSubagentLimits(agentId: string, input: SubagentLimitsInput): AgentSubagentSettings {
	const next: SubagentLimitsOverride = { ...agentSubagentLimits(agentId) };
	if (input?.maxConcurrent !== undefined) {
		if (input.maxConcurrent === null) delete next.maxConcurrent;
		else {
			const n = Number(input.maxConcurrent);
			if (!Number.isInteger(n) || n < SUBAGENT_CONCURRENCY.min || n > SUBAGENT_CONCURRENCY.max) throw new Error(`并发上限必须是 ${SUBAGENT_CONCURRENCY.min} 到 ${SUBAGENT_CONCURRENCY.max} 之间的整数`);
			next.maxConcurrent = n;
		}
	}
	if (input?.maxMinutes !== undefined) {
		if (input.maxMinutes === null) delete next.maxMinutes;
		else {
			const n = Number(input.maxMinutes);
			if (!Number.isFinite(n) || n <= 0) throw new Error("最长运行时间必须大于 0");
			next.maxMinutes = n;
		}
	}
	setSetting(`subagentLimits:${agentId}`, Object.keys(next).length ? next : null);
	pumpSubagents(agentId);
	return agentSubagentSettingsDto(agentId);
}
/** 助理被删时清掉它的覆盖键（不碰全局默认）。 */
export const deleteAgentSubagentLimits = (agentId: string) => db.prepare("DELETE FROM settings WHERE key = ?").run(`subagentLimits:${agentId}`);
export * from "./subagent-models.ts";
import { agentSubagentPool, asRefs, livePool, modelKey, normalizeAgentPool, requireModel } from "./subagent-models.ts";
export function saveSubagentSettings(input: SubagentSettingsInput) {
	const cur = subagentSettings();
	const maxMinutes = Number(input?.maxMinutes ?? cur.maxMinutes);
	if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new Error("最长运行时间必须大于 0");
	// 不传就保留当前值：只改一项（或旧客户端）不带另一个字段，不能因此把它重置回默认值
	const maxConcurrent = input?.maxConcurrent == null ? cur.maxConcurrent : Number(input.maxConcurrent);
	if (!Number.isInteger(maxConcurrent) || maxConcurrent < SUBAGENT_CONCURRENCY.min || maxConcurrent > SUBAGENT_CONCURRENCY.max) throw new Error(`并发上限必须是 ${SUBAGENT_CONCURRENCY.min} 到 ${SUBAGENT_CONCURRENCY.max} 之间的整数`);
	const s: SubagentSettings = { maxMinutes, maxConcurrent };
	setSetting("subagentModels", s);
	pumpSubagents();
	return s;
}
/** 改单个子代理的 Fast 覆盖（null = 跟随所属助理）；落库并广播。 */
export function setSubagentFastOverride(id: string, fast: boolean | null): Subagent {
	const r = getSubagent(id);
	if (!r) throw new Error("帮手不存在");
	if (fast !== null && typeof fast !== "boolean") throw new Error("Fast 开关不对");
	db.prepare("UPDATE subagents SET fast = ? WHERE id = ?").run(fast === null ? null : fast ? 1 : 0, id);
	changed(id);
	return getSubagent(id)!;
}
/** 改单个子代理的思考覆盖（null = 跟随助理默认）；落库并广播。 */
export function setSubagentThinkingOverride(id: string, thinking: string | null): Subagent {
	const r = getSubagent(id);
	if (!r) throw new Error("帮手不存在");
	if (thinking !== null && !isThinkingLevel(thinking)) throw new Error("思考强度不对");
	db.prepare("UPDATE subagents SET thinking = ? WHERE id = ?").run(thinking, id);
	changed(id);
	return getSubagent(id)!;
}
/** 运行中的子代理立即切换思考强度（走 pi-adapter 公开的 applyModelSettings，不动主会话）。 */
export async function applyLiveSubagentThinking(id: string, level: string): Promise<boolean> {
	const r = getSubagent(id), l = live.get(id);
	if (!r || !l?.apply || !isActiveSubagent(r.status)) return false;
	await l.apply({ provider: r.model_provider, id: r.model_id }, level);
	return true;
}
/**
 * 给一个子代理挑模型，并给出池内 fallback 的候选顺序（第一项就是实际用的模型）：
 * - 没设候选池（默认）→ 跟随主会话当前模型，不做任何自动挑选，也没有池外可换。
 * - 设了候选池 → 用能力画像在池内挑最适合任务的；主会话显式指定时必须在池内。
 * - 空池 / 池内没有可用模型 → 明确报错，绝不偷偷用池外模型。
 */
export function chooseSubagentModel(agentId: string, fallback: ModelRef, task: string, needs: string[] = [], explicit?: ModelRef): { model: ModelRef; reason: string; pool: ModelRef[] } {
	const pool = livePool(agentSubagentPool(agentId));
	const follow = requireModel(fallback);
	if (!pool.length) {
		if (explicit && modelKey(explicit) !== modelKey(follow)) throw new Error("这个助理没有设置候选池，帮手只能跟随主会话模型");
		return { model: follow, reason: "跟随主会话模型", pool: [follow] };
	}
	if (explicit) {
		const hit = pool.find((m) => modelKey(m) === modelKey(explicit));
		if (!hit) throw new Error("模型不在这个助理的候选池内");
		return { model: hit, reason: "主会话指定（在候选池内）", pool: [hit, ...pool.filter((m) => modelKey(m) !== modelKey(hit))] };
	}
	const profiles = modelProfiles().filter((m) => pool.some((x) => modelKey(x) === modelKey(m)));
	const pick = pickModel({ needs: [...new Set([...inferNeeds(task), ...needs])] as never }, profiles, pool[0]);
	if (!pick.model) throw new Error("候选池里没有可用模型");
	const chosen = requireModel(pick.model);
	return { model: chosen, reason: pick.reason, pool: [chosen, ...pool.filter((m) => modelKey(m) !== modelKey(chosen))] };
}
/**
 * 一次性迁移旧设置（幂等）：
 * - 全局只保留并发 / 超时；旧的全局模型指定按新定义废弃，子代理默认跟随主会话。
 * - 旧的「全局允许清单」迁移成还没有显式助理配置的助理的候选池，用户已选的清单不丢。
 * - 助理已有的显式配置原样保留：旧单模型 → 单项池，旧跟随 → 空池。
 */
export function migrateSubagentModelSettings() {
	const raw = getSetting<Record<string, unknown>>("subagentModels", {});
	const globalAllowed = asRefs(raw.allowed);
	if (raw.mode !== undefined || raw.allowed !== undefined || raw.model !== undefined) {
		const s = subagentSettings();
		setSetting("subagentModels", s);
	}
	const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'subagentModel:%'").all() as { key: string; value: string }[];
	const explicit = new Set<string>();
	for (const r of rows) {
		explicit.add(r.key.slice("subagentModel:".length));
		let parsed: unknown;
		try { parsed = JSON.parse(r.value); } catch { parsed = null; }
		// 新格式原样保留；旧格式写回成候选池
		if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { pool?: unknown }).pool)) setSetting(r.key, { pool: normalizeAgentPool(parsed) });
	}
	if (globalAllowed.length) for (const a of db.prepare("SELECT id FROM agents").all() as { id: string }[]) if (!explicit.has(a.id)) setSetting(`subagentModel:${a.id}`, { pool: globalAllowed });
}
/** 池内自动 fallback：换模型继续同一个子代理（同一张卡、同一个任务），并把原因记成一条用户可见的系统消息。 */
export function switchSubagentModel(id: string, next: ModelRef, reason: string) {
	const r = getSubagent(id);
	if (!r) return;
	const m = requireModel(next);
	if (r.model_provider === m.provider && r.model_id === m.id) return;
	const from = `${r.model_provider}/${r.model_id}`;
	db.prepare("UPDATE subagents SET model_provider = ?, model_id = ?, model_reason = ? WHERE id = ?").run(m.provider, m.id, reason, id);
	insertMessage({ agentId: r.agent_id, conversationId: r.conversation_id, subagentId: id, role: "system", content: `模型 ${from} 不可用，已切换到候选池内的 ${m.provider}/${m.id}：${reason}` });
	changed(id);
}
interface Live { stop?: () => Promise<void>; message?: (text: string, messageId?: string) => Promise<void>; apply?: (model: ModelRef, thinking: string) => Promise<void>; pending: { text: string; messageId?: string }[]; toolUntil: number; /** 卡住重启：中断后带这条纠正重新排队 */ restart?: string }
const live = new Map<string, Live>();
interface Driver {
	run(r: Subagent, connect: (stop: () => Promise<void>, message: Live["message"], apply?: Live["apply"]) => void, input?: { text: string; messageId?: string }): Promise<string>;
	notify(r: Subagent, event: SubagentEvent): Promise<void>;
}
let driver: Driver;
export function setSubagentDriver(d: Driver) { driver = d; }
function changed(id: string) {
	const r = getSubagent(id)!;
	const card = db.prepare("SELECT id FROM messages WHERE json_extract(meta, '$.subagentId') = ? AND json_extract(meta, '$.kind') = 'subagent'").get(id) as { id: string } | undefined;
	const tool = db.prepare("SELECT meta FROM messages WHERE subagent_id = ? AND role = 'tool' ORDER BY rowid DESC LIMIT 1").get(id) as { meta: string } | undefined;
	if (card) updateMessage(card.id, { meta: { subagent: r, currentStep: tool ? JSON.parse(tool.meta).toolName : undefined } });
	bus.emit({ type: "subagent.updated", subagent: r });
}
function addEvent(r: Subagent, kind: string, reason: string) {
	// 带上当时的终态代际（finished_at）：续聊后多次结束才能区分每一代的终态唤醒
	const gen = (db.prepare("SELECT finished_at FROM subagents WHERE id = ?").get(r.id) as { finished_at: number | null } | undefined)?.finished_at ?? 0;
	db.prepare("INSERT INTO subagent_events(id, subagent_id, kind, reason, created_at, generation) VALUES(?,?,?,?,?,?)").run(uid("se"), r.id, kind, reason, Date.now(), gen);
}
const hooks: StuckHooks = { event: addEvent, changed, restart: (id, note) => restartSubagent(id, note), fail: (id, reason) => void finishSubagent(id, "failed", reason) };
/** 所有结束路径共享这一处；状态和待投递事件一起提交。 */
export function finishSubagent(id: string, status: Exclude<SubagentStatus, "queued" | "running" | "stalled">, reason = "", summary = "") {
	const r0 = getSubagent(id), agentId = r0?.agent_id, sup = r0 && isLiveSubagent(r0.status) ? superviseFinish(r0, status, reason) : null;
	if (sup) reason = sup.reason;
	db.exec("BEGIN");
	try {
		const n = db.prepare(`UPDATE subagents SET status = ?, error_reason = ?, result_summary = ?, finished_at = ? WHERE id = ? AND status IN ${LIVE}`).run(status, status === "done" ? null : reason, summary, Date.now(), id).changes;
		if (n) addEvent(getSubagent(id)!, status, reason || summary);
		db.exec("COMMIT");
		if (!n) return false;
	} catch (e) { db.exec("ROLLBACK"); throw e; }
	changed(id);
	sup?.after();
	void deliverSubagentEvents();
	// 到终态就释放了一个并发名额：自动派发这个助理排队中的下一个
	if (agentId) pumpSubagents(agentId);
	return true;
}
const parsePendingInput = (raw: string | null): { text: string; messageId?: string } | undefined => {
	if (!raw) return undefined;
	try {
		const v = JSON.parse(raw);
		if (typeof v?.text !== "string") return undefined;
		return typeof v?.messageId === "string" ? { text: v.text, messageId: v.messageId } : { text: v.text };
	} catch { return undefined; }
};
const queuedAhead = (id: string, agentId: string) => {
	const row = db.prepare("SELECT rowid FROM subagents WHERE id = ?").get(id) as { rowid: number } | undefined;
	if (!row) return 0;
	return (db.prepare(`SELECT COUNT(*) n FROM subagents WHERE agent_id = ? AND status = 'queued' AND rowid < ?`).get(agentId, row.rowid) as { n: number }).n;
};
/** 把一条排队的子代理切到 running 并开始执行；只对仍是 queued 的行生效，避免重复派发。 */
function startQueued(id: string) {
	const r = getSubagent(id);
	if (!r || r.status !== "queued") return false;
	const ts = Date.now();
	const n = db.prepare("UPDATE subagents SET status = 'running', last_activity_at = ?, run_started_at = ?, resume = 0, pending_input = NULL WHERE id = ? AND status = 'queued'").run(ts, ts, id).changes;
	if (!n) return false;
	// 重启恢复（resume=1）/ 失败续跑（resume=2）：有落库 session 就从断点续跑（无 session 的已拒绝恢复）
	const input = r.resume === 2 ? { text: verifyResumePrompt(r.error_reason ?? r.result_summary, r.error_reason, sessionResumeSafety(r.session_file)) } : r.resume ? { text: RESTART_RESUME_PROMPT } : parsePendingInput(r.pending_input);
	live.set(id, { pending: [], toolUntil: 0 });
	changed(id);
	queueMicrotask(() => void run(id, input));
	return true;
}
/** 批量停止期间暂停这些助理的自动派发，避免「停 A → 释放名额 → 拉起 B → 再停 B」的短暂执行。 */
const dispatchPaused = new Map<string, number>();
const pauseDispatch = (agentId: string) => {
	dispatchPaused.set(agentId, (dispatchPaused.get(agentId) ?? 0) + 1);
	return () => {
		const left = (dispatchPaused.get(agentId) ?? 1) - 1;
		if (left > 0) dispatchPaused.set(agentId, left);
		else dispatchPaused.delete(agentId);
	};
};
/** 按每个助理的**有效**并发上限，把排队的子代理按先后顺序补上空位（各助理分别计数，不共用全局池）。 */
export function pumpSubagents(agentId?: string) {
	const agents = agentId ? [agentId] : (db.prepare("SELECT DISTINCT agent_id FROM subagents WHERE status = 'queued'").all() as { agent_id: string }[]).map((r) => r.agent_id);
	for (const a of agents) {
		if (dispatchPaused.has(a)) continue;
		const limit = getSubagentSettings(a).maxConcurrent;
		const free = limit - activeCount(a);
		if (free <= 0) continue;
		const queued = db.prepare(`SELECT id FROM subagents WHERE agent_id = ? AND status = 'queued' ORDER BY created_at, rowid LIMIT ?`).all(a, free) as { id: string }[];
		for (const q of queued) startQueued(q.id);
	}
}
export function spawnSubagent(agentId: string, conv: string, fallback: ModelRef, input: { task: string; context?: string; needs?: string[]; model?: ModelRef; thinking?: string; parentMessageId?: string; kind?: HelperKind; title?: string; routineRunId?: string; parentSubagentId?: string; scope?: string | null; workRunId?: string }): Subagent & { queuedAhead?: number } {
	if (!input.task?.trim()) throw new Error("请说明帮手任务");
	const parent = input.parentSubagentId ? getSubagent(input.parentSubagentId) : undefined; if (parent?.parent_subagent_id) throw new Error("帮手最多再派一层：你是第二层帮手，不能再派，自己做");
	if (input.thinking !== undefined && !isThinkingLevel(input.thinking)) throw new Error("思考强度不对");
	const picked = chooseSubagentModel(agentId, fallback, input.task, input.needs, input.model);
	const id = uid("sa"), ts = Date.now();
	// 先把已有的排队任务补上空位，保证 FIFO；再决定新任务是否立即跑
	pumpSubagents(agentId);
	const status: SubagentStatus = hasSubagentCapacity(agentId) ? "running" : "queued";
	db.prepare("INSERT INTO subagents(id, agent_id, conversation_id, parent_message_id, task, context, model_provider, model_id, model_reason, thinking, status, last_activity_at, created_at, model_pool, kind, title, routine_run_id, parent_subagent_id, scope, work_run_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, agentId, conv, input.parentMessageId ?? null, input.task, input.context ?? "", picked.model.provider, picked.model.id, picked.reason, input.thinking ?? null, status, ts, ts, JSON.stringify(picked.pool), input.kind ?? null, input.title ?? null, input.routineRunId ?? null, parent?.id ?? null, input.scope ?? parent?.scope ?? null, input.workRunId ?? null);
	insertMessage({ agentId, conversationId: conv, role: "card", meta: { kind: "subagent", subagentId: id, subagent: getSubagent(id) } });
	insertMessage({ agentId, conversationId: conv, subagentId: id, role: "user", content: input.task });
	if (status === "running") { live.set(id, { pending: [], toolUntil: 0 }); queueMicrotask(() => void run(id)); }
	const row = getSubagent(id)!;
	return status === "queued" ? { ...row, queuedAhead: queuedAhead(id, agentId) } : row;
}
async function run(id: string, input?: { text: string; messageId?: string }) {
	const finish = (st: "done" | "failed", reason = "", summary = "") => live.get(id)?.restart === undefined && finishSubagent(id, st, reason, summary);
	try {
		const result = await driver.run(getSubagent(id)!, (stop, message, apply) => {
			const l = live.get(id)!;
			l.stop = stop; l.message = message; l.apply = apply;
			if (!isActiveSubagent(getSubagent(id)!.status)) void stop();
			else queueMicrotask(() => { for (const p of l.pending.splice(0)) void message?.(p.text, p.messageId); });
		}, input);
		finish("done", "", result);
	} catch (e) { finish("failed", e instanceof Error ? e.message : String(e)); }
	finally {
		finish("failed", "帮手执行意外结束");
		const note = live.get(id)?.restart;
		live.delete(id);
		if (note !== undefined) requeueStuck(id, note);
	}
}
/** 卡住时由主会话（subagent_restart）或系统调用：中断这一轮，同一个帮手带纠正从最近检查点续跑，不算结束。 */
export async function restartSubagent(id: string, note: string) {
	const l = live.get(id);
	if (!l?.stop || !isActiveSubagent(getSubagent(id)?.status ?? "")) return false;
	l.restart = note;
	await l.stop();
	return true;
}
function requeueStuck(id: string, note: string) {
	const r = getSubagent(id);
	if (!r) return;
	const text = stuckRestartPrompt(note, sessionResumeSafety(r.session_file)); // 中断后会话已落盘：结果未知的工具会列出来先核验
	db.prepare(`UPDATE subagents SET status = 'queued', resume = 0, pending_input = ?, attempt = COALESCE(attempt, 0) + 1, last_activity_at = ? WHERE id = ? AND status IN ${LIVE}`).run(JSON.stringify({ text }), Date.now(), id);
	changed(id);
	pumpSubagents(r.agent_id);
}
export async function stopSubagent(id: string, status: "stopped" | "timeout" = "stopped") {
	const r = getSubagent(id);
	if (!r || !isLiveSubagent(r.status)) return false;
	const input = parsePendingInput(r.pending_input);
	finishSubagent(id, status, status === "timeout" ? "已超过最长运行时间" : "用户或主会话停止了任务");
	// 排队中被停：把还没发出去的续聊消息标为已停止，不偷偷补跑
	if (input?.messageId) updateMessage(input.messageId, { meta: { delivery: "stopped" } });
	requests.cancelForTask(id);
	await live.get(id)?.stop?.();
	return true;
}
export async function stopAgentSubagents(agentId: string) {
	// 停整个助理时先暂停派发：否则每停一个都会释放名额、把排队的下一个拉起来（不该执行的任务被短暂启动）
	const release = pauseDispatch(agentId);
	try {
		for (;;) {
			const rows = liveSubagents(agentId);
			if (!rows.length) return;
			for (const r of rows) await stopSubagent(r.id);
		}
	} finally {
		release();
	}
}
/** 只收拢一个会话的子代理：群任务暂停不能误停该助理在私聊/别群的工作。 */
export async function stopConversationSubagents(agentId: string, conversationId: string) {
	const release = pauseDispatch(agentId);
	try {
		for (const r of liveSubagents(agentId).filter((r) => r.conversation_id === conversationId)) await stopSubagent(r.id);
	} finally {
		release();
		pumpSubagents(agentId);
	}
}
export { withResumeInfo, listSubagentSummaries } from "./subagent-resume-info.ts";
/**
 * 用**原子代理 id**继续：不新开子代理、不新建任务，复用落库的 Pi session 从断点续跑。
 * - 只对已到终态、非 done、且落库了 session 的行生效；重复调用只生效一次（原子占用，状态一变为 queued 就拒绝第二次）。
 * - 满额时按既有 FIFO 进排队，不超并发；恢复仍算同一个任务、同一份用量与历史。
 * - mode="auto" 仅用于系统自动重试：只有连接类 / 服务临时不可用才会被接受；用户停止、权限拒绝、未知错误一律拒绝。
 */
export function resumeSubagent(id: string, opts: { mode?: "auto" | "manual" } = {}): Subagent {
	const r = getSubagent(id);
	if (!r) throw new Error("帮手不存在");
	if (isLiveSubagent(r.status)) throw new Error("帮手正在运行或排队，无需继续");
	if (r.status === "done") throw new Error("帮手已完成，无需继续");
	const info = classifyResume(r.error_reason ?? r.result_summary ?? "");
	if (!info.manual) throw new Error(`这个失败不能继续：${info.label}`);
	const blocked = repeatBlocked(r);
	if (blocked) throw new Error(blocked);
	if (opts.mode === "auto" && !info.auto) throw new Error(`这个失败不能自动继续：${info.label}`);
	if (!r.session_file) throw new Error("没有落库会话，无法确认执行到哪一步；请先核验工作区再重新派活");
	// 自动重试前必须证明没有「已派发、结果未落库」的工具调用；结果未知就不自动重放，交人工/主模型核验
	const safety = sessionResumeSafety(r.session_file);
	if (opts.mode === "auto" && !safety.safe) throw new Error(`不能自动继续：${safety.reason}`);
	// 原子占用：状态仍非 live 才置为 queued（resume=2 表示失败续跑），attempt 计数 +1
	const ts = Date.now();
	const n = db.prepare(`UPDATE subagents SET status = 'queued', resume = 2, attempt = COALESCE(attempt, 0) + 1, retry_at = NULL, last_activity_at = ? WHERE id = ? AND status NOT IN ${LIVE}`).run(ts, id).changes;
	if (!n) throw new Error("帮手状态已变化，请稍后重试");
	changed(id);
	pumpSubagents(r.agent_id);
	return getSubagent(id)!;
}
/** 标记 / 清除「正在等待退避重试」的下一次时间；只更新卡片，不触发模型回合（不产生 wake 风暴）。 */
export function setSubagentRetryAt(id: string, at: number | null) {
	const r = getSubagent(id);
	if (!r) return;
	db.prepare("UPDATE subagents SET retry_at = ? WHERE id = ?").run(at, id);
	changed(id);
}
export async function messageSubagent(id: string, text: string, messageId?: string) {
	const r = getSubagent(id), l = live.get(id);
	if (!r || !isActiveSubagent(r.status) || !l) throw new Error("帮手已结束");
	if (messageId) updateMessage(messageId, { meta: { routedTo: id, delivery: "queued" } });
	if (l.message) await l.message(text, messageId);
	else l.pending.push({ text, messageId });
}
/** 子窗口的用户消息留在子会话；续聊重新加载同一个 Pi session。 */
export async function sendSubagentMessage(id: string, text: string) {
	const r = getSubagent(id);
	if (!r) throw new Error("帮手不存在");
	text = text.trim();
	if (!text) throw new Error("请输入消息");
	const stopping = isStopCommand(text);
	if (r.status === "queued" && !stopping) throw new Error("帮手正在排队，等它开始后再补充");
	if (!isLiveSubagent(r.status) && !stopping && live.has(id)) throw new Error("帮手正在停止，请稍后再发");
	const m = insertMessage({ agentId: r.agent_id, conversationId: r.conversation_id, subagentId: id, role: "user", content: text });
	if (stopping) {
		await stopSubagent(id);
		updateMessage(m.id, { meta: { delivery: "stop" } });
	} else if (isActiveSubagent(r.status)) await messageSubagent(id, text, m.id);
	else {
		// 先把已有排队任务补上空位，保证 FIFO
		pumpSubagents(r.agent_id);
		if (hasSubagentCapacity(r.agent_id)) {
			const ts = Date.now();
			db.prepare("UPDATE subagents SET status = 'running', last_activity_at = ?, run_started_at = ?, finished_at = NULL, error_reason = NULL, result_summary = NULL, attempt = COALESCE(attempt, 0) + 1 WHERE id = ?").run(ts, ts, id);
			live.set(id, { pending: [], toolUntil: 0 });
			changed(id);
			queueMicrotask(() => void run(id, { text, messageId: m.id }));
		} else {
			// 满额：排队并持久化这一轮输入，释放名额后按顺序继续
			db.prepare("UPDATE subagents SET status = 'queued', pending_input = ?, finished_at = NULL, error_reason = NULL, result_summary = NULL, attempt = COALESCE(attempt, 0) + 1 WHERE id = ?").run(JSON.stringify({ text, messageId: m.id }), id);
			changed(id);
		}
	}
	return m;
}
export function subagentActivity(id: string, toolMs?: number) {
	const r = getSubagent(id);
	if (!r || !isActiveSubagent(r.status)) return;
	const ts = Date.now();
	if (toolMs !== undefined && live.has(id)) live.get(id)!.toolUntil = toolMs ? ts + toolMs + Math.min(30_000, SUBAGENT_STALL_MS()) : 0;
	if (r.status === "stalled") {
		db.prepare("UPDATE subagents SET status = 'running', last_activity_at = ? WHERE id = ?").run(ts, id);
		addEvent(r, "resumed", "帮手恢复活动了");
		changed(id);
	} else if (ts - r.last_activity_at >= Math.min(5000, SUBAGENT_STALL_MS() / 3)) {
		db.prepare("UPDATE subagents SET last_activity_at = ? WHERE id = ?").run(ts, id);
		changed(id);
	}
	if (toolMs !== undefined) changed(id);
}
export async function checkSubagents(ts = Date.now()) {
	// 兜底：即使某次 finish 后没派发，也定期把排队的补上
	pumpSubagents();
	for (const r of activeSubagents()) {
		if (ts - (r.run_started_at ?? r.created_at) >= getSubagentSettings(r.agent_id).maxMinutes * 60_000) await stopSubagent(r.id, "timeout");
		else await superviseStall(r, ts, live.get(r.id)?.toolUntil ?? 0, hooks);
	}
	await deliverSubagentEvents();
}
const delivering = new Set<string>();
/** 会触发一次模型回合的事件：终态 + 停滞告警。`resumed` 只更新卡片（changed 已做），不再单独唤醒。 */
const WAKE_KINDS = new Set(["done", "failed", "stopped", "timeout", "lost", "stalled"]);
/** 终态：可能已由一条 task_wait 负责唤醒，需要跨机制去重。 */
const TERMINAL_KINDS = new Set(["done", "failed", "stopped", "timeout", "lost"]);
export async function deliverSubagentEvents() {
	if (!driver) return;
	const events = db.prepare("SELECT * FROM subagent_events WHERE delivered_at IS NULL ORDER BY created_at, rowid").all() as unknown as SubagentEvent[];
	for (const e of events) {
		if (delivering.has(e.id)) continue;
		const r = getSubagent(e.subagent_id);
		if (!r || !db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(r.conversation_id)) continue;
		// resumed 只更新卡片，不再起一次模型回合：直接标记已投递，避免每 30 秒重试
		if (!WAKE_KINDS.has(e.kind) || r.kind || r.parent_subagent_id) { // 下一层帮手的结果由上一层帮手收（subagent-driver）
			markSubagentEventDelivered(e.id, r.id);
			continue;
		}
		// 晚到的旧代际终态：子代理已进入新一轮（live）或已产生更新的终态 → 只收尾不唤醒，避免旧 attempt 覆盖新的。
		if (TERMINAL_KINDS.has(e.kind) && (isLiveSubagent(r.status) || (r.finished_at ?? 0) > (e.generation ?? 0))) {
			markSubagentEventDelivered(e.id, r.id);
			continue;
		}
		// 跨机制去重：终态事件与 task_wait 共抢一个持久 owner（claim），保证正常并发下只唤醒一次模型。
		// 先看已有等待（waiting / fired-pending）是否已经为这一代终态负责：是就让位给等待路径投递。
		// 否则原子抢 claim：抢不到（另一机制正在投递）就等下一轮；已送达就只收尾。
		let claimKey: string | null = null;
		if (TERMINAL_KINDS.has(e.kind)) {
			const gen = e.generation ?? r.finished_at ?? 0;
			const owner = subagentWakeOwner(r.id, r.agent_id, r.conversation_id, gen);
			if (owner === "delivered") { markSubagentEventDelivered(e.id, r.id); continue; }
			if (owner === "pending") continue;
			const c = claimSubagentWake(r.id, r.agent_id, r.conversation_id, gen, "notify", e.id);
			if (c === "delivered") { markSubagentEventDelivered(e.id, r.id); continue; }
			if (c === "yield") continue;
			claimKey = wakeClaimKey(r.id, r.agent_id, r.conversation_id, gen);
		}
		delivering.add(e.id);
		void driver.notify(r, e).then(() => {
			if (claimKey) markSubagentWakeDelivered(claimKey, "notify");
			markSubagentEventDelivered(e.id, r.id);
		}).catch((err) => {
			// 投递失败：释放 claim，让等待路径补位（终态不丢）
			if (claimKey) releaseSubagentWake(claimKey, "notify");
			console.warn("[subagent] 通知待重试", String(err));
		}).finally(() => delivering.delete(e.id));
	}
}
/** 事件已投递的收尾（事件标记 + 子代理 notified_at）：无论由 notify 还是等待路径唤醒，都走这里。 */
function markSubagentEventDelivered(eventId: string, subagentId: string) {
	db.prepare("UPDATE subagent_events SET delivered_at = ? WHERE id = ?").run(Date.now(), eventId);
	db.prepare("UPDATE subagents SET notified_at = ? WHERE id = ?").run(Date.now(), subagentId);
}
/** 本进程已恢复过的子代理：重复调用不会把已续跑的任务再次入队（幂等）。 */
const recovered = new Set<string>();
export function recoverSubagents() {
	// 运行中被重启打断：保留任务、已完成的工具结果和 session_file，重新排队从断点续跑
	const interrupted = activeSubagents().filter((r) => !recovered.has(r.id));
	const ts = Date.now();
	for (const r of interrupted) {
		recovered.add(r.id);
		if (r.session_file) {
			// 重启打断时工具可能已派发、结果未落库：结果未知就不能自动续跑，标 lost 要求核验
			const safety = sessionResumeSafety(r.session_file);
			if (!safety.safe) {
				finishSubagent(r.id, "lost", `服务重启，且${safety.reason}`);
				continue;
			}
			db.prepare(`UPDATE subagents SET status = 'queued', resume = 1, last_activity_at = ? WHERE id = ? AND status IN ${ACTIVE}`).run(ts, r.id);
			changed(r.id);
		} else {
			// 没落库会话，无法确认已经执行到哪一步，不能假装没副作用从头重跑：标 lost，明确要求核验
			finishSubagent(r.id, "lost", "服务重启，且这个帮手还没落库会话，无法确认已执行到哪一步；请核验工作区后重新派活");
		}
	}
	// 排队的任务（含刚恢复的）按容量派发；已取消 / 已停止的不在 active 里，不会被恢复
	pumpSubagents();
}
export function startSubagentWatcher() {
	const timer = setInterval(() => void checkSubagents().catch(console.error), Math.min(30_000, Math.max(1_000, SUBAGENT_STALL_MS() / 3)));
	timer.unref();
}
