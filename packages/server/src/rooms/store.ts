/** 群的数据层：行类型、读取、成员、系统消息。不含调度。 */
import { bus } from "../bus.ts";
import { createConversation } from "../conversations.ts";
import { db } from "../db.ts";
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

/** 群成员名单（群规则和任务执行说明共用）：每人一行，标出管理者和「你」，带上成员说明；名字以这份名单为准。 */
export function rosterText(roomId: string, agentId: string) {
	const managerId = (db.prepare("SELECT manager_id FROM rooms WHERE id = ?").get(roomId) as { manager_id: string | null } | undefined)?.manager_id ?? null;
	const lines = membersOf(roomId).map((m) => {
		const a = getAgent(m.agent_id);
		return `- ${a?.name ?? m.name}${m.agent_id === managerId ? "（管理者）" : ""}${m.agent_id === agentId ? "（你）" : ""}${a?.description ? `：${a.description}` : ""}`;
	});
	return `这些助理：\n${lines.join("\n")}\n成员的名字一律以这份名单为准；历史消息里出现的其他称呼（比如改名前的旧名字）都不算，称呼时统一用名单里的名字。`;
}
