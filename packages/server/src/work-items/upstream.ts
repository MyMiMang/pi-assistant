/**
 * 上游任务出了新版本（重新核验通过，且之前已经通过过一次）：把新成果交给依赖它的下游任务（决策 0019 第 4 步）。
 *  - 下游正在执行：把「上游出了新版本」+ 交接单 + 文件路径插话送进它的任务会话（拼法和第 3 步前置成果共用 handoffFrom）；
 *  - 下游还没完成但没在跑（待安排 / 进行中 / 待核验）：下次执行说明按最新提交拼，自然带上，这里不用做；
 *  - 下游已经完成：叫醒管理者决定它要不要跟着改。
 */
import { db } from "../db.ts";
import { handoffFrom, steerToLiveRun, liveRunOf } from "./exec.ts";
import { port } from "./ports.ts";
import { agentName, parseDepends, type WorkItemRow } from "./store.ts";

/** 依赖某个任务的下游任务（任何状态，不含已取消）。 */
const dependentsOf = (itemId: string) => (db.prepare("SELECT * FROM work_items WHERE status != 'cancelled' AND depends_on LIKE ?").all(`%"${itemId}"%`) as unknown as WorkItemRow[]).filter((r) => parseDepends(r.depends_on).includes(itemId));

/** 这个任务之前是不是已经核验通过过（重新核验通过才算「新版本」）。 */
export const passedBefore = (itemId: string) => !!db.prepare("SELECT 1 FROM work_item_events WHERE work_item_id = ? AND kind = 'verified.pass' LIMIT 1").get(itemId);

/** 返回处理了几个下游：[插话送达, 叫醒管理者]。 */
export function deliverNewVersion(upstream: WorkItemRow): { steered: string[]; wokeManager: string[] } {
	const out = { steered: [] as string[], wokeManager: [] as string[] };
	for (const dep of dependentsOf(upstream.id)) {
		if (!dep.room_id || !dep.owner_agent_id) continue;
		if (liveRunOf(dep.id)) {
			const text = `（上游任务「${upstream.title}」出了新版本，请对照新版本检查你已经做的部分要不要跟着改）\n${handoffFrom(upstream, dep.owner_agent_id, dep.room_id)}`;
			if (steerToLiveRun(dep.room_id, dep.owner_agent_id, text)) out.steered.push(dep.id);
		} else if (dep.status === "done") {
			port()?.wakeManager(dep.room_id, `上游任务「${upstream.title}」重新核验通过、出了新版本，但依赖它的任务「${dep.title}」（负责人 ${agentName(dep.owner_agent_id)}）已经完成。决定它要不要跟着改：要改就用 work_update 重开并写清改什么，不用改就不动`, dep.id);
			out.wokeManager.push(dep.id);
		}
	}
	return out;
}
