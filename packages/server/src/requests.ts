/**
 * 等待用户回应的请求：审批（approval）与提问（question）。
 * 先写数据库与聊天卡片，再广播 + Web Push；任一设备回应后 resolve 对应的 Promise。
 */
import { bus } from "./bus.ts";
import { db, now, uid } from "./db.ts";
import { insertMessage, roomOfConversation, updateMessage } from "./messages.ts";
import { notify } from "./push.ts";

type Resolver = (r: { approved?: boolean; answer?: string; note?: string; scope?: "task" }) => void;
const pending = new Map<string, { resolve: Resolver; messageId: string }>();

export interface RequestRow {
	id: string;
	agent_id: string;
	task_id: string | null;
	kind: "approval" | "question";
	tool_name: string | null;
	payload: string;
	status: string;
	answer: string | null;
	created_at: number;
	resolved_at: number | null;
}

function create(kind: "approval" | "question", agentId: string, taskId: string | null, toolName: string | null, payload: Record<string, unknown>, title: string, conversationId?: string | null) {
	// 主动巡检（后台、没人在聊）：主动 ≠ 自主执行。需要批准的操作一律拒绝、不弹卡片，也不打扰用户提问
	if (taskId && (db.prepare("SELECT kind FROM tasks WHERE id = ?").get(taskId) as { kind: string | null } | undefined)?.kind === "heartbeat")
		return Promise.resolve<{ approved?: boolean; answer?: string; note?: string; scope?: "task" }>(kind === "approval" ? { approved: false, note: "主动巡检中不能执行需要批准的操作。如果值得做，用 proactive_surface 向用户提议。" } : { answer: "（主动巡检中不能向用户提问；需要用户决定的事请用 proactive_surface 提出）" });
	const id = uid(kind === "approval" ? "ap" : "q");
	const roomId = roomOfConversation(conversationId ?? (taskId ? (db.prepare("SELECT conversation_id FROM tasks WHERE id = ?").get(taskId) as { conversation_id: string | null } | undefined)?.conversation_id : null));
	db.prepare("INSERT INTO requests(id, agent_id, task_id, kind, tool_name, payload, status, created_at, room_id, conversation_id) VALUES(?,?,?,?,?,?,?,?,?,?)").run(
		id,
		agentId,
		taskId,
		kind,
		toolName,
		JSON.stringify(payload),
		"pending",
		now(),
		roomId,
		conversationId ?? null,
	);
	// 卡片显示在主聊天里（即使来自后台任务），这样手机上也能直接处理
	const msg = insertMessage({ agentId, conversationId, role: "card", meta: { kind, requestId: id, taskId, toolName, ...payload, status: "pending" } });
	const agentName = roomId ? ((db.prepare("SELECT name FROM agents WHERE id = ?").get(agentId) as { name: string } | undefined)?.name ?? "") : "";
	notify({ title: roomId ? `${agentName}（群聊）：${title}` : title, body: String(payload.summary ?? payload.question ?? ""), tag: id, url: roomId ? `/?room=${roomId}` : `/?agent=${agentId}` });
	return new Promise<{ approved?: boolean; answer?: string; note?: string; scope?: "task" }>((resolve) => pending.set(id, { resolve, messageId: msg.id }));
}

export const requests = {
	/** allowTask：卡片上多一个“本任务内都允许”（同一任务里同类动作不再逐个询问） */
	approval(agentId: string, taskId: string | null, toolName: string, input: Record<string, unknown>, summary: string, risk: string, conversationId?: string | null, opts: { allowTask?: boolean } = {}) {
		return create("approval", agentId, taskId, toolName, { input, summary, risk, ...(opts.allowTask ? { allowTask: true } : {}) }, "需要你批准一个操作", conversationId);
	},
	question(agentId: string, taskId: string | null, question: string, options: string[], allowFreeText: boolean, conversationId?: string | null) {
		return create("question", agentId, taskId, null, { question, options, allowFreeText }, "助理有个问题想问你", conversationId);
	},
	resolve(id: string, r: { approved?: boolean; answer?: string; note?: string; scope?: "task" }, by: string) {
		const row = db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as RequestRow | undefined;
		if (!row) return { ok: false, error: "not_found" };
		if (row.status !== "pending") return { ok: false, error: "already_resolved" };
		const status = row.kind === "approval" ? (r.approved ? "approved" : "rejected") : "answered";
		const answer = row.kind === "approval" ? (r.note ?? null) : (r.answer ?? "");
		db.prepare("UPDATE requests SET status = ?, answer = ?, resolved_by = ?, resolved_at = ? WHERE id = ?").run(status, answer, by, now(), id);
		const p = pending.get(id);
		const msgRow = db.prepare("SELECT id FROM messages WHERE role = 'card' AND json_extract(meta, '$.requestId') = ?").get(id) as { id: string } | undefined;
		if (msgRow) updateMessage(msgRow.id, { meta: { status, answer, ...(r.approved && r.scope === "task" ? { scope: "task" } : {}) } });
		bus.emit({ type: "request.resolved", id, status });
		if (p) {
			pending.delete(id);
			p.resolve(r);
		}
		return { ok: true, status };
	},
	/** 启动时：上次进程里未完成的请求已失去等待者，标记为过期（续跑时 agent 会重新发起）。 */
	expireStale() {
		const rows = db.prepare("SELECT id FROM requests WHERE status = 'pending'").all() as { id: string }[];
		for (const r of rows) {
			db.prepare("UPDATE requests SET status = 'expired', resolved_at = ? WHERE id = ?").run(now(), r.id);
			const m = db.prepare("SELECT id FROM messages WHERE role = 'card' AND json_extract(meta, '$.requestId') = ?").get(r.id) as { id: string } | undefined;
			if (m) updateMessage(m.id, { meta: { status: "expired" } }, false);
		}
		return rows.length;
	},
	/** 群聊“停止”：这个群里还在等用户处理的请求一律按拒绝处理 */
	cancelForRoom(roomId: string) {
		const rows = db.prepare("SELECT id FROM requests WHERE status = 'pending' AND room_id = ?").all(roomId) as { id: string }[];
		for (const r of rows) requests.resolve(r.id, { approved: false, answer: "（群聊已停止）", note: "用户停止了群聊" }, "system");
	},
	cancelForTask(taskId: string) {
		const rows = db.prepare("SELECT id FROM requests WHERE status = 'pending' AND task_id = ?").all(taskId) as { id: string }[];
		for (const r of rows) requests.resolve(r.id, { approved: false, answer: "（任务已取消）", note: "任务已取消" }, "system");
	},
};
