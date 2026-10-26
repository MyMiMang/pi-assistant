/**
 * 跨轮续用 claude 会话（方案 §4.4）：按 Pi 会话记一张对照表，
 * 每项 = claude 会话 id + 已同步到 Pi 的哪一条（条数）+ 这段前缀的指纹 + 当时的模型。
 *
 * 新一轮来时，Pi 给的历史前缀对得上（条数够、指纹一致、模型没换）、且之后只多了用户消息，就 `--resume` 并只发新增内容；
 * 对不上（整理过上下文、从某条分支、换过模型、对照表丢了、上一轮被中止）就新开会话，把 Pi 当前上下文渲染成文字送进去。
 * 对照表放内存，同时写一份小 JSON 到数据目录（服务重启后还能续上）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { conversationOf, renderFreshInput, userMessagesToClaude, type ClaudeBlock } from "./convert.ts";

export interface SyncEntry {
	claudeSessionId: string;
	/** 已同步的消息条数（不含 system 消息；包含这一轮 claude 回答的最后那条助理消息） */
	count: number;
	/** 前 `count` 条消息的链式指纹 */
	fingerprint: string;
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
			return sha(`a|${m.content.map((b) => (b.type === "text" ? `t:${b.text}` : b.type === "toolCall" ? `c:${b.id}:${b.name}` : "")).filter(Boolean).join("|")}`);
		case "toolResult":
			return sha(`r|${m.toolCallId}|${m.isError ? 1 : 0}|${m.content.map((b) => (b.type === "text" ? `t:${b.text}` : `i:${sha(b.data)}`)).join("|")}`);
		default:
			return sha("s");
	}
}

/** 前 `count` 条对话消息（不含 system）的链式指纹 */
export function prefixFingerprint(messages: readonly Message[], count: number): string {
	let h = "";
	for (const m of conversationOf(messages).slice(0, count)) h = sha(h + messageHash(m));
	return h;
}

/** 这一轮正常结束（`result`）后记下的对照项：`messages` 是这次请求时 Pi 给的上下文，`reply` 是我们刚回答的那条助理消息。 */
export function makeSyncEntry(claudeSessionId: string, model: string, messages: readonly Message[], reply: Message, now = Date.now()): SyncEntry {
	const all = [...conversationOf(messages), reply];
	return { claudeSessionId, count: all.length, fingerprint: prefixFingerprint(all, all.length), model, updatedAt: now };
}

export type TurnPlan =
	| { mode: "resume"; claudeSessionId: string; input: ClaudeBlock[] }
	/** `reason`：为什么没续上，给日志 / 测试看 */
	| { mode: "fresh"; reason: string; input: ClaudeBlock[] };

/** 决定这一轮是续用 claude 会话，还是新开会话（纯函数）。 */
export function planTurn(entry: SyncEntry | undefined, model: string, messages: readonly Message[]): TurnPlan {
	const fresh = (reason: string): TurnPlan => ({ mode: "fresh", reason, input: renderFreshInput(messages) });
	if (!entry) return fresh("没有对照表");
	if (entry.model !== model) return fresh("换过模型");
	const conv = conversationOf(messages);
	if (conv.length <= entry.count) return fresh("没有新消息（上下文变短或被整理过）");
	if (prefixFingerprint(conv, entry.count) !== entry.fingerprint) return fresh("历史前缀对不上（整理过上下文或从某条分支）");
	const delta = conv.slice(entry.count);
	if (!delta.every((m) => m.role === "user")) return fresh("新增部分里有助理 / 工具消息");
	const input = userMessagesToClaude(delta as never);
	if (!input.length) return fresh("新增的用户消息是空的");
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
			for (const [k, v] of Object.entries(raw)) if (v && typeof v.claudeSessionId === "string" && typeof v.count === "number") this.map.set(k, v);
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
