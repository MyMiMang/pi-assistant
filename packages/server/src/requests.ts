/**
 * 等待用户回应的请求：审批（approval）与提问（question）。
 * 先写数据库与聊天卡片，再广播 + Web Push；任一设备回应后 resolve 对应的 Promise。
 *
 * 完全权限（“操作这台电脑”档位 full + 已开启 + 允许该助理 + 未暂停）：应用层不再弹审批。
 * 这里是所有应用层审批的唯一入口（email / delivery / connectors / routines / skills / browser / computer / ext-approval），
 * 所以在这里统一 bypass，各处不用再写特例；提问（ask_user）不受影响。
 */
import { bus } from "./bus.ts";
import { db, now, uid } from "./db.ts";
import { hostFileAccess } from "./host-control.ts";
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
	// 主动巡检（后台、没人在聊）：不给心跳额外权限。需要批准的操作不在巡检任务里直接执行，也不弹卡片、不打扰用户提问；
	// 要推进就用 proactive_advance 到相关对话的主会话里做（那里走用户平时的权限规则）。
	if (taskId && (db.prepare("SELECT kind FROM tasks WHERE id = ?").get(taskId) as { kind: string | null } | undefined)?.kind === "heartbeat")
		return Promise.resolve<{ approved?: boolean; answer?: string; note?: string; scope?: "task" }>(kind === "approval" ? { approved: false, note: "主动巡检本身没有额外权限，不能直接执行需要批准的操作。如果值得做，用 proactive_advance 到相关对话里推进（走用户平时的权限规则），或用 proactive_surface 提议。" } : { answer: "（主动巡检中不能向用户提问；需要用户决定的事请用 proactive_surface 提出，或在相关对话里推进）" });
	// 完全权限：应用层不弹审批，直接放行（含硬性保护动作）。只影响审批，不影响上面的主动巡检限制，也不影响提问。
	// 凭据路径 deny、暂停 / 降权 / 关闭（hostFileAccess 每次求值立刻变假）与宿主系统权限弹窗、外部验证码都不受影响。
	if (kind === "approval" && hostFileAccess(agentId)) return Promise.resolve<{ approved?: boolean; answer?: string; note?: string; scope?: "task" }>({ approved: true, note: "完全权限：应用层不弹审批，已自动放行" });
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
