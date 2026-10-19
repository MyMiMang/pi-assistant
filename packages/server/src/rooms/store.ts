/** 群的数据层：行类型、读取、成员、系统消息、自主推进设置。不含调度。 */
import { bus } from "../bus.ts";
import { createConversation } from "../conversations.ts";
import { db, now } from "../db.ts";
import { insertMessage } from "../messages.ts";
import { getAgent } from "../runtime.ts";
import { normalizeCaps, type RoomCaps } from "./logic.ts";

export interface RoomRow {
	id: string;
	name: string;
	purpose: string;
	manager_id: string | null;
	caps: string;
	unread: number;
	paused: string | null;
	autonomy: string | null;
	sort: number;
	created_at: number;
	updated_at: number;
}
export interface MemberRow {
	room_id: string;
	agent_id: string;
	conversation_id: string | null;
	cursor: number | null;
	name: string;
	avatar: string;
	color: string;
	sort: number;
	joined_at: number;
	left_at: number | null;
	deleted: number;
}
/** 自主推进：用户确认了目标和完成标准后开启；成员可以 @ 彼此，管理者只在关键事件被叫醒。 */
export interface Autonomy {
	goal: string;
	doneCriteria: string;
	startedAt: number;
}

export const getRoom = (id: string) => db.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as RoomRow | undefined;
export const membersOf = (roomId: string, all = false) =>
	db.prepare(`SELECT * FROM room_members WHERE room_id = ? ${all ? "" : "AND left_at IS NULL"} ORDER BY sort, joined_at`).all(roomId) as unknown as MemberRow[];
export const memberRow = (roomId: string, agentId: string) => db.prepare("SELECT * FROM room_members WHERE room_id = ? AND agent_id = ?").get(roomId, agentId) as MemberRow | undefined;
export const capsOf = (r: RoomRow): RoomCaps => normalizeCaps(JSON.parse(r.caps || "{}"));
export const changed = (roomId?: string) => bus.emit({ type: "rooms.changed", roomId });
export const activeIds = (roomId: string) => membersOf(roomId).filter((m) => getAgent(m.agent_id)).map((m) => m.agent_id);
export const memberRefs = (roomId: string) => membersOf(roomId).map((m) => ({ id: m.agent_id, name: getAgent(m.agent_id)?.name ?? m.name }));
/** 成员在群里的会话（不含它的任务会话） */
export const roomOfConv = (conv: string | null) => (conv ? (db.prepare("SELECT room_id FROM room_members WHERE conversation_id = ?").get(conv) as { room_id: string } | undefined)?.room_id ?? null : null);

/** 系统消息直接写进群（agent_id 为空） */
export function sys(roomId: string, content: string, meta: Record<string, unknown> = {}, status = "done") {
	return insertMessage({ agentId: "", roomId, conversationId: null, role: "system", content, meta, status });
}

export function snapshot(roomId: string, agentId: string) {
	const a = getAgent(agentId);
	if (a) db.prepare("UPDATE room_members SET name = ?, avatar = ?, color = ? WHERE room_id = ? AND agent_id = ?").run(a.name, a.avatar, a.color, roomId, agentId);
}
/** 成员在群里的隐藏对话（第一次发言时才建） */
export function memberConversation(roomId: string, agentId: string) {
	const m = memberRow(roomId, agentId);
	if (m?.conversation_id && db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(m.conversation_id)) return m.conversation_id;
	const room = getRoom(roomId);
	const c = createConversation(agentId, `群聊：${room?.name ?? ""}`, { makeCurrent: false });
	db.prepare("UPDATE conversations SET hidden = 1 WHERE id = ?").run(c.id);
	db.prepare("UPDATE room_members SET conversation_id = ? WHERE room_id = ? AND agent_id = ?").run(c.id, roomId, agentId);
	return c.id;
}

/** 群是否被用户按过「停止」（持久事实，重启后仍有效；新消息 / 继续才清掉） */
export function stoppedFlag(r: RoomRow | undefined) {
	if (!r?.paused) return false;
	try {
		return (JSON.parse(r.paused) as { stopped?: boolean }).stopped === true;
	} catch {
		return false;
	}
}

export function autonomyOf(r: RoomRow | undefined): Autonomy | null {
	if (!r?.autonomy) return null;
	try {
		const a = JSON.parse(r.autonomy) as Autonomy;
		return a && typeof a.goal === "string" && a.goal ? a : null;
	} catch {
		return null;
	}
}
export function writeAutonomy(roomId: string, a: Autonomy | null) {
	db.prepare("UPDATE rooms SET autonomy = ?, updated_at = ? WHERE id = ?").run(a ? JSON.stringify(a) : null, now(), roomId);
}
