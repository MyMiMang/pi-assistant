/**
 * 技能有效选集（effective scope）的**唯一实现处**。
 *
 * 主会话、后台任务、子代理、群成员都按「所属助理 id」取同一份选集，不额外 expand：
 *  - `skillFilterFor(agentId)` 交给 pi-adapter 的 `skillFilter`，决定会话里加载哪些技能；
 *  - `enabledSkillsFor(agentId)` 给技能工具（skill_search/list/get）用，只暴露该助理可用集。
 *
 * 分配表缺失 / 空 → 一个都不启用（含内置）。
 */
import { assignedSkillIds } from "./skill-assignments.ts";
import { listSkills, skillIdOfPath } from "./skills.ts";

export function skillFilterFor(agentId: string): (s: { name: string; filePath: string }) => boolean {
	const enabled = new Set(assignedSkillIds(agentId));
	return (s) => {
		const id = skillIdOfPath(s.filePath, s.name);
		return id !== null && enabled.has(id);
	};
}

/** 该助理可用集（库存 ∩ 分配表）。 */
export function enabledSkillsFor(agentId: string) {
	const enabled = new Set(assignedSkillIds(agentId));
	return listSkills().filter((s) => enabled.has(s.id));
}
