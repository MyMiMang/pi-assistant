/**
 * @pi-assistant/ext-skills —— 让助理自己维护技能库（Pi 扩展）。
 * 技能的发现与按需加载用的是 Pi 原生机制；这里提供：
 *  skill_search：按名称/描述/内容查相似技能（新建前先查，避免重复）
 *  skill_save：新建或更新技能。新建前自动查重（相似就提示改为更新）；新建需用户同意（或用户刚同意过建议）；
 *              更新已有技能会把修改前后的 diff 给用户审批
 *  skill_delete：删除一个“我的技能”（需要用户批准）
 * 另外在每轮结束（agent_end）把本轮的工具序列和用到的技能交给宿主，用于“要不要做成技能？”的建议。
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface SkillInfo {
	name: string;
	description: string;
	body: string;
	builtin: boolean;
}
export interface SkillsHost {
	list(): { name: string; description: string; builtin: boolean }[];
	get(name: string): SkillInfo | undefined;
	search(query: string, exclude?: string): { name: string; description: string; builtin: boolean; score: number }[];
	/** 相似度达到这个值就视为重复 */
	dupThreshold: number;
	save(input: { name: string; description: string; body: string }): { name: string; path: string; version: number };
	remove(name: string): boolean;
	/** 新建技能前确认（宿主决定：用户刚要求/同意过就直接通过，否则弹审批卡片） */
	confirmCreate(input: { name: string; description: string; userText: string }): Promise<boolean>;
	/** 更新已有技能前确认：把 diff 给用户审批 */
	confirmUpdate(input: { name: string; before: SkillInfo; after: { description: string; body: string } }): Promise<boolean>;
	/** 删除前请求用户批准 */
	confirm(summary: string): Promise<boolean>;
	/** 一轮结束：本轮用户原话、调用过的工具、读取过的技能 */
	observe?(turn: { userText: string; tools: string[]; usedSkills: string[] }): void;
}
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
export const NUDGE_TYPE = "pia_skill_nudge";

export function skillsExtension(host: SkillsHost) {
	return (pi: ExtensionAPI) => {
		let lastPrompt = "";
		pi.on("before_agent_start", (e) => {
			// Pi 1.2.0 起本事件也会对扩展触发的 run（后台唤醒、triggerTurn）触发，那种事件没有 prompt。
			// 只记用户原话：custom run 置空，避免把唤醒回合当成用户输入传给技能建议的授权判断。
			lastPrompt = e.messageType === "user" ? e.prompt : "";
		});
		pi.on("agent_end", (e) => {
			if (!host.observe) return;
			const msgs = e.messages as unknown as { role: string; customType?: string; content?: unknown }[];
			if (msgs.some((m) => m.customType === NUDGE_TYPE) || !lastPrompt.trim()) return;
			const tools: string[] = [];
			const used = new Set<string>();
			for (const m of msgs) {
				if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
				for (const b of m.content as { type: string; name?: string; arguments?: Record<string, unknown> }[]) {
					if (b.type !== "toolCall" || !b.name) continue;
					tools.push(b.name);
					const p = String(b.arguments?.path ?? "");
					const hit = p.match(/skills[\\/]([a-z0-9-]+)[\\/]SKILL\.md$/);
					if (hit) used.add(hit[1]);
				}
			}
			const userText = lastPrompt;
			lastPrompt = "";
			try {
				host.observe({ userText, tools, usedSkills: [...used] });
			} catch {
				/* 建议只是锦上添花，出错不影响对话 */
			}
		});

		pi.registerTool({
			name: "skill_search",
			label: "查找技能",
			description: "按关键词查找已有技能（名称、描述、内容的相似度）。新建技能前先用它查重：有相似的就更新那个，而不是再建一个。",
			promptSnippet: "skill_search: 查有没有相似技能",
			parameters: Type.Object({ query: Type.String({ description: "要做的事，或技能名/描述" }) }),
			annotations: { readOnlyHint: true },
			async execute(_id, p) {
				const hits = host.search(p.query);
				if (!hits.length) return text("没有找到相似的技能。");
				return text(hits.map((h) => `- ${h.name}${h.builtin ? "（内置，只读）" : ""}  相似度 ${h.score.toFixed(2)}：${h.description}`).join("\n"));
			},
		});

		pi.registerTool({
			name: "skill_save",
			label: "保存技能",
			description:
				"把一套可复用的做事方法保存为技能（Agent Skill），以后遇到同类任务时自动参考。只在用户要求或同意后使用。同名即更新已有技能（用户会看到修改前后的差异并审批）。新建前会自动查重：如果已有相似技能，请改为更新它；确认确实不同再传 confirmNew: true。内置技能不能修改。",
			promptSnippet: "skill_save: 把可复用流程保存为技能（新建/更新）",
			parameters: Type.Object({
				name: Type.String({ description: "小写字母/数字/连字符，如 weekly-report" }),
				description: Type.String({ description: "做什么 + 什么时候用（模型据此决定何时加载）" }),
				body: Type.String({ description: "Markdown 正文：具体步骤、注意事项" }),
				confirmNew: Type.Optional(Type.Boolean({ description: "已确认与相似技能不同，仍要新建" })),
			}),
			annotations: { readOnlyHint: true },
			async execute(_id, p) {
				const existing = host.get(p.name);
				if (existing?.builtin) return text(`“${p.name}”是内置技能，不能修改；请换一个名字保存（可以在它的基础上改）。`);
				if (!existing) {
					const dup = host.search(`${p.name.replace(/-/g, " ")} ${p.description}`).find((s) => !s.builtin && s.score >= host.dupThreshold);
					if (dup && !p.confirmNew)
						return text(`已有相似的技能「${dup.name}」（相似度 ${dup.score.toFixed(2)}）：${dup.description}\n请优先更新它（用 name: "${dup.name}" 调用 skill_save，先读它的 SKILL.md 再合并修改）；如果确实是不同的事，再带 confirmNew: true 重新调用。`);
					if (!(await host.confirmCreate({ name: p.name, description: p.description, userText: lastPrompt }))) return text("用户没有同意创建这个技能，不要再提。");
				} else {
					if (existing.description.trim() === p.description.trim() && existing.body.trim() === p.body.trim()) return text("内容和现在的技能一样，没有修改。");
					if (!(await host.confirmUpdate({ name: p.name, before: existing, after: { description: p.description, body: p.body } }))) return text("用户没有批准这次修改，技能保持不变。");
				}
				const s = host.save(p);
				return text(`技能已${existing ? "更新" : "保存"}：${s.name} v${s.version}，从下一轮对话开始可用。`);
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
