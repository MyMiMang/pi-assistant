/**
 * Claude Code 渠道的纯逻辑：Pi 的消息内容 ↔ claude 的内容、历史渲染成文字、思考强度映射、
 * 「同一轮续接」的判断。不起进程、不碰文件，方便单测（方案 docs/design/cli-models.md §4.3 / §4.4）。
 */
import { createHash } from "node:crypto";
import type { AssistantMessage, ImageContent, Message, TextContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { CallToolResult, Tool } from "../../cli-agents/tool-bridge.ts";

/** Anthropic 内容块（文字 / 图片），原样写进 claude 的 stdin */
export type ClaudeBlock = Record<string, unknown>;
type PiContent = string | (TextContent | ImageContent)[];

/** 去掉开头的 system 消息，剩下的是真正的对话。 */
export const conversationOf = (messages: readonly Message[]): Message[] => messages.filter((m) => m.role !== "system");

/** Pi 用户内容 → claude 内容块。空文字块 Anthropic 会拒绝，去掉。 */
export function userContentToClaude(content: PiContent): ClaudeBlock[] {
	if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
	const out: ClaudeBlock[] = [];
	for (const b of content) {
		if (b.type === "text") {
			if (b.text) out.push({ type: "text", text: b.text });
		} else out.push({ type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } });
	}
	return out;
}

/** Pi 的工具结果 → MCP `CallToolResult`（文字和图片都要带上）。 */
export function toolResultToMcp(msg: Pick<ToolResultMessage, "content" | "isError">): CallToolResult {
	const content: CallToolResult["content"] = [];
	for (const b of msg.content) {
		if (b.type === "text") {
			if (b.text) content.push({ type: "text", text: b.text });
		} else content.push({ type: "image", data: b.data, mimeType: b.mimeType });
	}
	if (!content.length) content.push({ type: "text", text: msg.isError ? "工具执行失败，没有输出" : "（没有输出）" });
	return { content, ...(msg.isError ? { isError: true } : {}) };
}

/** Pi 的思考强度 → `claude --effort`。off / 没有 → 不传（claude 用自己的默认）；minimal 对应 claude 最低的 low。 */
export function thinkingToEffort(level: string | undefined): string | undefined {
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
		case "high":
		case "xhigh":
		case "max":
			return level;
		default:
			return undefined;
	}
}

const textOf = (c: PiContent): string => (typeof c === "string" ? c : c.map((b) => (b.type === "text" ? b.text : "[图片]")).join(""));

/** 一条助理消息渲染成文字（思考不要；工具调用写成一行） */
function assistantText(m: AssistantMessage): string {
	const parts: string[] = [];
	for (const b of m.content) {
		if (b.type === "text" && b.text) parts.push(b.text);
		else if (b.type === "toolCall") parts.push(`[调用工具 ${b.name}(${JSON.stringify(b.arguments)})]`);
	}
	return parts.join("\n");
}

/** 历史渲染成文字，给「新开 claude 会话」当第一条消息的前文。图片只留占位（真正要看的图在最新那条用户消息里）。 */
export function renderTranscript(messages: readonly Message[]): string {
	const lines: string[] = [];
	for (const m of messages) {
		if (m.role === "user") lines.push(`用户：${textOf(m.content)}`);
		else if (m.role === "assistant") lines.push(`助理：${assistantText(m)}`);
		else if (m.role === "toolResult") lines.push(`[工具 ${m.toolName} 的结果${m.isError ? "（出错）" : ""}：${textOf(m.content)}]`);
	}
	return lines.join("\n\n");
}

/**
 * 新开会话时送给 claude 的第一条消息：最后一个助理 / 工具结果之后的用户消息是「这次的输入」（保留文字和图片原样），
 * 在它前面的全部历史渲染成文字。上下文以工具结果结尾（没有活着的进程可以续接）时，补一句让它接着做。
 */
export function renderFreshInput(messages: readonly Message[]): ClaudeBlock[] {
	const conv = conversationOf(messages);
	let tail = conv.length;
	while (tail > 0 && conv[tail - 1].role === "user") tail--;
	const history = conv.slice(0, tail);
	const current = conv.slice(tail) as UserMessage[];
	const blocks = current.flatMap((m) => userContentToClaude(m.content));
	if (!history.length) return blocks.length ? blocks : [{ type: "text", text: "（空）" }];
	const resume = current.length ? "以下是用户的新消息：" : "（上面的工具已经执行完，请根据结果接着完成任务。）";
	return [{ type: "text", text: `以下是你和用户之前的对话记录，请接着这段对话回答，不要复述：\n\n${renderTranscript(history)}\n\n${resume}` }, ...blocks];
}

export interface Continuation {
	/** 按 toolCallId 的工具结果 */
	results: Map<string, ToolResultMessage>;
	/** 工具结果之后新来的用户消息（Pi 的插话） */
	extras: UserMessage[];
}

/**
 * 判断这次 `streamSimple` 是不是「同一轮续接」：最后一条助理消息的 toolCall 正好是挂着等结果的那几个，
 * 后面跟着它们的工具结果（也许还有新的用户消息）。对不上返回 null。
 */
