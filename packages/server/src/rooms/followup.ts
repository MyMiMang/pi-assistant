/**
 * 群里约的跟进到点（proactive.ts 的 tickProactive 调用）：
 * followup_schedule 在群里登记时，conversation_id 是这个成员在群里的隐藏会话（room_members.conversation_id）。
 * 到点后不走后台巡检（帮手看不到群上下文、也发不回群），而是直接在群里叫醒这个成员发言（reason = "timer"，群里所有人可见）。
 * 群被用户按了「停止」→ 不发言，只在群里插一条用户看得见的说明；成员已离开 / 群没了 → 返回 null，由调用方退回后台巡检。
 * 群里约的跟进不受免打扰时段顺延（用户在群里明确约的；`inRoom` 给 proactive.ts 判断用）。
 */
import { db } from "../db.ts";
import { setRoomFollowupHandler } from "../proactive.ts";
import { getAgent } from "../runtime.ts";
import { scheduleTurns } from "./scheduler.ts";
import { getRoom, stoppedFlag, sys } from "./store.ts";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 这个会话是不是某个仍在群里的成员的群会话；是就给出群和成员。 */
export function roomMemberOfConversation(agentId: string, conversationId: string | null): { roomId: string } | null {
	if (!conversationId) return null;
	const m = db.prepare("SELECT room_id FROM room_members WHERE conversation_id = ? AND agent_id = ? AND left_at IS NULL AND deleted = 0").get(conversationId, agentId) as { room_id: string } | undefined;
	return m && getRoom(m.room_id) && getAgent(agentId) ? { roomId: m.room_id } : null;
}

/** 群里发出去的可见提示 */
export const followupNotice = (name: string, note: string, stopped: boolean) =>
	`⏰ ${name} 约好的跟进到点了：${clip(note.trim(), 200)}${stopped ? `（群已停止，没有自动执行；需要的话 @ ${name}）` : ""}`;

/**
 * 到点的跟进如果是群里约的：在群里处理，返回 "fired"（已叫醒成员发言）/ "stopped"（群已停止，只留了说明）；
 * 不是群里约的 / 成员已离开 → null，调用方按原来的后台巡检处理。
 */
export function fireRoomFollowup(agentId: string, followup: { note: string; conversation_id: string | null }): "fired" | "stopped" | null {
	const hit = roomMemberOfConversation(agentId, followup.conversation_id);
	if (!hit) return null;
	const name = getAgent(agentId)?.name ?? "助理";
	// 群已停止（库里的标记，或刚停、只在内存里：scheduleTurns 返回 false）都只留说明，不退回后台巡检（那条路发不回群）
	const fired = !stoppedFlag(getRoom(hit.roomId)) && scheduleTurns(hit.roomId, [{ agentId, reason: "timer", task: followup.note.trim().slice(0, 1000), depth: 0 }]);
	sys(hit.roomId, followupNotice(name, followup.note, !fired), { kind: "room-followup" });
	return fired ? "fired" : "stopped";
}

setRoomFollowupHandler({ inRoom: (agentId, conversationId) => !!roomMemberOfConversation(agentId, conversationId), fire: fireRoomFollowup });
