/**
 * 负责人自己重做 / 带着新信息接着做（决策 0019 第 4 步）：
 *  - resumeWithNote：提问得到回答时提问者没有在跑的执行，用现有的开始路径（createRun + launch）重新跑一次，把问题和回答放进这次执行的说明；
 *  - reworkByOwner：负责人把自己已完成的任务重开成新修订重做（只有被上游提问点名时才允许，调用方在 rooms/ask-tools.ts 校验）。
 */
import { db } from "../db.ts";
import { reopenWorkItem } from "./actions.ts";
import { launch } from "./launch.ts";
import { createRun } from "./exec.ts";
import { activeMember, clip, emit, fail, itemRow, WORK_STATUS_LABEL } from "./store.ts";

const hasRunning = (itemId: string) => !!db.prepare("SELECT 1 FROM work_item_runs WHERE work_item_id = ? AND status IN ('queued','running') LIMIT 1").get(itemId);

/** 提问者的任务还在进行 / 受阻、没有执行在跑：带着说明重新跑一次。不满足条件返回 false（调用方只发在群里）。不占自动重试次数。 */
export function resumeWithNote(itemId: string, agentId: string, note: string): boolean {
	const row = itemRow(itemId);
	if (!row || !row.room_id || row.owner_agent_id !== agentId || !["active", "blocked"].includes(row.status)) return false;
	if (hasRunning(row.id) || !activeMember(row.room_id, agentId)) return false;
	if (!row.requirement || !row.done_criteria) return false;
	launch(row, createRun(row, agentId, { task: clip(note, 4000) }));
	return true;
}

/** 负责人重做自己的任务：已完成 → 重开成新修订并马上重做；还在进行 / 受阻且没在跑 → 带着说明接着做。 */
export function reworkByOwner(o: { workItemId: string; agentId: string; roomId: string; why: string }) {
	const row = itemRow(o.workItemId);
	if (!row || row.room_id !== o.roomId) fail("任务不存在或不在这个群", "not_found");
	if (row.owner_agent_id !== o.agentId) fail("只有任务负责人能重做自己的任务", "not_owner");
	const note = clip(o.why, 1000);
	if (!note) fail("写清楚要改什么、为什么", "empty");
	if (row.status === "done") {
		reopenWorkItem({ workItemId: row.id, actor: { kind: "agent", agentId: o.agentId, roomId: o.roomId }, note, ownerRework: true });
		const cur = itemRow(row.id)!;
		launch(cur, createRun(cur, o.agentId, { task: `按同事指出的问题重做：${note}` }), true);
	} else if (!resumeWithNote(row.id, o.agentId, `按同事指出的问题修改：${note}`)) fail(`任务现在是「${WORK_STATUS_LABEL[row.status]}」，不能重做`, "bad_status");
	emit(row.room_id);
	return itemRow(row.id)!;
}
