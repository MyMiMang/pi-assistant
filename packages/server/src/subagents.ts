/** DESIGN §21：子代理状态与完成通知落库，执行仍复用 runtime 的 Pi 会话。 */
import { bus } from "./bus.ts";
import { db, getSetting, setSetting, uid } from "./db.ts";
import { insertMessage, updateMessage } from "./messages.ts";
import { isStopCommand } from "./interject.ts";
import { configuredModels, modelProfiles } from "./rooms/model-pick.ts";
import { inferNeeds, pickModel } from "./model-profile.ts";
import { isRecoverableModelError } from "./model-errors.ts";
import { requests } from "./requests.ts";
import { claimSubagentWake, markSubagentWakeDelivered, releaseSubagentWake, subagentWakeOwner, wakeClaimKey } from "./task-waits.ts";

export type ModelRef = { provider: string; id: string };
export type SubagentStatus = "queued" | "running" | "stalled" | "done" | "failed" | "stopped" | "timeout" | "lost";
export interface Subagent {
	id: string; agent_id: string; conversation_id: string; parent_message_id: string | null;
	task: string; context: string; model_provider: string; model_id: string; model_reason: string;
	status: SubagentStatus; last_activity_at: number; error_reason: string | null; notified_at: number | null;
	result_summary: string | null; created_at: number; finished_at: number | null;
	session_file: string | null; run_started_at: number | null; pending_input: string | null; resume: number | null;
	/** 派活时解析出的候选模型顺序（JSON 数组，第一项是实际用的；池内 fallback 按这个顺序，空 = 只跟随主会话）。 */
	model_pool: string | null;
}
export interface SubagentEvent { id: string; subagent_id: string; kind: string; reason: string; created_at: number; delivered_at: number | null; /** 终态代际（= 当时的 finished_at）：同一子代理续聊多次结束时区分每一代唤醒 */ generation: number | null }
/** 全局子代理设置只保留任务侧参数：并发上限与最长运行时间。子代理模型改由每个助理的候选池决定（见 DESIGN §21.5）。 */
export interface SubagentSettings { maxMinutes: number; maxConcurrent: number }
/** 保存设置时的入参：两个字段都可省略 —— 省略时保留当前值，绝不重置（旧客户端 / 只改一项的界面不传另一个字段）。 */
export type SubagentSettingsInput = { maxMinutes?: number; maxConcurrent?: number };
/** 助理级：候选模型池。空池 = 跟随主会话当前模型。 */
export type AgentSubagentPool = { pool: ModelRef[] };
/** @deprecated 旧助理级设置形状，仅为兼容旧客户端保留，读写都会转成候选池。 */
export type AgentSubagentChoice = { mode: "follow" } | { mode: "fixed"; model: ModelRef };
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
for (const [name, type] of [["session_file", "TEXT"], ["run_started_at", "INTEGER"], ["pending_input", "TEXT"], ["resume", "INTEGER"], ["model_pool", "TEXT"]]) {
	if (!columns.some((c) => c.name === name)) db.exec(`ALTER TABLE subagents ADD COLUMN ${name} ${type}`);
}
// 事件记录当时的终态代际：同一子代理续聊后多次结束时，用每一代自己的 finished_at 去重
if (!(db.prepare("PRAGMA table_info(subagent_events)").all() as { name: string }[]).some((c) => c.name === "generation")) db.exec("ALTER TABLE subagent_events ADD COLUMN generation INTEGER");
export const getSubagent = (id: string) => db.prepare("SELECT * FROM subagents WHERE id = ?").get(id) as Subagent | undefined;
export const listSubagents = (agentId?: string, conv?: string) => db.prepare(`SELECT * FROM subagents${conv ? " WHERE conversation_id = ?" : agentId ? " WHERE agent_id = ?" : ""} ORDER BY created_at DESC LIMIT 100`).all(...(conv ? [conv] : agentId ? [agentId] : [])) as unknown as Subagent[];
const activeSubagents = (agentId?: string) => db.prepare(`SELECT * FROM subagents WHERE status IN ${ACTIVE}${agentId ? " AND agent_id = ?" : ""}`).all(...(agentId ? [agentId] : [])) as unknown as Subagent[];
const liveSubagents = (agentId?: string) => db.prepare(`SELECT * FROM subagents WHERE status IN ${LIVE}${agentId ? " AND agent_id = ?" : ""}`).all(...(agentId ? [agentId] : [])) as unknown as Subagent[];
const activeCount = (agentId: string) => (db.prepare(`SELECT COUNT(*) n FROM subagents WHERE agent_id = ? AND status IN ${ACTIVE}`).get(agentId) as { n: number }).n;
/** 这个助理还有没有空位跑新子代理（按助理计算）。 */
export const hasSubagentCapacity = (agentId: string) => activeCount(agentId) < subagentSettings().maxConcurrent;
const clampConcurrent = (n: unknown) => {
	const v = Math.round(Number(n));
	return Number.isFinite(v) ? Math.min(SUBAGENT_CONCURRENCY.max, Math.max(SUBAGENT_CONCURRENCY.min, v)) : SUBAGENT_CONCURRENCY.default;
};
/** 读取全局子代理设置；兼容旧库里没有 maxConcurrent 的记录，并忽略已废弃的模型指定/挑选字段。 */
export const subagentSettings = (): SubagentSettings => {
	const raw = getSetting<Partial<SubagentSettings>>("subagentModels", {});
	return {
		maxMinutes: raw.maxMinutes && raw.maxMinutes > 0 ? raw.maxMinutes : 60,
		maxConcurrent: clampConcurrent(raw.maxConcurrent),
	};
};
export const modelKey = (m: ModelRef) => `${m.provider}/${m.id}`;
/**
 * 池内 fallback 决策（纯函数，便于单测）：只有明确可恢复的模型故障才换，且只换还没试过的候选。
 * 工具 / 命令失败、权限拒绝、未知错误都不是模型故障 → 返回 null（不换模型）。用尽候选也返回 null。
 */
