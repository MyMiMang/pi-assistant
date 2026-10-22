/**
 * 任务与群生命周期的衔接（钩子①，从 actions.ts 拆出）：成员移出、删群从 onRoomWorkEvent 进来。
 * 群「停止」不在这里——停群不停任务。
 */
import { db, now } from "../db.ts";
import { cancelWorkRuns } from "./exec.ts";
import { agentName, emit, event, type WorkItemRow } from "./store.ts";

/** 移出成员：标受阻待改派，不自动转给管理者，也不继续调度。 */
function onRoomMemberRemoved(roomId: string, agentId: string) {
	const rows = db.prepare("SELECT * FROM work_items WHERE room_id = ? AND owner_agent_id = ? AND status IN ('pending','active','blocked','review')").all(roomId, agentId) as unknown as WorkItemRow[];
	for (const row of rows) {
		db.prepare("UPDATE work_items SET status = 'blocked', revision = revision + 1, latest_progress = ?, blocker = ?, updated_at = ? WHERE id = ? AND revision = ?").run(`负责人 ${agentName(agentId)} 已移出群聊，待改派`, "负责人已移出群聊", now(), row.id, row.revision);
		event(row.id, "owner.left", { kind: "user" }, row.revision + 1, { agentId });
		cancelWorkRuns(row.id, { abortCurrent: true }).catch(() => {});
	}
	if (rows.length) emit(roomId);
}

/** 删群：中止本群任务的执行，并按原删除语义清掉本群的任务与关联（成员自己的任务会话保留为它的记忆）。 */
function deleteRoomWorkItems(roomId: string) {
	const ids = (db.prepare("SELECT id FROM work_items WHERE room_id = ?").all(roomId) as { id: string }[]).map((r) => r.id);
	for (const id of ids) {
		void cancelWorkRuns(id, { abortCurrent: true }).catch(() => {});
		db.prepare("DELETE FROM work_item_events WHERE work_item_id = ?").run(id);
		db.prepare("DELETE FROM work_item_runs WHERE work_item_id = ?").run(id);
	}
	db.prepare("DELETE FROM work_exec_conversations WHERE room_id = ?").run(roomId);
	db.prepare("DELETE FROM work_items WHERE room_id = ?").run(roomId);
}

/** 钩子①（群 → 任务）：成员移出、删群从这里进来。群「停止」不在这里——停群不停任务。 */
export type RoomWorkEvent = { kind: "memberRemoved"; roomId: string; agentId: string } | { kind: "roomDeleted"; roomId: string };
export function onRoomWorkEvent(e: RoomWorkEvent) {
	if (e.kind === "memberRemoved") return onRoomMemberRemoved(e.roomId, e.agentId);
	return deleteRoomWorkItems(e.roomId);
}
