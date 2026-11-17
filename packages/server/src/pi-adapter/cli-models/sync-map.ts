/**
 * 跨轮续用 claude 会话（方案 §4.4）：按 Pi 会话记一张对照表，
 * 每项 = 工具会话 id + 最后看到的消息标识 + 当时的模型/工具/系统规则。
 * 再切回来只补发锚点之后的对话；锚点已被整理时补发期间摘要。
 * 对照表放内存，同时写一份小 JSON 到数据目录（服务重启后还能续上）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { conversationOf, renderFreshInput, type ClaudeBlock } from "./convert.ts";
import { inputChars, renderDelta, summaryOf } from "./context-input.ts";

export interface SyncEntry {
	claudeSessionId: string;
	/** 时间戳与内容指纹共同标识工具最后看到的消息。 */
	lastSeen: string;
	/** 当时用的 claude 模型（`opus` 等）；换了就不续用 */
	model: string;
	updatedAt: number;
}

const sha = (s: string): string => createHash("sha1").update(s).digest("hex");

/** 一条消息的指纹：角色 + 文字 + 图片摘要 + 工具调用 / 结果的 id 和名字。思考内容不算（回传时可能被改写）。 */
export function messageHash(m: Message): string {
	switch (m.role) {
		case "user":
			return sha(`u|${typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? `t:${b.text}` : `i:${sha(b.data)}`)).join("|")}`);
		case "assistant":
			return sha(`a|${m.content.map((b) => (b.type === "text" ? `t:${b.text}` : b.type === "toolCall" ? `c:${b.id}:${b.name}:${JSON.stringify(b.arguments)}` : "")).filter(Boolean).join("|")}`);
		case "toolResult":
			return sha(`r|${m.toolCallId}|${m.isError ? 1 : 0}|${m.content.map((b) => (b.type === "text" ? `t:${b.text}` : `i:${sha(b.data)}`)).join("|")}`);
		default:
			return sha("s");
	}
}

export const messageAnchor = (m: Message): string => `${m.timestamp}:${messageHash(m)}`;

/** 这一轮正常结束（`result`）后记下的对照项：`messages` 是这次请求时 Pi 给的上下文，`reply` 是我们刚回答的那条助理消息。 */
export function makeSyncEntry(claudeSessionId: string, model: string, messages: readonly Message[], reply: Message, now = Date.now()): SyncEntry {
	return { claudeSessionId, lastSeen: messageAnchor(reply), model, updatedAt: now };
}

export type TurnPlan =
	| { mode: "resume"; claudeSessionId: string; input: ClaudeBlock[] }
	/** `reason`：为什么没续上，给日志 / 测试看 */
	| { mode: "fresh"; reason: string; input: ClaudeBlock[] };

/** 决定这一轮是续用 claude 会话，还是新开会话（纯函数）。 */
export function planTurn(entry: SyncEntry | undefined, model: string, messages: readonly Message[], freshInputMaxChars?: number): TurnPlan {
	const fresh = (reason: string): TurnPlan => ({ mode: "fresh", reason, input: renderFreshInput(messages, freshInputMaxChars) });
	if (!entry) return fresh("没有对照表");
	if (entry.model !== model) return fresh("换过模型");
	const conv = conversationOf(messages);
	const anchor = conv.findLastIndex((m) => messageAnchor(m) === entry.lastSeen);
	const summarized = anchor < 0 && !!summaryOf(conv);
	if (anchor < 0 && !summarized) return fresh("最后看到的消息已不在上下文且没有摘要");
	const input = renderDelta(anchor < 0 ? conv : conv.slice(anchor + 1), summarized);
	if (!input.length) return fresh("没有新消息");
	if (freshInputMaxChars !== undefined && inputChars(input) > freshInputMaxChars) return fresh("补发内容超过渠道上限");
	return { mode: "resume", claudeSessionId: entry.claudeSessionId, input };
}

const MAX_ENTRIES = 500;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/** 内存 + 小 JSON 文件。文件坏了 / 读不到当作空表（只是少了续用，不影响对话）。 */
export class SyncStore {
	private map = new Map<string, SyncEntry>();
	private loaded = false;

	constructor(private readonly file: string | null) {}

	private load(): void {
		if (this.loaded) return;
		this.loaded = true;
		if (!this.file || !existsSync(this.file)) return;
		try {
			const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, SyncEntry>;
			for (const [k, v] of Object.entries(raw)) if (v && typeof v.claudeSessionId === "string" && typeof v.lastSeen === "string") this.map.set(k, v);
		} catch {
			// 坏文件：忽略
		}
	}

	get(key: string): SyncEntry | undefined {
		this.load();
		return this.map.get(key);
	}

	set(key: string, entry: SyncEntry): void {
		this.load();
		this.map.set(key, entry);
		this.save();
	}

	delete(key: string): void {
		this.load();
		if (this.map.delete(key)) this.save();
	}

	private save(): void {
		if (!this.file) return;
		const now = Date.now();
		const live = [...this.map].filter(([, v]) => now - v.updatedAt < MAX_AGE_MS).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_ENTRIES);
		this.map = new Map(live);
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			const tmp = `${this.file}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(Object.fromEntries(live)));
			renameSync(tmp, this.file);
		} catch {
			// 写不了不影响对话，下次重开会话而已
		}
	}
}