export function matchContinuation(messages: readonly Message[], pendingIds: ReadonlySet<string>): Continuation | null {
	if (!pendingIds.size) return null;
	const conv = conversationOf(messages);
	let ai = -1;
	for (let i = conv.length - 1; i >= 0; i--)
		if (conv[i].role === "assistant") {
			ai = i;
			break;
		}
	if (ai < 0) return null;
	const called = (conv[ai] as AssistantMessage).content.flatMap((b) => (b.type === "toolCall" ? [b.id] : []));
	if (called.length !== pendingIds.size || !called.every((id) => pendingIds.has(id))) return null;
	const results = new Map<string, ToolResultMessage>();
	const extras: UserMessage[] = [];
	for (const m of conv.slice(ai + 1)) {
		if (m.role === "toolResult") {
			if (pendingIds.has(m.toolCallId)) results.set(m.toolCallId, m);
		} else if (m.role === "user") extras.push(m);
		else return null;
	}
	return called.every((id) => results.has(id)) ? { results, extras } : null;
}

/** 多条用户消息的内容拼成一组 claude 内容块 */
export const userMessagesToClaude = (msgs: readonly UserMessage[]): ClaudeBlock[] => msgs.flatMap((m) => userContentToClaude(m.content));

/** Pi 的工具定义 → 名字 / 说明 / JSON Schema（claude 的 MCP 工具、codex 的动态工具共用；参数顶层必须是 object）。 */
export const toolDefOf = (t: { name: string; description: string; parameters: unknown }): Tool => {
	const schema = JSON.parse(JSON.stringify(t.parameters ?? {})) as Record<string, unknown>;
	return { name: t.name, description: t.description, inputSchema: { ...schema, type: "object" } as Tool["inputSchema"] };
};

/** Codex `turn/start` / `turn/steer` 的输入项（文字 / 图片） */
export type CodexInputItem = { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string };

/** claude 内容块（文字 / base64 图片，`renderFreshInput` 等的统一输出）→ Codex 输入项。 */
export function blocksToCodexInput(blocks: readonly ClaudeBlock[]): CodexInputItem[] {
	const out: CodexInputItem[] = [];
	for (const b of blocks) {
		if (b.type === "text" && typeof b.text === "string" && b.text) out.push({ type: "text", text: b.text, text_elements: [] });
		else if (b.type === "image") {
			const src = b.source as { media_type?: string; data?: string } | undefined;
			if (src?.data) out.push({ type: "image", url: `data:${src.media_type ?? "image/png"};base64,${src.data}` });
		}
	}
	return out;
}

/** claude 内容块（文字 / base64 图片）→ ACP `session/prompt` 的内容块（`text` / `image`，要命令行声明了 `promptCapabilities.image`）。 */
export function blocksToAcpPrompt(input: string | readonly ClaudeBlock[]): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
	if (typeof input === "string") return [{ type: "text", text: input }];
	const out: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
	for (const b of input) {
		if (b.type === "text" && typeof b.text === "string" && b.text) out.push({ type: "text", text: b.text });
		else if (b.type === "image") {
			const src = b.source as { media_type?: string; data?: string } | undefined;
			if (src?.data) out.push({ type: "image", data: src.data, mimeType: src.media_type ?? "image/png" });
		}
	}
	return out.length ? out : [{ type: "text", text: "（空）" }];
}

/** Pi 的工具结果 → Codex 动态工具的回包（文字 `inputText`、图片 `inputImage`）。 */
export function toolResultToCodex(msg: Pick<ToolResultMessage, "content" | "isError">): { success: boolean; contentItems: Array<{ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }> } {
	const contentItems: Array<{ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }> = [];
	for (const b of msg.content) {
		if (b.type === "text") {
			if (b.text) contentItems.push({ type: "inputText", text: b.text });
		} else contentItems.push({ type: "inputImage", imageUrl: `data:${b.mimeType};base64,${b.data}` });
	}
	if (!contentItems.length) contentItems.push({ type: "inputText", text: msg.isError ? "工具执行失败，没有输出" : "（没有输出）" });
	return { success: !msg.isError, contentItems };
}

/**
 * 续用判断用的指纹「模型 + 工具集 + 系统提示」：codex（`thread/resume` 没有动态工具）、agy（提示和 MCP 配置在会话开始时定死）和 ACP 渠道共用。
 * 任何一个变了就不续用旧会话。
 */
export const toolsPromptComposite = (modelId: string, tools: readonly Tool[], systemPrompt: string | undefined): string =>
	`${modelId}#${createHash("sha1").update(`${JSON.stringify(tools.map((t) => [t.name, t.description, t.inputSchema]))}\0${systemPrompt ?? ""}`).digest("hex")}`;

/** 统一内容块 → 纯文字（agy 的 stdin 只验证过文字消息；图片留占位，真正要看图的渠道不走这里） */
export function blocksToPlainText(input: string | readonly ClaudeBlock[]): string {
	if (typeof input === "string") return input;
	return input.map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : b.type === "image" ? "[图片]" : "")).filter(Boolean).join("\n\n");
}
