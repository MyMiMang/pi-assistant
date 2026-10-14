/** DESIGN §21：子代理状态与完成通知落库，执行仍复用 runtime 的 Pi 会话。 */
import { bus } from "./bus.ts";
import { db, getSetting, setSetting, uid } from "./db.ts";
import { insertMessage, updateMessage } from "./messages.ts";
import { isStopCommand } from "./interject.ts";
import { configuredModels, modelProfiles } from "./rooms/model-pick.ts";
import { inferNeeds, pickModel } from "./model-profile.ts";
import { requests } from "./requests.ts";

export type ModelRef = { provider: string; id: string };
export type SubagentStatus = "running" | "stalled" | "done" | "failed" | "stopped" | "timeout" | "lost";
export interface Subagent {
	id: string; agent_id: string; conversation_id: string; parent_message_id: string | null;
	task: string; context: string; model_provider: string; model_id: string; model_reason: string;
	status: SubagentStatus; last_activity_at: number; error_reason: string | null; notified_at: number | null;
	result_summary: string | null; created_at: number; finished_at: number | null;
	session_file: string | null; run_started_at: number | null;
}
export interface SubagentEvent { id: string; subagent_id: string; kind: string; reason: string; created_at: number; delivered_at: number | null }
export interface SubagentSettings { mode: "follow" | "auto" | "fixed"; allowed: ModelRef[]; model?: ModelRef; maxMinutes: number }
export type AgentSubagentChoice = { mode: "follow" } | { mode: "fixed"; model: ModelRef };
const ACTIVE = "('running','stalled')";
export const isActiveSubagent = (s: string) => s === "running" || s === "stalled";

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
for (const [name, type] of [["session_file", "TEXT"], ["run_started_at", "INTEGER"]]) {
	if (!columns.some((c) => c.name === name)) db.exec(`ALTER TABLE subagents ADD COLUMN ${name} ${type}`);
}
export const getSubagent = (id: string) => db.prepare("SELECT * FROM subagents WHERE id = ?").get(id) as Subagent | undefined;
export const listSubagents = (agentId?: string, conv?: string) => db.prepare(`SELECT * FROM subagents${conv ? " WHERE conversation_id = ?" : agentId ? " WHERE agent_id = ?" : ""} ORDER BY created_at DESC LIMIT 100`).all(...(conv ? [conv] : agentId ? [agentId] : [])) as unknown as Subagent[];
const activeSubagents = (agentId?: string) => db.prepare(`SELECT * FROM subagents WHERE status IN ${ACTIVE}${agentId ? " AND agent_id = ?" : ""}`).all(...(agentId ? [agentId] : [])) as unknown as Subagent[];
export const subagentSettings = (): SubagentSettings => getSetting("subagentModels", { mode: "follow", allowed: [], maxMinutes: 60 });
export const agentSubagentChoice = (id: string): AgentSubagentChoice => getSetting(`subagentModel:${id}`, { mode: "follow" });
const modelKey = (m: ModelRef) => `${m.provider}/${m.id}`;
function requireModel(m: ModelRef | undefined) {
	if (!m || !configuredModels().some((x) => x.provider === m.provider && x.id === m.id)) throw new Error("模型尚未配置");
	return m;
}
export function saveSubagentSettings(input: SubagentSettings) {
	if (!["follow", "auto", "fixed"].includes(input.mode)) throw new Error("模型选择方式不对");
	const allowed = (input.allowed ?? []).map(requireModel);
	const maxMinutes = Number(input.maxMinutes ?? 60);
	if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new Error("最长运行时间必须大于 0");
	const s: SubagentSettings = { mode: input.mode, allowed, maxMinutes, ...(input.mode === "fixed" ? { model: requireModel(input.model) } : {}) };
	setSetting("subagentModels", s);
	return s;
}
export function saveAgentSubagentChoice(id: string, choice: AgentSubagentChoice) {
	if (choice.mode !== "follow" && choice.mode !== "fixed") throw new Error("模型选择方式不对");
	const c: AgentSubagentChoice = choice.mode === "fixed" ? { mode: "fixed", model: requireModel(choice.model) } : { mode: "follow" };
	setSetting(`subagentModel:${id}`, c);
	return c;
}
export function chooseSubagentModel(agentId: string, fallback: ModelRef, task: string, needs: string[] = [], explicit?: ModelRef) {
	const s = subagentSettings();
	const choice = agentSubagentChoice(agentId);
	if (choice.mode === "fixed") return { model: requireModel(choice.model), reason: "助理指定的子代理模型" };
	if (s.mode === "fixed") return { model: requireModel(s.model), reason: "全局指定的子代理模型" };
	if (s.mode === "follow" || !s.allowed.length) return { model: requireModel(fallback), reason: "跟随主会话模型" };
	if (explicit) {
		if (!s.allowed.some((m) => modelKey(m) === modelKey(explicit))) throw new Error("模型不在子代理允许清单内");
		return { model: requireModel(explicit), reason: "主会话指定（在允许清单内）" };
	}
	const profiles = modelProfiles().filter((m) => s.allowed.some((x) => modelKey(x) === modelKey(m)));
	const pick = pickModel({ needs: [...new Set([...inferNeeds(task), ...needs])] as never }, profiles, s.allowed[0]);
	if (!pick.model) throw new Error("允许清单里没有可用模型");
	return { model: pick.model, reason: pick.reason };
}

