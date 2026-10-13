/**
 * 飞书机器人：长连接模式（官方 Node SDK 的 WSClient，不需要公网地址）收消息，OpenAPI 回消息（Markdown 卡片）。
 * 需要：自建应用的 App ID / App Secret；开启机器人能力；事件订阅选“使用长连接接收事件”并添加 im.message.receive_v1；
 * 权限：im:message（获取与发送单聊、群组消息）、im:message:send_as_bot。
 */
import * as lark from "@larksuiteoapi/node-sdk";
import { createReadStream } from "node:fs";
import type { AdapterDeps, ChannelAdapter, Inbound, OutCard } from "./types.ts";
import { clip } from "./types.ts";

export interface FeishuConfig {
	appId: string;
	/** 国际版 Lark 用 "lark"；测试时可填完整地址 */
	domain?: "feishu" | "lark" | string;
}
export interface FeishuSecret {
	appSecret: string;
}

/** 事件 → 统一入站消息（只处理文本；群聊去掉 @机器人 占位） */
export function feishuInbound(data: { sender?: { sender_id?: { open_id?: string; user_id?: string }; sender_type?: string }; message?: { message_id: string; chat_id: string; chat_type: string; message_type: string; content: string; mentions?: { key: string; name: string }[] } }): Inbound | null {
	const m = data.message;
	if (!m || data.sender?.sender_type === "app") return null;
	let text = "";
	try {
		const c = JSON.parse(m.content) as { text?: string; content?: { tag: string; text?: string }[][]; title?: string };
		text = c.text ?? [c.title, ...(c.content ?? []).flat().map((x) => x.text ?? "")].filter(Boolean).join(" ");
	} catch {}
	if (m.message_type !== "text" && m.message_type !== "post") text = text || `[${m.message_type} 消息，暂不支持]`;
	for (const at of m.mentions ?? []) text = text.replaceAll(at.key, "");
	text = text.trim();
	if (!text) return null;
	const user = data.sender?.sender_id?.open_id ?? data.sender?.sender_id?.user_id ?? "unknown";
	const group = m.chat_type !== "p2p";
	return { userId: user, peerId: group ? `chat:${m.chat_id}` : user, text, group, msgId: m.message_id, ctx: { chatId: m.chat_id } };
}

/** 卡片（JSON 1.0）：Markdown 正文 + 按钮行 */
export function feishuCard(card: OutCard, done?: string) {
	return {
		config: { wide_screen_mode: true, update_multi: true },
		header: { template: done ? "grey" : "blue", title: { tag: "plain_text", content: card.title } },
		elements: [
			{ tag: "markdown", content: clip(card.body, 2500) },
			done
				? { tag: "note", elements: [{ tag: "plain_text", content: done }] }
				: { tag: "action", actions: card.buttons.map((b) => ({ tag: "button", text: { tag: "plain_text", content: b.label }, type: b.style ?? "default", value: { pia: b.action } })) },
		],
	};
}
/** 按钮回调 → onAction；返回 toast（并把按钮换成结果） */
export async function feishuCardAction(data: { operator?: { open_id?: string; user_id?: string; name?: string }; action?: { value?: { pia?: string } }; context?: { open_chat_id?: string }; open_chat_id?: string }, onAction?: AdapterDeps<unknown, unknown>["onAction"]) {
	const action = data.action?.value?.pia;
	const user = data.operator?.open_id ?? data.operator?.user_id;
	if (!action || !user || !onAction) return { toast: { type: "warning", content: "这个按钮已失效" } };
	const result = await onAction({ userId: user, action, display: data.operator?.name, ctx: { chatId: data.context?.open_chat_id ?? data.open_chat_id } });
	return { toast: { type: /失败|无权|失效|没有/.test(result) ? "warning" : "success", content: result } };
}

