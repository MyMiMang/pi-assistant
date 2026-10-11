/**
 * @pi-assistant/ext-memory —— 记忆（Pi 扩展），与记忆后端无关。
 * 宿主（服务端 MemoryRegistry）负责选后端（basic / Hindsight / MemOS）和作用域；这里只做：
 *  - before_agent_start：注入宿主给出的记忆块（bootContext + 与本轮输入相关的 recall）
 *  - 工具：memory_remember / memory_recall / memory_forget，以及后端支持时的 memory_reflect
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type MemoryScope = "user" | "agent" | "conversation";
export type MemoryKind = "fact" | "log" | "note";
export interface MemoryHit {
	id: string;
	text: string;
	scope: string;
	kind: string;
	createdAt: string;
}
export interface MemoryHost {
	context(prompt: string): Promise<string>;
	remember(input: { content: string; kind?: MemoryKind; scope?: MemoryScope; ttlDays?: number }): Promise<{ id: string; async?: boolean }>;
	recall(query: string, limit: number): Promise<MemoryHit[]>;
	forget(id: string): Promise<boolean>;
	/** 后端支持反思时提供 */
	reflect?(query: string): Promise<{ answer: string } | null>;
	onChange?(): void;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

export function memoryExtension(host: MemoryHost) {
	return (pi: ExtensionAPI) => {
		pi.on("before_agent_start", async (event) => {
			try {
				const block = await host.context(event.prompt);
				if (!block.trim()) return;
				return {
					systemPrompt: `${event.systemPrompt}\n\n<memory>\n以下是你记得的信息（来自记忆库，可能过时；与用户当前说法冲突时以用户为准，并用 memory_remember / memory_forget 更新。方括号里是记忆 id）：\n${block}\n</memory>`,
				};
			} catch (e) {
				console.warn("[memory] context failed", e);
			}
		});
		pi.registerTool({
			name: "memory_remember",
			label: "记住",
			description:
				"把值得长期记住的信息写进记忆库：用户的名字、偏好、习惯、重要决定、长期目标（kind=fact）；发生过的事、做过的决定（kind=log，按日期记录）；只在短期内有用的提醒（kind=note，默认 7 天后过期）。scope：user=关于用户本人、所有助理共享（fact 默认）；agent=只和你有关；conversation=只在当前对话有效。不要记录密码、密钥等敏感信息。",
			promptSnippet: "memory_remember: 记住用户的偏好/事实/决定",
			parameters: Type.Object({
				content: Type.String({ description: "一句完整、独立可读的陈述，例如“用户叫邓邓，在上海，喜欢简洁的回答”" }),
				kind: Type.Optional(Type.Union([Type.Literal("fact"), Type.Literal("log"), Type.Literal("note")])),
				scope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("agent"), Type.Literal("conversation")])),
				ttlDays: Type.Optional(Type.Number({ description: "便签有效天数" })),
			}),
			annotations: { readOnlyHint: true },
			async execute(_id, p) {
				try {
					const r = await host.remember(p);
					host.onChange?.();
					return text(r.async ? "已提交到记忆库（后台处理中）。" : `已记住（${r.id}）：${p.content}`);
				} catch (e) {
					return text(`没有记住：${e instanceof Error ? e.message : String(e)}`);
				}
			},
		});
		pi.registerTool({
			name: "memory_recall",
			label: "回忆",
			description: "在记忆库里搜索与问题相关的条目（包括较早的日志）。系统提示里已注入的记忆不必再搜。",
			promptSnippet: "memory_recall: 搜索记忆库",
			parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }),
			annotations: { readOnlyHint: true },
			async execute(_id, p) {
				const items = await host.recall(p.query, p.limit ?? 8);
				return text(items.length ? items.map((m) => `- [${m.id}] (${m.scope}/${m.kind}, ${m.createdAt.slice(0, 10)}) ${m.text}`).join("\n") : "没有找到相关记忆。");
			},
		});
		pi.registerTool({
			name: "memory_forget",
			label: "忘记",
			description: "删除一条记忆（用户要求忘掉，或信息已过时/错误时）。id 来自注入的记忆或 memory_recall 的结果。",
			promptSnippet: "memory_forget: 删除一条记忆",
			parameters: Type.Object({ id: Type.String() }),
			annotations: { readOnlyHint: true },
			async execute(_id, p) {
				const ok = await host.forget(p.id);
				host.onChange?.();
				return text(ok ? `已忘记 ${p.id}` : `没有找到记忆 ${p.id}`);
			},
		});
		if (host.reflect) {
			const reflect = host.reflect;
			pi.registerTool({
				name: "memory_reflect",
				label: "反思",
				description: "基于记忆库做综合推理（例如“用户最近在关注什么”），返回带依据的结论。",
				parameters: Type.Object({ query: Type.String() }),
				annotations: { readOnlyHint: true },
				async execute(_id, p) {
					const r = await reflect(p.query);
					return text(r?.answer ?? "当前记忆后端不支持反思。");
				},
			});
		}
	};
}
