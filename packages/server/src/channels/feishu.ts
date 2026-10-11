/**
 * 飞书机器人：长连接模式（官方 Node SDK 的 WSClient，不需要公网地址）收消息，OpenAPI 回消息（Markdown 卡片）。
 * 需要：自建应用的 App ID / App Secret；开启机器人能力；事件订阅选“使用长连接接收事件”并添加 im.message.receive_v1；
 * 权限：im:message（获取与发送单聊、群组消息）、im:message:send_as_bot。
 */
import * as lark from "@larksuiteoapi/node-sdk";
import type { AdapterDeps, ChannelAdapter, Inbound } from "./types.ts";
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
		async send(ctx, markdown) {
			const r = (await client.im.v1.message.create({
				params: { receive_id_type: "chat_id" },
				data: { receive_id: String(ctx.chatId), msg_type: "interactive", content: JSON.stringify({ config: { wide_screen_mode: true }, elements: [{ tag: "markdown", content: clip(markdown) }] }) },
			})) as { code?: number; msg?: string };
			if (r.code) throw new Error(`飞书发送失败：${r.code} ${r.msg ?? ""}`);
		},
		async test() {
			const r = (await client.auth.v3.tenantAccessToken.internal({ data: { app_id: d.config.appId, app_secret: d.secret.appSecret } })) as { code?: number; msg?: string };
			if (r.code) throw new Error(`凭据无效：${r.code} ${r.msg ?? ""}`);
			return "App ID / App Secret 有效";
		},
	};
}
