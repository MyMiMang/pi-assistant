import { randomUUID } from "node:crypto";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { cleanEndpoint, scopedProtocol } from "./relay-capabilities.ts";

export interface SendCapability {
	vision?: boolean;
	levels?: Record<string, string | null>;
	reasoning?: boolean;
}
export type ThinkingIntent = { kind: "unset" } | { kind: "default" | "manual" | "off"; level: string };
export type ImageIntent = { images: ImageContent[]; model: Model<Api>; unknown: boolean; onUnsent?: () => void };
const marker = /\n\[pia-image-intent:([0-9a-f-]{36})\]/g;
const omitted = { type: "text", text: "[图片未附在本次请求中]" } as const;
const identity = (m: Pick<Model<Api>, "provider" | "id" | "api" | "baseUrl">) => JSON.stringify([m.provider, m.id, m.api, cleanEndpoint(m.baseUrl)]);
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

function wireThinking(intent: ThinkingIntent, capability: SendCapability) {
	if (intent.kind === "unset") return undefined;
	const { level } = intent;
	const value = capability.levels && Object.hasOwn(capability.levels, level) ? capability.levels[level] : undefined;
	if (typeof value === "string" && value.trim() && (level === "off" || capability.reasoning === true)) return value.trim();
	if (intent.kind === "default" || (level === "off" && value === null)) return undefined;
	throw new Error(`当前渠道未确认「${level}」思考档或关闭方式。请重新选择；本次未发送。`);
}

const sessions = new WeakMap<AgentSession, ReturnType<typeof attachSendIntent>>();
export const sendIntentOf = (session: AgentSession) => sessions.get(session);

