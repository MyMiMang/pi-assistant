/**
 * 群里约的跟进到点（proactive.ts 的 tickProactive 调用）：
 * followup_schedule 在群里登记时，conversation_id 是这个成员在群里的隐藏会话（room_members.conversation_id）。
 * 到点后不走后台巡检（帮手看不到群上下文、也发不回群），而是直接在群里叫醒这个成员发言（reason = "timer"，群里所有人可见）。
 * 群被用户按了「停止」→ 不发言，只在群里插一条用户看得见的说明；成员已离开 / 群没了 → 返回 null，由调用方退回后台巡检。
 * 群里约的跟进不受免打扰时段顺延（用户在群里明确约的；`inRoom` 给 proactive.ts 判断用）。
 * 主动推进（proactive_advance 指定了群）走同一个「叫醒成员发言」：回合原因 "proactive"，群里先插一条可见小提示。
 */
import { db } from "../db.ts";
import { setRoomHandler } from "../proactive-room.ts";
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
export const advanceNotice = (name: string, title: string, stopped: boolean) =>
	`🧭 ${name} 主动来推进：${clip(title.trim(), 200)}${stopped ? `（群已停止，没有自动推进；需要的话 @ ${name}）` : ""}`;

/** 在群里叫醒一个成员发言（跟进到点 / 主动推进共用）：群已停止（库里的标记，或刚停、只在内存里）→ 只留说明、不发言。 */
function wakeInRoom(roomId: string, agentId: string, reason: "timer" | "proactive", task: string, notice: (name: string, stopped: boolean) => string, kind: string): "fired" | "stopped" {
	const name = getAgent(agentId)?.name ?? "助理";
	const fired = !stoppedFlag(getRoom(roomId)) && scheduleTurns(roomId, [{ agentId, reason, task: task.trim().slice(0, 1000), depth: 0 }]);
	sys(roomId, notice(name, !fired), { kind });
	return fired ? "fired" : "stopped";
}

/**
 * 到点的跟进如果是群里约的：在群里处理，返回 "fired"（已叫醒成员发言）/ "stopped"（群已停止，只留了说明）；
 * 不是群里约的 / 成员已离开 → null，调用方按原来的后台巡检处理。
 */
export function fireRoomFollowup(agentId: string, followup: { note: string; conversation_id: string | null }): "fired" | "stopped" | null {
	const hit = roomMemberOfConversation(agentId, followup.conversation_id);
	if (!hit) return null;
	return wakeInRoom(hit.roomId, agentId, "timer", followup.note, (name, stopped) => followupNotice(name, followup.note, stopped), "room-followup");
}

/** 主动推进：在群里叫醒这个成员做事；不是这个群的在职成员 → null */
export function fireRoomAdvance(agentId: string, roomId: string, i: { title: string; body: string }): "fired" | "stopped" | null {
	if (!isRoomMember(agentId, roomId)) return null;
	return wakeInRoom(roomId, agentId, "proactive", `要做的事：${i.title.trim().slice(0, 100)}\n上下文：${i.body.trim().slice(0, 700)}`, (name, stopped) => advanceNotice(name, i.title, stopped), "room-advance");
}

function isRoomMember(agentId: string, roomId: string) {
	return !!db.prepare("SELECT 1 FROM room_members WHERE room_id = ? AND agent_id = ? AND left_at IS NULL AND deleted = 0").get(roomId, agentId) && !!getRoom(roomId) && !!getAgent(agentId);
}

setRoomHandler({ inRoom: (agentId, conversationId) => !!roomMemberOfConversation(agentId, conversationId), fire: fireRoomFollowup, advance: fireRoomAdvance, isMember: isRoomMember });
