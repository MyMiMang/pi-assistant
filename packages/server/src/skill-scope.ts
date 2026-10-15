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

/** 本次选中要用的技能（composer 点选，canonical id）。 */
export interface SelectedSkill {
	id: string;
	name: string;
	description: string;
	filePath: string;
}

/**
 * 把 composer 传来的 canonical id 解析成可交给 pi-adapter 的技能。
 * 只接受该助理**已启用**且库存里存在的技能；任一 id 不可用就返回 null（fail closed，
 * 不自动启用、不接受客户端路径 / 正文）。
 */
export function resolveSelectedSkills(agentId: string, ids: string[]): SelectedSkill[] | null {
	const enabled = new Set(assignedSkillIds(agentId));
	const byId = new Map(listSkills().map((s) => [s.id, s]));
	const out: SelectedSkill[] = [];
	for (const id of [...new Set(ids)]) {
		if (!enabled.has(id)) return null;
		const s = byId.get(id);
		if (!s) return null;
		out.push({ id: s.id, name: s.name, description: s.description, filePath: s.path });
	}
	return out;
}
