import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { renderTranscript, userContentToClaude, type ClaudeBlock } from "./convert.ts";

/** 只拆公开记忆块；其他系统规则仍参与续用指纹。 */
export function splitTurnMemory(prompt: string | undefined): { systemPrompt: string | undefined; memory: string } {
	const blocks: string[] = [];
	const stable = prompt?.replace(/\n{0,2}<memory>\s*[\s\S]*?<\/memory>/g, (block) => {
		blocks.push(block.trim());
		return "";
	});
	return { systemPrompt: stable || undefined, memory: blocks.length ? `本轮相关记忆：\n${blocks.join("\n\n")}` : "" };
}

/** 从 Pi 公开转换 API 取得摘要包装，不依赖私有常量。 */
const probe = convertToLlm([{ role: "compactionSummary", summary: "pia-compaction-probe", tokensBefore: 0, timestamp: 0 }])[0];
const prefix = probe?.role === "user" && Array.isArray(probe.content) && probe.content[0]?.type === "text"
	? probe.content[0].text.split("pia-compaction-probe")[0] : "";
export function summaryOf(messages: readonly Message[]): string {
	if (!prefix) return "";
	for (const m of messages) {
		if (m.role !== "user") continue;
		const text = typeof m.content === "string" ? m.content : m.content.find((b) => b.type === "text")?.text ?? "";
		if (text.startsWith(prefix)) return text;
	}
	return "";
}

/** 用户原始输入保留图片；期间其他模型的回答和工具按共用转录规则渲染。 */
export function renderDelta(messages: readonly Message[], summarized = false): ClaudeBlock[] {
	const blocks: ClaudeBlock[] = [];
	if (summarized) blocks.push({ type: "text", text: "期间的摘要及后续对话：" });
	let history: Message[] = [];
	const flush = () => {
		if (history.length) blocks.push({ type: "text", text: `你不在时的对话：\n\n${renderTranscript(history)}` });
		history = [];
	};
	for (const m of messages) {
		if (m.role === "user") { flush(); blocks.push(...userContentToClaude(m.content)); }
		else if (m.role !== "system") history.push(m);
	}
	flush();
	return blocks;
}

export const inputChars = (blocks: readonly ClaudeBlock[]): number => blocks.reduce((n, b) => n + (b.type === "text" ? String(b.text).length : "[图片]".length), 0);
export const withTurnMemory = (blocks: ClaudeBlock[], memory: string): ClaudeBlock[] => memory ? [{ type: "text", text: memory }, ...blocks] : blocks;
