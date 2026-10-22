/**
 * 任务依赖（docs/design/group-team.md §4、决策 0019，第 3 步）：按编号或名字解析前置任务、防环、
 * 找出前置任务刚完成时可以自动开始的下游任务。store.ts 存数据，这里只管“依赖”本身的判断。
 */
import { db } from "../db.ts";
import { itemRow, parseDepends, type WorkItemRow } from "./store.ts";

/**
 * 纯函数：在现有依赖图 edges（itemId → 它依赖的任务 id 列表）上新增一条 from 依赖 to 的边会不会成环。
 * 成环等价于：沿着现有边，从 to 出发已经能走到 from（to 已经直接或间接依赖 from，再加这条边就循环了）。
 */
export function wouldCycle(edges: Record<string, string[]>, from: string, to: string): boolean {
	if (from === to) return true;
	const seen = new Set<string>();
	const stack = [to];
	while (stack.length) {
		const cur = stack.pop()!;
		if (cur === from) return true;
		if (seen.has(cur)) continue;
		seen.add(cur);
		for (const next of edges[cur] ?? []) stack.push(next);
	}
	return false;
}

/** 这个群当前的依赖图（不含将要新增的边），给 wouldCycle 用。 */
export function dependencyEdges(roomId: string): Record<string, string[]> {
	const rows = db.prepare("SELECT id, depends_on FROM work_items WHERE room_id = ?").all(roomId) as { id: string; depends_on: string }[];
	const edges: Record<string, string[]> = {};
	for (const r of rows) edges[r.id] = parseDepends(r.depends_on);
	return edges;
}

/** 按编号或任务名（同一个群）解析前置任务引用；解析不到的放进 missing，调用方据此报错并列出可选任务。 */
export function resolveRefs(roomId: string, refs: string[], excludeId?: string): { ids: string[]; missing: string[] } {
	const rows = db.prepare("SELECT id, title FROM work_items WHERE room_id = ? AND status != 'cancelled'").all(roomId) as { id: string; title: string }[];
	const ids: string[] = [];
	const missing: string[] = [];
	for (const raw of refs.map((x) => String(x ?? "").trim()).filter(Boolean)) {
		const hit = rows.find((r) => r.id === raw) ?? rows.find((r) => r.title === raw) ?? rows.find((r) => r.title.toLowerCase() === raw.toLowerCase());
		if (!hit || hit.id === excludeId) missing.push(raw);
		else if (!ids.includes(hit.id)) ids.push(hit.id);
	}
	return { ids, missing };
}

/** 给报错文案用：这个群可以选的任务（编号 + 名字），排除某个任务自己。 */
export function availableTasksText(roomId: string, excludeId?: string): string {
	const rows = db.prepare("SELECT id, title FROM work_items WHERE room_id = ? AND status != 'cancelled' ORDER BY created_at").all(roomId) as { id: string; title: string }[];
	const list = rows.filter((r) => r.id !== excludeId);
	return list.length ? list.map((r) => `「${r.title}」（${r.id}）`).join("、") : "（这个群还没有别的任务）";
}

/** 这些前置任务里还没完成的（用于判断能不能开始，以及拼「等前置任务完成」的提示）。 */
export function pendingDeps(ids: string[]): WorkItemRow[] {
	return ids.map((id) => itemRow(id)).filter((r): r is WorkItemRow => !!r && r.status !== "done");
}

/** 一个任务核验通过后，所有依赖它、状态 pending、且全部前置都已完成的下游任务（可以自动开始）。 */
export function readyDependents(itemId: string): WorkItemRow[] {
	const candidates = db.prepare("SELECT * FROM work_items WHERE status = 'pending' AND depends_on LIKE ?").all(`%"${itemId}"%`) as unknown as WorkItemRow[];
	return candidates.filter((r) => {
		const deps = parseDepends(r.depends_on);
		return deps.includes(itemId) && pendingDeps(deps).length === 0;
	});
}

/** 依赖某个任务、还没开始（pending）的下游任务（那个任务被取消时要标受阻）。 */
export function pendingDependentsOf(itemId: string): WorkItemRow[] {
	const candidates = db.prepare("SELECT * FROM work_items WHERE status = 'pending' AND depends_on LIKE ?").all(`%"${itemId}"%`) as unknown as WorkItemRow[];
	return candidates.filter((r) => parseDepends(r.depends_on).includes(itemId));
}

/** 这个任务是否有别的任务依赖它（任何状态）；提交时交接说明是空的话用这个提醒它。 */
export function hasDependents(itemId: string): boolean {
	const rows = db.prepare("SELECT depends_on FROM work_items WHERE depends_on LIKE ?").all(`%"${itemId}"%`) as { depends_on: string }[];
	return rows.some((r) => parseDepends(r.depends_on).includes(itemId));
}
