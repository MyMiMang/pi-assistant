/**
 * 群里撤回还没被任何成员读到的用户消息（docs/design/recall-pending-message.md）。
 * 「读到」= 有成员的回合已经开始（room_turns.status 不是 queued / cancelled），或消息已作为插话送进了正在跑的成员（delivery=delivered）。
 * 还没读到的有三种去处：排着的回合（queue + room_turns）、等当前发言结束后重新安排（replan）、已排进正在发言成员的插话队列（delivery=queued）。
 */
import { db, now } from "../db.ts";
import { getMessage, updateMessage } from "../messages.ts";
import { runtimes } from "../agent-runtime/agent-runtime.ts";
import { emitState, states } from "./queue.ts";

const turnsOf = (roomId: string, messageId: string) => db.prepare("SELECT id, status FROM room_turns WHERE room_id = ? AND source_message_id = ?").all(roomId, messageId) as { id: string; status: string }[];

/** 这条群消息现在还能不能撤回（没有成员读到） */
export function roomMessageRecallable(roomId: string, messageId: string): boolean {
	const m = getMessage(messageId);
	if (!m || m.room_id !== roomId || m.role !== "user" || m.agent_id !== "" || m.meta.delivery === "delivered") return false;
	return turnsOf(roomId, messageId).every((t) => t.status === "queued" || t.status === "cancelled");
}

/** 撤回；返回 false = 已经有人读到了。调用方随后把消息标成已撤回 */
export function recallRoomMessage(roomId: string, messageId: string): boolean {
	if (!roomMessageRecallable(roomId, messageId)) return false;
	if (getMessage(messageId)!.meta.delivery === "queued") {
		// 已排进正在发言成员的插话队列：从那个成员的会话里拿掉
		if (![...runtimes.values()].some((r) => r.recallSteering(messageId))) return false;
	}
	const s = states.get(roomId);
	if (s) {
		if (s.replan?.sourceMessageId === messageId) s.replan = null;
		const ids = new Set(turnsOf(roomId, messageId).filter((t) => t.status === "queued").map((t) => t.id));
		for (const id of ids) db.prepare("UPDATE room_turns SET status = 'cancelled', finished_at = ? WHERE id = ?").run(now(), id);
		s.queue = s.queue.filter((q) => !ids.has(q.turnId));
		emitState(roomId);
	}
	return true;
}

/** 界面用：消息上带 recallable 标记（排队中 true；回合开始 / 送达后 false） */
export function syncRecallable(roomId: string, messageId: string) {
	const m = getMessage(messageId);
	if (!m || m.role !== "user") return;
	const can = roomMessageRecallable(roomId, messageId);
	if (!!m.meta.recallable !== can) updateMessage(messageId, { meta: { recallable: can } });
}
/** 回合开始：它的来源消息被读到了，不能再撤回 */
export function markTurnRead(roomId: string, turnId: string) {
	const src = db.prepare("SELECT source_message_id AS id FROM room_turns WHERE id = ?").get(turnId) as { id: string | null } | undefined;
	if (src?.id) syncRecallable(roomId, src.id);
}
