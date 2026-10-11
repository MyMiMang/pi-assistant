/**
 * @pi-assistant/ext-skills —— 让助理自己维护技能库（Pi 扩展）。
 * 技能的发现与按需加载用的是 Pi 原生机制；这里只提供写入/删除工具。
 *  skill_save：新建或更新一个技能（SKILL.md）
 *  skill_delete：删除一个“我的技能”（需要用户批准）
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface SkillsHost {
	list(): { name: string; description: string; builtin: boolean }[];
	save(input: { name: string; description: string; body: string }): { name: string; path: string };
	remove(name: string): boolean;
	/** 删除前请求用户批准 */
	confirm(summary: string): Promise<boolean>;
}
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

export function skillsExtension(host: SkillsHost) {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "skill_save",
			label: "保存技能",
			description:
				"把一套可复用的做事方法保存为技能（Agent Skill），以后遇到同类任务时自动参考。适合：用户教你的固定流程、完成过的多步任务的经验。同名技能会被更新。内置技能不能修改（可以另存一个新名字）。新技能从下一轮对话开始生效。",
			promptSnippet: "skill_save: 把可复用流程保存为技能",
			parameters: Type.Object({
				name: Type.String({ description: "小写字母/数字/连字符，如 weekly-report" }),
				description: Type.String({ description: "做什么 + 什么时候用（模型据此决定何时加载）" }),
				body: Type.String({ description: "Markdown 正文：具体步骤、注意事项" }),
			}),
			annotations: { readOnlyHint: true },
			async execute(_id, p) {
				if (host.list().some((s) => s.name === p.name && s.builtin)) return text(`“${p.name}”是内置技能，不能修改；请换一个名字保存。`);
				const s = host.save(p);
				return text(`技能已保存：${s.name}（${s.path}），从下一轮对话开始可用。`);
			},
		});
		pi.registerTool({
			name: "skill_delete",
			label: "删除技能",
			description: "删除一个“我的技能”。会先请求用户批准。",
			parameters: Type.Object({ name: Type.String() }),
			annotations: { readOnlyHint: true },
			async execute(_id, p) {
				const s = host.list().find((x) => x.name === p.name);
				if (!s) return text(`没有找到技能 ${p.name}`);
				if (s.builtin) return text("内置技能不能删除。");
				if (!(await host.confirm(`删除技能「${p.name}」：${s.description}`))) return text("用户没有批准删除。");
				host.remove(p.name);
				return text(`已删除技能 ${p.name}`);
			},
		});
	};
}
