/**
 * 技能分配：每个助理启用哪些技能（**唯一事实来源**）。
 *
 * 存储：settings["skillAssignments"] = { [agentId]: string[] }，值是 canonical skill id（`来源/名称`）。
 * 语义：
 *  - 没有该助理的键 → 不启用任何技能；
 *  - 显式 `[]` 也是不启用任何技能；
 *  - **没有全局默认、没有内置例外**：内置技能默认同样不启用，必须显式分配给助理。
 *
 * 变更时递增版本号并广播 skills.changed：运行时据此在下一轮对话前重建会话，
 * 不打断正在进行的一轮（强 reload 会丢当前动作）。
 */
import { bus } from "./bus.ts";
import { getSetting, setSetting } from "./db.ts";

export const ASSIGNMENTS_KEY = "skillAssignments";
const VERSION_KEY = "skillAssignmentsVersion";

type Table = Record<string, string[]>;

/** 读取分配表；结构损坏时按空表处理（fail closed：谁都不启用）。 */
function table(): Table {
	const raw = getSetting<unknown>(ASSIGNMENTS_KEY, {});
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Table = {};
	for (const [agentId, ids] of Object.entries(raw as Record<string, unknown>)) {
		if (!Array.isArray(ids)) continue;
		out[agentId] = [...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0))];
	}
	return out;
}

function write(t: Table) {
	setSetting(ASSIGNMENTS_KEY, t);
	setSetting(VERSION_KEY, assignmentsVersion() + 1);
	bus.emit({ type: "skills.changed" });
}

/** 该助理启用的技能 id 列表（缺失 / [] 都是空）。 */
export function assignedSkillIds(agentId: string): string[] {
	return table()[agentId] ?? [];
}

/** 直接覆盖某助理的启用集合（去重）。传 [] 即清空。 */
export function setAssignedSkillIds(agentId: string, ids: string[]): void {
	const t = table();
	t[agentId] = [...new Set(ids)];
	write(t);
}

export function enableSkillForAgent(agentId: string, skillId: string): void {
	const t = table();
	t[agentId] = [...new Set([...(t[agentId] ?? []), skillId])];
	write(t);
}

export function disableSkillForAgent(agentId: string, skillId: string): void {
	const t = table();
	t[agentId] = (t[agentId] ?? []).filter((x) => x !== skillId);
	write(t);
}

/** 哪些助理启用了这个技能（删除 / 改名时提示用）。 */
export function agentsUsingSkill(skillId: string): string[] {
	return Object.entries(table())
		.filter(([, ids]) => ids.includes(skillId))
		.map(([agentId]) => agentId);
}

/** 技能从库存移除（或改名）后，把 id 从所有助理的启用集合里摘掉；不删技能文件本身。 */
export function unassignSkillEverywhere(skillId: string): string[] {
	const t = table();
	const affected: string[] = [];
	for (const [agentId, ids] of Object.entries(t)) {
		if (!ids.includes(skillId)) continue;
		t[agentId] = ids.filter((x) => x !== skillId);
		affected.push(agentId);
	}
	if (affected.length) write(t);
	return affected;
}

/** 批量给当前所有助理启用某技能（UI「给所有助理启用」）；不建立对未来新助理的继承。 */
export function enableSkillForAgents(agentIds: string[], skillId: string): void {
	const t = table();
	for (const agentId of agentIds) t[agentId] = [...new Set([...(t[agentId] ?? []), skillId])];
	write(t);
}

export const assignmentsVersion = () => getSetting<number>(VERSION_KEY, 0);
