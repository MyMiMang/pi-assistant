/** 群的增删改与成员变动（建群、改群、删群、助理被删 / 改名）。 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { db, now, uid } from "../db.ts";
import { deleteRoomFiles } from "../files.ts";
import { getAgent } from "../runtime.ts";
import { onRoomWorkEvent } from "../work-items.ts";
import { normalizeCaps, type RoomCaps } from "./logic.ts";
import { cancelQueuedFor, states, stop } from "./scheduler.ts";
import { capsOf, changed, getRoom, memberRow, membersOf, snapshot, sys, type MemberRow } from "./store.ts";

function addMembers(roomId: string, ids: string[]) {
	const t = now();
	let sort = (db.prepare("SELECT COALESCE(MAX(sort), -1) AS s FROM room_members WHERE room_id = ?").get(roomId) as { s: number }).s;
	const added: string[] = [];
	for (const id of ids) {
		const a = getAgent(id);
		if (!a) continue;
		const cur = memberRow(roomId, id);
		if (cur && !cur.left_at) continue;
		if (cur) db.prepare("UPDATE room_members SET left_at = NULL, deleted = 0 WHERE room_id = ? AND agent_id = ?").run(roomId, id);
		else db.prepare("INSERT INTO room_members(room_id, agent_id, name, avatar, color, sort, joined_at) VALUES(?,?,?,?,?,?,?)").run(roomId, id, a.name, a.avatar, a.color, ++sort, t);
		added.push(a.name);
	}
	return added;
}

export function createRoom(i: { name?: string; purpose?: string; memberIds: string[]; managerId?: string | null; caps?: Partial<RoomCaps> }) {
	const ids = [...new Set(i.memberIds)].filter((id) => getAgent(id));
	if (!ids.length) throw new Error("至少选一个助理");
	const manager = i.managerId && ids.includes(i.managerId) ? i.managerId : ids[0];
	const id = uid("r");
	const t = now();
	const name = (i.name ?? "").trim().slice(0, 40) || ids.map((x) => getAgent(x)!.name).slice(0, 3).join("、");
	db.prepare("INSERT INTO rooms(id, name, purpose, manager_id, caps, created_at, updated_at) VALUES(?,?,?,?,?,?,?)").run(id, name, (i.purpose ?? "").slice(0, 4000), manager, JSON.stringify(normalizeCaps(i.caps)), t, t);
	addMembers(id, ids);
	sys(id, `群聊已创建。管理者是 ${getAgent(manager)!.name}：不 @ 人时由它回答并分配任务；@ 某个助理就只有它回答。`, { kind: "room-created" });
	changed(id);
	return getRoom(id)!;
}

export function updateRoom(id: string, p: { name?: string; purpose?: string; managerId?: string; memberIds?: string[]; caps?: Partial<RoomCaps> }) {
	const r = getRoom(id);
	if (!r) throw new Error("群不存在");
	if (p.name !== undefined && p.name.trim()) db.prepare("UPDATE rooms SET name = ? WHERE id = ?").run(p.name.trim().slice(0, 40), id);
	if (p.purpose !== undefined) db.prepare("UPDATE rooms SET purpose = ? WHERE id = ?").run(p.purpose.slice(0, 4000), id);
	if (p.caps) db.prepare("UPDATE rooms SET caps = ? WHERE id = ?").run(JSON.stringify(normalizeCaps({ ...capsOf(r), ...p.caps })), id);
	if (p.memberIds) {
		const want = [...new Set(p.memberIds)].filter((x) => getAgent(x));
		if (!want.length) throw new Error("群里至少要有一个助理");
		const cur = membersOf(id).map((m) => m.agent_id);
		const added = addMembers(id, want.filter((x) => !cur.includes(x)));
		const removed = cur.filter((x) => !want.includes(x));
		for (const x of removed) {
			db.prepare("UPDATE room_members SET left_at = ? WHERE room_id = ? AND agent_id = ?").run(now(), id, x);
			cancelQueuedFor(id, x);
			onRoomWorkEvent({ kind: "memberRemoved", roomId: id, agentId: x });
		}
		if (added.length) sys(id, `${added.join("、")} 加入了群聊`);
		if (removed.length) sys(id, `${removed.map((x) => memberRow(id, x)?.name ?? x).join("、")} 已移出群聊`);
	}
	const active = membersOf(id).map((m) => m.agent_id);
	const mgr = p.managerId ?? getRoom(id)!.manager_id;
	const nextMgr = mgr && active.includes(mgr) ? mgr : active[0] ?? null;
	if (nextMgr !== r.manager_id) {
		db.prepare("UPDATE rooms SET manager_id = ? WHERE id = ?").run(nextMgr, id);
		if (nextMgr) sys(id, `管理者改为 ${getAgent(nextMgr)?.name ?? ""}`);
	}
	db.prepare("UPDATE rooms SET updated_at = ? WHERE id = ?").run(now(), id);
	changed(id);
	return getRoom(id)!;
}

/** 删除群：群消息、成员的群内对话一并删除；群专属助理按选择删掉或转成我的助理 */
export async function deleteRoom(id: string, opts: { keepAgents?: string[] } = {}) {
	const r = getRoom(id);
	if (!r) return false;
	await stop(id, false);
	for (const m of membersOf(id, true)) {
		rmSync(join(config.workspaceRoot, m.agent_id, "room-files", id.replace(/[^a-zA-Z0-9_-]/g, "")), { recursive: true, force: true });
		if (m.conversation_id) {
			const { disposeConversationRuntime } = await import("../runtime.ts");
			await disposeConversationRuntime(m.conversation_id);
			db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(m.conversation_id);
			db.prepare("DELETE FROM conversations WHERE id = ?").run(m.conversation_id);
		}
	}
	db.prepare("DELETE FROM messages WHERE room_id = ?").run(id);
	onRoomWorkEvent({ kind: "roomDeleted", roomId: id });
	deleteRoomFiles(id);
	db.prepare("DELETE FROM room_members WHERE room_id = ?").run(id);
	db.prepare("DELETE FROM room_turns WHERE room_id = ?").run(id);
	db.prepare("DELETE FROM room_asks WHERE room_id = ?").run(id);
	db.prepare("DELETE FROM rooms WHERE id = ?").run(id);
	const scoped = db.prepare("SELECT id FROM agents WHERE scope = 'room' AND room_id = ?").all(id) as { id: string }[];
	const toDelete: string[] = [];
	for (const a of scoped) {
		if (opts.keepAgents?.includes(a.id)) db.prepare("UPDATE agents SET scope = 'user', room_id = NULL WHERE id = ?").run(a.id);
		else toDelete.push(a.id);
	}
	states.delete(id);
	changed(id);
	bus.emit({ type: "agents.changed" });
	return { deletedAgents: toDelete };
}