export function attachSendIntent(session: AgentSession, lookup: (model: Model<Api>) => SendCapability | undefined, available: (model: Model<Api>) => boolean) {
	const agent = session.agent;
	const stream = agent.streamFunction;
	const pending = new Map<string, ImageIntent>();
	// Existing SDK image blocks stay native. Authorization is local to this live session,
	// not inferred from a transcript reload, fork, or another room member's context.
	const owners = new Map<string, string>();
	// Pi 的公开 context 扩展会克隆消息；不能用对象引用识别历史图片。
	const nativeKey = (m: AgentSession["agent"]["state"]["messages"][number]) => {
		if (m.role === "toolResult") return `tool:${m.timestamp}:${m.toolCallId}`;
		if (m.role !== "user" || !Array.isArray(m.content)) return;
		for (const part of m.content) if (part.type === "text") {
			const match = part.text.matchAll(marker).next().value;
			if (match) return `user:${m.timestamp}:${match[1]}`;
		}
	};
	const knownVision = (model: Model<Api>, capability = lookup(model)) => capability ? capability.vision === true : model.input.includes("image");
	agent.subscribe((e) => {
		const model = session.model;
		if (e.type !== "message_end" || e.message.role !== "toolResult" || !model || !knownVision(model)) return;
		const key = nativeKey(e.message);
		if (key && e.message.content.some((p) => p.type === "image")) owners.set(key, identity(model));
	});
	let thinking: ThinkingIntent = { kind: "unset" };
	let restore: (() => void) | undefined;
	const reset = () => { restore?.(); restore = undefined; };
	const setting = (model: Model<Api>) => {
		const capability = lookup(model);
		return { capability, effort: capability && wireThinking(thinking, capability) };
	};
	agent.streamFunction = (model, context, options) => {
		const { capability, effort } = setting(model);
		const outbound: ImageIntent[] = [];
		const recipient = identity(model);
		const known = knownVision(model, capability);
		let carriesImages = false;
		const messages = context.messages.map((message) => {
			if (message.role !== "user" && message.role !== "toolResult") return message;
			const selected: ImageIntent[] = [];
			const strip = (text: string) => text.replace(marker, (_match, key: string) => {
				const item = message.role === "user" ? pending.get(key) : undefined;
				if (item) {
					pending.delete(key);
					if (identity(item.model) !== recipient || !available(model) || (item.unknown ? capability?.vision !== undefined || !capability || !scopedProtocol(model.api) : !known)) {
						const error = "会话模型或图片能力已变化；本次图片未送达，请重新发送。";
						item.onUnsent?.();
						throw new Error(error);
					}
					selected.push(item);
				}
				return "";
			});
			const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
			const projected = content.map((part) => part.type === "text" ? { ...part, text: strip(part.text) } : part);
			const native = selected.filter((x) => !x.unknown).reduce((n, x) => n + x.images.length, 0);
			const key = nativeKey(message);
			if (native) {
				if (!key || projected.filter((part) => part.type === "image").length !== native) {
					for (const item of selected) item.onUnsent?.();
					throw new Error("无法编码整批图片；本次未送达。");
				}
				owners.set(key, recipient);
			}
			const cleaned = projected.map((part) => {
				if (part.type !== "image") return part;
				if (!known || !key || owners.get(key) !== recipient) return omitted;
				carriesImages = true;
				return part;
			});
			const trial = selected.filter((x) => x.unknown);
			outbound.push(...trial);
			if (message.role === "toolResult") return { ...message, content: cleaned };
			if (trial.length) return { ...message, content: [...cleaned, ...trial.flatMap((x) => x.images)] };
			return { ...message, content: typeof message.content === "string" ? (cleaned[0] as { text: string }).text : cleaned };
		});
		const unknown = !!outbound.length;
		// Native and trial images both carry user data; neither may be resent on upstream failure.
		const strict = unknown || carriesImages || effort !== undefined;
		const validateRecipient = (actual: Model<Api>) => {
			if (!available(model) || identity(actual) !== recipient) throw new Error("当前选择不可用或接收者已变化；本次未发送，请重新选择模型。");
		};
		const bound = strict || thinking.kind === "manual" || thinking.kind === "off";
		if (bound) validateRecipient(model);
		if (strict && !restore) {
			const retry = session.autoRetryEnabled;
			const compact = session.autoCompactionEnabled;
			restore = () => { session.setAutoRetryEnabled(retry); session.setAutoCompactionEnabled(compact); };
			session.setAutoRetryEnabled(false);
			session.setAutoCompactionEnabled(false);
		} else if (!strict) reset();
		if (!capability && !bound) return stream(model, { ...context, messages }, options);
		let sent = false;
		const requestModel = unknown ? { ...model, input: [...model.input.filter((type) => type !== "image"), "image" as const] } : model;
		return stream(requestModel, { ...context, messages }, {
			...options,
			...(strict ? {
				maxRetries: 0,
				fetch: (input, init) => {
					if (sent) throw new Error("本次图片或思考请求不会自动重发。");
					sent = true;
					return (options?.fetch ?? globalThis.fetch)(input, { ...init, redirect: "error" });
				},
			} : {}),
			onPayload: async (payload, actual) => {
				const effective = await options?.onPayload?.(payload, actual) ?? payload;
				if (bound) validateRecipient(actual);
				if (!capability) return effective;
				if (!record(effective)) throw new Error("无法确认本次模型请求；未发送。");
				const body = { ...effective };
				if (capability) {
					for (const name of ["reasoning_effort", "reasoning", "thinking", "enable_thinking", "chat_template_kwargs", "chat_template_args", "thinking_budget"]) delete body[name];
					if (model.api === "openai-responses" && Array.isArray(body.include)) {
						const keep = body.include.filter((v) => v !== "reasoning.encrypted_content");
						if (keep.length) body.include = keep;
						else delete body.include;
					}
					if (effort !== undefined) {
						if (model.api === "openai-completions") body.reasoning_effort = effort;
						else if (thinking.kind !== "unset" && thinking.level === "off") body.reasoning = { effort };
						else {
							body.reasoning = { effort, summary: "auto" };
							body.include = [...(Array.isArray(body.include) ? body.include : []), "reasoning.encrypted_content"];
						}
					}
				}
				if (outbound.length && scopedProtocol(model.api)) {
					const items = model.api === "openai-completions" ? body.messages : body.input;
					const wire = Array.isArray(items) ? items.flatMap((item) => {
						if (!record(item) || !Array.isArray(item.content)) return [];
						return item.content.flatMap((part) => record(part) && part.type === (model.api === "openai-completions" ? "image_url" : "input_image")
							? [record(part.image_url) ? part.image_url.url : part.image_url] : []);
					}) : [];
					const expected = outbound.flatMap((x) => x.images.map((p) => `data:${p.mimeType};base64,${p.data}`));
					if ((unknown && wire.length !== expected.length) || expected.some((value) => !wire.includes(value))) throw new Error("无法编码本次图片；本次未送达。");
				}
				return body;
			},
		});
	};
	const state = {
		capability: lookup,
		knownVision,
		hasRetainedImages() {
			return agent.state.messages.some((m) => { const key = nativeKey(m); return key !== undefined && owners.has(key); });
		},
		setThinking(intent: ThinkingIntent) { thinking = intent; },
		validate(model: Model<Api> | undefined) { if (model) setting(model); },
		strict(model: Model<Api> | undefined) { return model ? setting(model).effort !== undefined : false; },
		stage(text: string, image: ImageIntent) {
			const key = randomUUID();
			pending.set(key, image);
			return { text: `${text}\n[pia-image-intent:${key}]`, cancel: () => pending.delete(key) };
		},
		unstage(text: string) { for (const match of text.matchAll(marker)) pending.delete(match[1]); },
		settled() {
			reset();
			for (const item of pending.values()) item.onUnsent?.();
			pending.clear();
			const retained = new Set(agent.state.messages.map(nativeKey));
			for (const key of owners.keys()) if (!retained.has(key)) owners.delete(key);
		},
	};
	sessions.set(session, state);
	return state;
}