export function planFallback(candidates: ModelRef[], tried: Iterable<string>, error?: string | null): ModelRef | null {
	if (!isRecoverableModelError(error)) return null;
	const t = new Set(tried);
	return candidates.find((m) => !t.has(modelKey(m))) ?? null;
}
const asRefs = (x: unknown): ModelRef[] =>
	Array.isArray(x)
		? x.flatMap((m) => (m && typeof m === "object" && "provider" in m && "id" in m ? [{ provider: String((m as ModelRef).provider), id: String((m as ModelRef).id) }] : []))
		: [];
/** 把库里的旧格式 / 新格式统一读成候选池：新格式 `{pool}`；旧「固定一个模型」= 单项池；旧「跟随」= 空池。 */
export function normalizeAgentPool(v: unknown): ModelRef[] {
	if (!v || typeof v !== "object") return [];
	const o = v as { pool?: unknown; mode?: string; model?: unknown };
	if (Array.isArray(o.pool)) return asRefs(o.pool);
	if (o.mode === "fixed") return asRefs([o.model]);
	return [];
}
export const agentSubagentPool = (id: string): ModelRef[] => normalizeAgentPool(getSetting<unknown>(`subagentModel:${id}`, null));
function requireModel(m: ModelRef | undefined) {
	if (!m || !configuredModels().some((x) => x.provider === m.provider && x.id === m.id)) throw new Error("模型尚未配置");
	return { provider: m.provider, id: m.id };
}
/** 只保留当前仍然配置着的模型（服务被删 / 模型下线后，池里的悬空项不参与挑选与 fallback）。 */
export const livePool = (pool: ModelRef[]): ModelRef[] => pool.filter((m) => configuredModels().some((x) => x.provider === m.provider && x.id === m.id)).map((m) => ({ provider: m.provider, id: m.id }));
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
/** 保存助理的候选池；空池 = 跟随主会话当前模型。 */
export function saveAgentSubagentPool(id: string, input: { pool?: ModelRef[] }): AgentSubagentPool {
	const pool = (input?.pool ?? []).map(requireModel);
	const c: AgentSubagentPool = { pool };
	setSetting(`subagentModel:${id}`, c);
	return c;
}
/** @deprecated 兼容旧客户端：旧的 follow/fixed 形状转成候选池。 */
export function saveAgentSubagentChoice(id: string, choice: AgentSubagentChoice) {
	return saveAgentSubagentPool(id, { pool: choice?.mode === "fixed" && choice.model ? [choice.model] : [] });
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
		if (explicit && modelKey(explicit) !== modelKey(follow)) throw new Error("这个助理没有设置候选池，子代理只能跟随主会话模型");
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

interface Live { stop?: () => Promise<void>; message?: (text: string, messageId?: string) => Promise<void>; pending: { text: string; messageId?: string }[]; toolUntil: number }
const live = new Map<string, Live>();
interface Driver {
	run(r: Subagent, connect: (stop: () => Promise<void>, message: Live["message"]) => void, input?: { text: string; messageId?: string }): Promise<string>;
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
/** 所有结束路径共享这一处；状态和待投递事件一起提交。 */
export function finishSubagent(id: string, status: Exclude<SubagentStatus, "queued" | "running" | "stalled">, reason = "", summary = "") {
	const agentId = getSubagent(id)?.agent_id;
	db.exec("BEGIN");
	try {
		const n = db.prepare(`UPDATE subagents SET status = ?, error_reason = ?, result_summary = ?, finished_at = ? WHERE id = ? AND status IN ${LIVE}`).run(status, status === "done" ? null : reason, summary, Date.now(), id).changes;
		if (n) addEvent(getSubagent(id)!, status, reason || summary);
		db.exec("COMMIT");
		if (!n) return false;
	} catch (e) { db.exec("ROLLBACK"); throw e; }
	changed(id);
	void deliverSubagentEvents();
	// 到终态就释放了一个并发名额：自动派发这个助理排队中的下一个
	if (agentId) pumpSubagents(agentId);
	return true;
}
const parsePendingInput = (raw: string | null): { text: string; messageId: string } | undefined => {
	if (!raw) return undefined;
	try { const v = JSON.parse(raw); return typeof v?.text === "string" && typeof v?.messageId === "string" ? v : undefined; } catch { return undefined; }
};
const queuedAhead = (id: string, agentId: string) => {
	const row = db.prepare("SELECT rowid FROM subagents WHERE id = ?").get(id) as { rowid: number } | undefined;
	if (!row) return 0;
	return (db.prepare(`SELECT COUNT(*) n FROM subagents WHERE agent_id = ? AND status = 'queued' AND rowid < ?`).get(agentId, row.rowid) as { n: number }).n;
};
/** 重启后恢复任务的续跑提示：先核验进度，不从头重做、不重复副作用。 */
const SUBAGENT_RESUME_PROMPT = "（系统通知）服务刚刚重启，上一轮子代理执行被中断了。请先检查工作区里已经完成的进度和产出，确认哪些步骤已经做完、哪些没做完，然后从断点继续完成剩余任务。已经完成的步骤不要重做，也不要重复已经产生的副作用；某个操作在重启时状态不明（可能已执行也可能没执行）的，先核实实际结果再决定，不要盲目重跑。完成后简要总结结果。";
/** 把一条排队的子代理切到 running 并开始执行；只对仍是 queued 的行生效，避免重复派发。 */
function startQueued(id: string) {
	const r = getSubagent(id);
	if (!r || r.status !== "queued") return false;
	const ts = Date.now();
	const n = db.prepare("UPDATE subagents SET status = 'running', last_activity_at = ?, run_started_at = ?, resume = 0, pending_input = NULL WHERE id = ? AND status = 'queued'").run(ts, ts, id).changes;
	if (!n) return false;
	// 重启恢复的任务：有落库 session 就从断点续跑（无 session 的在 recoverSubagents 里已标 lost）
	const input = r.resume ? { text: SUBAGENT_RESUME_PROMPT } : parsePendingInput(r.pending_input);
	live.set(id, { pending: [], toolUntil: 0 });
	changed(id);
	queueMicrotask(() => void run(id, input));
	return true;
}
/** 批量停止期间暂停这些助理的自动派发，避免「停 A → 释放名额 → 拉起 B → 再停 B」的短暂执行。 */
const dispatchPaused = new Set<string>();
/** 按每个助理的并发上限，把排队的子代理按先后顺序补上空位。 */
export function pumpSubagents(agentId?: string) {
	const limit = subagentSettings().maxConcurrent;
	const agents = agentId ? [agentId] : (db.prepare("SELECT DISTINCT agent_id FROM subagents WHERE status = 'queued'").all() as { agent_id: string }[]).map((r) => r.agent_id);
	for (const a of agents) {
		if (dispatchPaused.has(a)) continue;
		const free = limit - activeCount(a);
		if (free <= 0) continue;
		const queued = db.prepare(`SELECT id FROM subagents WHERE agent_id = ? AND status = 'queued' ORDER BY created_at, rowid LIMIT ?`).all(a, free) as { id: string }[];
		for (const q of queued) startQueued(q.id);
	}
}
export function spawnSubagent(agentId: string, conv: string, fallback: ModelRef, input: { task: string; context?: string; needs?: string[]; model?: ModelRef; parentMessageId?: string }): Subagent & { queuedAhead?: number } {
	if (!input.task?.trim()) throw new Error("请说明子代理任务");
	const picked = chooseSubagentModel(agentId, fallback, input.task, input.needs, input.model);
	const id = uid("sa"), ts = Date.now();
	// 先把已有的排队任务补上空位，保证 FIFO；再决定新任务是否立即跑
	pumpSubagents(agentId);
	const status: SubagentStatus = hasSubagentCapacity(agentId) ? "running" : "queued";
	db.prepare("INSERT INTO subagents(id, agent_id, conversation_id, parent_message_id, task, context, model_provider, model_id, model_reason, status, last_activity_at, created_at, model_pool) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, agentId, conv, input.parentMessageId ?? null, input.task, input.context ?? "", picked.model.provider, picked.model.id, picked.reason, status, ts, ts, JSON.stringify(picked.pool));
	insertMessage({ agentId, conversationId: conv, role: "card", meta: { kind: "subagent", subagentId: id, subagent: getSubagent(id) } });
	insertMessage({ agentId, conversationId: conv, subagentId: id, role: "user", content: input.task });
	if (status === "running") { live.set(id, { pending: [], toolUntil: 0 }); queueMicrotask(() => void run(id)); }
	const row = getSubagent(id)!;
	return status === "queued" ? { ...row, queuedAhead: queuedAhead(id, agentId) } : row;
}
async function run(id: string, input?: { text: string; messageId?: string }) {
	try {
		const result = await driver.run(getSubagent(id)!, (stop, message) => {
			const l = live.get(id)!;
			l.stop = stop; l.message = message;
			if (!isActiveSubagent(getSubagent(id)!.status)) void stop();
			else queueMicrotask(() => { for (const p of l.pending.splice(0)) void message?.(p.text, p.messageId); });
		}, input);
		finishSubagent(id, "done", "", result);
	} catch (e) { finishSubagent(id, "failed", e instanceof Error ? e.message : String(e)); }
	finally {
		finishSubagent(id, "failed", "子代理执行意外结束");
		live.delete(id);
	}
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
	dispatchPaused.add(agentId);
	try {
		for (;;) {
			const rows = liveSubagents(agentId);
			if (!rows.length) return;
			for (const r of rows) await stopSubagent(r.id);
		}
	} finally {
		dispatchPaused.delete(agentId);
	}
}
export async function messageSubagent(id: string, text: string, messageId?: string) {
	const r = getSubagent(id), l = live.get(id);
	if (!r || !isActiveSubagent(r.status) || !l) throw new Error("子代理已结束");
	if (messageId) updateMessage(messageId, { meta: { routedTo: id, delivery: "queued" } });
	if (l.message) await l.message(text, messageId);
	else l.pending.push({ text, messageId });
}
/** 子窗口的用户消息留在子会话；续聊重新加载同一个 Pi session。 */
export async function sendSubagentMessage(id: string, text: string) {
	const r = getSubagent(id);
	if (!r) throw new Error("子代理不存在");
	text = text.trim();
	if (!text) throw new Error("请输入消息");
	const stopping = isStopCommand(text);
	if (r.status === "queued" && !stopping) throw new Error("子代理正在排队，等它开始后再补充");
	if (!isLiveSubagent(r.status) && !stopping && live.has(id)) throw new Error("子代理正在停止，请稍后再发");
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
			db.prepare("UPDATE subagents SET status = 'running', last_activity_at = ?, run_started_at = ?, finished_at = NULL, error_reason = NULL, result_summary = NULL WHERE id = ?").run(ts, ts, id);
			live.set(id, { pending: [], toolUntil: 0 });
			changed(id);
			queueMicrotask(() => void run(id, { text, messageId: m.id }));
		} else {
			// 满额：排队并持久化这一轮输入，释放名额后按顺序继续
			db.prepare("UPDATE subagents SET status = 'queued', pending_input = ?, finished_at = NULL, error_reason = NULL, result_summary = NULL WHERE id = ?").run(JSON.stringify({ text, messageId: m.id }), id);
			changed(id);
		}
	}
	return m;
}
export function subagentActivity(id: string, toolMs?: number) {
	const r = getSubagent(id);
	if (!r || !isActiveSubagent(r.status)) return;
	const ts = Date.now();
	if (toolMs !== undefined && live.has(id)) live.get(id)!.toolUntil = toolMs ? ts + toolMs + 30_000 : 0;
	if (r.status === "stalled") {
		db.prepare("UPDATE subagents SET status = 'running', last_activity_at = ? WHERE id = ?").run(ts, id);
		addEvent(r, "resumed", "子代理恢复活动了");
		changed(id);
	} else if (ts - r.last_activity_at >= 5000) {
		db.prepare("UPDATE subagents SET last_activity_at = ? WHERE id = ?").run(ts, id);
		changed(id);
	}
	if (toolMs !== undefined) changed(id);
}
export async function checkSubagents(ts = Date.now()) {
	// 兜底：即使某次 finish 后没派发，也定期把排队的补上
	pumpSubagents();
	for (const r of activeSubagents()) {
		if (ts - (r.run_started_at ?? r.created_at) >= subagentSettings().maxMinutes * 60_000) await stopSubagent(r.id, "timeout");
		else if (r.status === "running" && ts - r.last_activity_at > 180_000 && ts > (live.get(r.id)?.toolUntil ?? 0) && !db.prepare("SELECT 1 FROM requests WHERE task_id = ? AND status = 'pending'").get(r.id)) {
			db.prepare("UPDATE subagents SET status = 'stalled' WHERE id = ?").run(r.id);
			addEvent(r, "stalled", "子代理已 3 分钟没有进展，请检查或重新派活");
			changed(r.id);
		}
	}
	await deliverSubagentEvents();
}
const delivering = new Set<string>();
/** 会触发一次模型回合的事件：终态 + 停滞告警。`resumed` 只更新卡片（changed 已做），不再单独唤醒。 */
const WAKE_KINDS = new Set(["done", "failed", "stopped", "timeout", "lost", "stalled"]);
/** 终态：可能已由一条 task_wait 负责唤醒，需要跨机制去重。 */
const TERMINAL_KINDS = new Set(["done", "failed", "stopped", "timeout", "lost"]);
const clip = (s: string, n: number) => {
	const v = (s ?? "").replace(/\s+/g, " ").trim();
	return v.length > n ? `${v.slice(0, n)}…` : v;
};
/** notify 摘要的截断长度：完整内容用 subagent_list 按 id 查，不重复整段 task/结果（省 token）。 */
export const SUBAGENT_SUMMARY_CLIP = 300;
/**
 * 子代理事件通知的短文案（纯函数，便于单测）：标题 / 摘要都截断；
 * 摘要被截断时明确给出「按子代理 ID 查全文」的入口，避免模型以为已经看全。
 */
export function subagentNotifyText(r: Subagent, event: SubagentEvent, artifacts: string): string {
	const marker = `（子代理事件 ${event.id}）`;
	const kindLabel = ({ done: "已完成", failed: "失败", stopped: "已停止", timeout: "超时", lost: "中断待核验", stalled: "停滞" } as Record<string, string>)[event.kind] ?? event.kind;
	const title = clip(r.task, 60);
	const raw = r.result_summary || event.reason || "";
	const summary = clip(raw, SUBAGENT_SUMMARY_CLIP);
	const clipped = raw.replace(/\s+/g, " ").trim().length > SUBAGENT_SUMMARY_CLIP;
	return [
		`${marker}子代理「${title}」${kindLabel}${summary ? `：${summary}` : ""}`,
		`子代理 ID：${r.id}。${clipped ? `上面摘要已截断到 ${SUBAGENT_SUMMARY_CLIP} 字；` : ""}需要完整任务说明或结果时，用 subagent_list 按子代理 ID 查全文（subagent_list{subagent_id:"${r.id}"}）。`,
		`产出文件：\n${artifacts || "无"}`,
		"请核验产出后向用户简短汇报结果；失败、停止或没进展也要说明原因和下一步。停止后只汇报状态，不继续原任务。",
	].join("\n");
}
export async function deliverSubagentEvents() {
	if (!driver) return;
	const events = db.prepare("SELECT * FROM subagent_events WHERE delivered_at IS NULL ORDER BY created_at, rowid").all() as unknown as SubagentEvent[];
	for (const e of events) {
		if (delivering.has(e.id)) continue;
		const r = getSubagent(e.subagent_id);
		if (!r || !db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(r.conversation_id)) continue;
		// resumed 只更新卡片，不再起一次模型回合：直接标记已投递，避免每 30 秒重试
		if (!WAKE_KINDS.has(e.kind)) {
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
			db.prepare(`UPDATE subagents SET status = 'queued', resume = 1, last_activity_at = ? WHERE id = ? AND status IN ${ACTIVE}`).run(ts, r.id);
			changed(r.id);
		} else {
			// 没落库会话，无法确认已经执行到哪一步，不能假装没副作用从头重跑：标 lost，明确要求核验
			finishSubagent(r.id, "lost", "服务重启，且这个子代理还没落库会话，无法确认已执行到哪一步；请核验工作区后重新派活");
		}
	}
	// 排队的任务（含刚恢复的）按容量派发；已取消 / 已停止的不在 active 里，不会被恢复
	pumpSubagents();
}
export function startSubagentWatcher() {
	const timer = setInterval(() => void checkSubagents().catch(console.error), 30_000);
	timer.unref();
}