export function feishuAdapter(d: AdapterDeps<FeishuConfig, FeishuSecret>): ChannelAdapter {
	const domain = d.config.domain === "lark" ? lark.Domain.Lark : d.config.domain && d.config.domain !== "feishu" ? d.config.domain : lark.Domain.Feishu;
	const client = new lark.Client({ appId: d.config.appId, appSecret: d.secret.appSecret, domain, loggerLevel: lark.LoggerLevel.warn });
	let ws: lark.WSClient | null = null;
	return {
		async start() {
			d.setStatus({ state: "connecting", detail: "正在建立长连接…" });
			const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.warn }).register({
				"im.message.receive_v1": async (data: unknown) => {
					const m = feishuInbound(data as never);
					if (m) d.onMessage(m);
				},
			} as never).register({
				// 卡片按钮回调（长连接同样能收到，需要在“事件与回调 › 回调配置”里订阅 card.action.trigger）
				"card.action.trigger": async (data: unknown) => feishuCardAction(data as never, d.onAction),
			});
			ws = new lark.WSClient({
				appId: d.config.appId,
				appSecret: d.secret.appSecret,
				domain,
				loggerLevel: lark.LoggerLevel.warn,
				source: "pi-assistant",
				onReady: () => d.setStatus({ state: "online", detail: "长连接已建立" }),
				onError: (e: Error) => d.setStatus({ state: "error", detail: `连接失败：${e.message}` }),
				onReconnecting: () => d.setStatus({ state: "connecting", detail: "正在重连…" }),
				onReconnected: () => d.setStatus({ state: "online", detail: "长连接已建立" }),
			} as never);
			await ws.start({ eventDispatcher: dispatcher });
		},
		async stop() {
			(ws as unknown as { close?: (p?: unknown) => void } | null)?.close?.({ force: true });
			ws = null;
			d.setStatus({ state: "off", detail: "已停止" });
		},
		async sendCard(ctx, card) {
			const r = (await client.im.v1.message.create({
				params: { receive_id_type: "chat_id" },
				data: { receive_id: String(ctx.chatId), msg_type: "interactive", content: JSON.stringify(feishuCard(card)) },
			})) as { code?: number; msg?: string };
			if (r.code) throw new Error(`飞书发送失败：${r.code} ${r.msg ?? ""}`);
		},
		async send(ctx, markdown) {
			const r = (await client.im.v1.message.create({
				params: { receive_id_type: "chat_id" },
				data: { receive_id: String(ctx.chatId), msg_type: "interactive", content: JSON.stringify({ config: { wide_screen_mode: true }, elements: [{ tag: "markdown", content: clip(markdown) }] }) },
			})) as { code?: number; msg?: string };
			if (r.code) throw new Error(`飞书发送失败：${r.code} ${r.msg ?? ""}`);
		},
		async sendFile(ctx, path, name, o) {
			if (o?.caption) await this.send(ctx, o.caption);
			const chat = { params: { receive_id_type: "chat_id" as const } };
			if (o?.kind === "image") {
				const up = (await client.im.v1.image.create({ data: { image_type: "message", image: createReadStream(path) as never } })) as { image_key?: string; data?: { image_key?: string }; code?: number; msg?: string } | null;
				const key = up?.image_key ?? up?.data?.image_key;
				if (!key) throw new Error(`飞书上传图片失败：${up?.code ?? ""} ${up?.msg ?? ""}`);
				const r = (await client.im.v1.message.create({ ...chat, data: { receive_id: String(ctx.chatId), msg_type: "image", content: JSON.stringify({ image_key: key }) } })) as { code?: number; msg?: string };
				if (r.code) throw new Error(`飞书发送图片失败：${r.code} ${r.msg ?? ""}`);
				return;
			}
			const e = name.split(".").pop()?.toLowerCase() ?? "";
			const fileType = ["pdf", "doc", "xls", "ppt", "mp4", "opus"].includes(e) ? e : e === "docx" ? "doc" : e === "xlsx" ? "xls" : e === "pptx" ? "ppt" : "stream";
			const up = (await client.im.v1.file.create({ data: { file_type: fileType as never, file_name: name, file: createReadStream(path) as never } })) as { file_key?: string; data?: { file_key?: string }; code?: number; msg?: string } | null;
			const key = up?.file_key ?? up?.data?.file_key;
			if (!key) throw new Error(`飞书上传文件失败：${up?.code ?? ""} ${up?.msg ?? ""}`);
			const r = (await client.im.v1.message.create({ ...chat, data: { receive_id: String(ctx.chatId), msg_type: "file", content: JSON.stringify({ file_key: key }) } })) as { code?: number; msg?: string };
			if (r.code) throw new Error(`飞书发送文件失败：${r.code} ${r.msg ?? ""}`);
		},
		async test() {
			const r = (await client.auth.v3.tenantAccessToken.internal({ data: { app_id: d.config.appId, app_secret: d.secret.appSecret } })) as { code?: number; msg?: string };
			if (r.code) throw new Error(`凭据无效：${r.code} ${r.msg ?? ""}`);
			return "App ID / App Secret 有效";
		},
	};
}