/** 助理被删除：群里保留历史（标“已删除”）；是管理者就换人 */
export function onAgentDeleted(agentId: string) {
	for (const m of db.prepare("SELECT * FROM room_members WHERE agent_id = ? AND left_at IS NULL").all(agentId) as unknown as MemberRow[]) {
		db.prepare("UPDATE room_members SET left_at = ?, deleted = 1, conversation_id = NULL WHERE room_id = ? AND agent_id = ?").run(now(), m.room_id, agentId);
		cancelQueuedFor(m.room_id, agentId);
		onRoomWorkEvent({ kind: "memberRemoved", roomId: m.room_id, agentId });
		const r = getRoom(m.room_id)!;
		if (r.manager_id === agentId) {
			const next = membersOf(m.room_id)[0]?.agent_id ?? null;
			db.prepare("UPDATE rooms SET manager_id = ? WHERE id = ?").run(next, m.room_id);
			sys(m.room_id, next ? `管理者 ${m.name} 已删除，暂由 ${getAgent(next)?.name} 担任，可以在群设置里更换。` : `管理者 ${m.name} 已删除，群里没有助理了，请在群设置里添加。`, { action: "room-settings" });
		} else sys(m.room_id, `${m.name} 已删除，历史消息保留`);
		changed(m.room_id);
	}
}
export function onAgentChanged(agentId: string) {
	// 改名 / 改头像：更新兜底快照并通知这些群刷新（群快照的名字头像以助理表为准）
	for (const m of db.prepare("SELECT room_id FROM room_members WHERE agent_id = ?").all(agentId) as { room_id: string }[]) (snapshot(m.room_id, agentId), changed(m.room_id));
}