interface Live { stop?: () => Promise<void>; message?: (text: string, messageId?: string) => Promise<void>; pending: { text: string; messageId?: string }[]; toolUntil: number }
const live = new Map<string, Live>();
interface Driver {
	run(r: Subagent, connect: (stop: () => Promise<void>, message: Live["message"]) => void, input?: { text: string; messageId: string }): Promise<string>;
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
	db.prepare("INSERT INTO subagent_events(id, subagent_id, kind, reason, created_at) VALUES(?,?,?,?,?)").run(uid("se"), r.id, kind, reason, Date.now());
}
/** 所有结束路径共享这一处；状态和待投递事件一起提交。 */
export function finishSubagent(id: string, status: Exclude<SubagentStatus, "running" | "stalled">, reason = "", summary = "") {
	db.exec("BEGIN");
	try {
		const n = db.prepare(`UPDATE subagents SET status = ?, error_reason = ?, result_summary = ?, finished_at = ? WHERE id = ? AND status IN ${ACTIVE}`).run(status, status === "done" ? null : reason, summary, Date.now(), id).changes;
		if (n) addEvent(getSubagent(id)!, status, reason || summary);
		db.exec("COMMIT");
		if (!n) return false;
	} catch (e) { db.exec("ROLLBACK"); throw e; }
	changed(id);
	void deliverSubagentEvents();
	return true;
}
export function spawnSubagent(agentId: string, conv: string, fallback: ModelRef, input: { task: string; context?: string; needs?: string[]; model?: ModelRef; parentMessageId?: string }) {
	if (!input.task?.trim()) throw new Error("请说明子代理任务");
	if ((db.prepare(`SELECT COUNT(*) n FROM subagents WHERE agent_id = ? AND status IN ${ACTIVE}`).get(agentId) as { n: number }).n >= 3) throw new Error("这个助理已有 3 个后台子代理，请等一个完成");
	const picked = chooseSubagentModel(agentId, fallback, input.task, input.needs, input.model);
	const id = uid("sa"), ts = Date.now();
	db.prepare("INSERT INTO subagents(id, agent_id, conversation_id, parent_message_id, task, context, model_provider, model_id, model_reason, status, last_activity_at, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id, agentId, conv, input.parentMessageId ?? null, input.task, input.context ?? "", picked.model.provider, picked.model.id, picked.reason, "running", ts, ts);
	insertMessage({ agentId, conversationId: conv, role: "card", meta: { kind: "subagent", subagentId: id, subagent: getSubagent(id) } });
	insertMessage({ agentId, conversationId: conv, subagentId: id, role: "user", content: input.task });
	live.set(id, { pending: [], toolUntil: 0 });
	queueMicrotask(() => void run(id));
	return getSubagent(id)!;
}
async function run(id: string, input?: { text: string; messageId: string }) {
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
	if (!r || !isActiveSubagent(r.status)) return false;
	finishSubagent(id, status, status === "timeout" ? "已超过最长运行时间" : "用户或主会话停止了任务");
	requests.cancelForTask(id);
	await live.get(id)?.stop?.();
	return true;
}
export async function stopAgentSubagents(agentId: string) {
	for (const r of activeSubagents(agentId)) await stopSubagent(r.id);
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
	if (!isActiveSubagent(r.status) && !stopping) {
		if (live.has(id)) throw new Error("子代理正在停止，请稍后再发");
		if (activeSubagents(r.agent_id).length >= 3) throw new Error("这个助理已有 3 个后台子代理，请等一个完成");
	}
	const m = insertMessage({ agentId: r.agent_id, conversationId: r.conversation_id, subagentId: id, role: "user", content: text });
	if (stopping) {
		await stopSubagent(id);
		updateMessage(m.id, { meta: { delivery: "stop" } });
	} else if (isActiveSubagent(r.status)) await messageSubagent(id, text, m.id);
	else {
		const ts = Date.now();
		db.prepare("UPDATE subagents SET status = 'running', last_activity_at = ?, run_started_at = ?, finished_at = NULL, error_reason = NULL, result_summary = NULL WHERE id = ?").run(ts, ts, id);
		live.set(id, { pending: [], toolUntil: 0 });
		changed(id);
		queueMicrotask(() => void run(id, { text, messageId: m.id }));
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
export async function deliverSubagentEvents() {
	if (!driver) return;
	const events = db.prepare("SELECT * FROM subagent_events WHERE delivered_at IS NULL ORDER BY created_at, rowid").all() as unknown as SubagentEvent[];
	for (const e of events) {
		if (delivering.has(e.id)) continue;
		const r = getSubagent(e.subagent_id);
		if (!r || !db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(r.conversation_id)) continue;
		delivering.add(e.id);
		void driver.notify(r, e).then(() => {
			db.prepare("UPDATE subagent_events SET delivered_at = ? WHERE id = ?").run(Date.now(), e.id);
			db.prepare("UPDATE subagents SET notified_at = ? WHERE id = ?").run(Date.now(), r.id);
		}).catch((err) => console.warn("[subagent] 通知待重试", String(err))).finally(() => delivering.delete(e.id));
	}
}
export function recoverSubagents() {
	for (const r of activeSubagents()) finishSubagent(r.id, "lost", "服务重启，子代理被中断，请重新派活");
}
export function startSubagentWatcher() {
	const timer = setInterval(() => void checkSubagents().catch(console.error), 30_000);
	timer.unref();
}
