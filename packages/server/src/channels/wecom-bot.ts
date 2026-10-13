/**
 * 企业微信「智能机器人」长连接模式（官方 @wecom/aibot-node-sdk，MIT）：不需要公网地址、不需要 Token/EncodingAESKey。
 * 在企业微信管理后台 › 智能机器人 › 创建机器人 › API 模式，连接方式选“长连接”，拿到 Bot ID 和 Secret。
 * 同一个机器人同时只能有一个有效连接（新连接会把旧的踢下线）。
 * 收消息：aibot_msg_callback（单聊、群里 @机器人）；回复：aibot_send_msg 主动推送（Markdown / 模板卡片）；
 * 卡片按钮：template_card_event，5 秒内用 updateTemplateCard 把按钮换成结果。
 */
import { WSClient } from "@wecom/aibot-node-sdk";
import type { AdapterDeps, ChannelAdapter, Inbound } from "./types.ts";
import { clip } from "./types.ts";
import { wecomCard } from "./wecom.ts";

export interface WecomBotConfig {
	botId: string;
	/** 测试用：自定义 WebSocket 地址 */
	wsUrl?: string;
}
export interface WecomBotSecret {
	botSecret: string;
}

interface Frame<T = Record<string, unknown>> {
	headers: { req_id: string };
	body?: T;
}
interface BotMsg {
	msgid: string;
	chatid?: string;
	chattype?: "single" | "group";
	from: { userid: string };
	msgtype: string;
	text?: { content: string };
	event?: { eventtype: string; event_key?: string; task_id?: string };
}

export function wecomBotInbound(b: BotMsg): Inbound | null {
	if (!b?.from?.userid) return null;
	const group = b.chattype === "group";
	let text = b.msgtype === "text" ? (b.text?.content ?? "") : `[${b.msgtype} 消息，暂不支持]`;
	text = text.replace(/^@\S+\s*/, "").trim(); // 群里 @机器人 的前缀
	if (!text) return null;
	const chat = group ? (b.chatid ?? "") : b.from.userid;
	return { userId: b.from.userid, peerId: group ? `chat:${chat}` : b.from.userid, text, group, msgId: b.msgid, ctx: { chatId: chat, group } };
}

export function wecomBotAdapter(d: AdapterDeps<WecomBotConfig, WecomBotSecret>): ChannelAdapter {
	let ws: WSClient | null = null;
	let authed = false;
	const client = () => {
		if (!ws || !authed) throw new Error("企业微信长连接未建立");
		return ws;
	};
	return {
		async start() {
			d.setStatus({ state: "connecting", detail: "正在建立长连接…" });
			ws = new WSClient({ botId: d.config.botId, secret: d.secret.botSecret, ...(d.config.wsUrl ? { wsUrl: d.config.wsUrl } : {}), maxReconnectAttempts: -1, logger: { debug() {}, info() {}, warn() {}, error() {} } as never });
			ws.on("authenticated", () => ((authed = true), d.setStatus({ state: "online", detail: "长连接已建立" })));
			ws.on("disconnected", (reason: string) => ((authed = false), d.setStatus({ state: "connecting", detail: `连接断开（${reason}），正在重连…` })));
			ws.on("error", (e: Error) => d.setStatus({ state: "error", detail: `连接失败：${e.message}` }));
			ws.on("event.disconnected_event" as never, () => ((authed = false), d.setStatus({ state: "error", detail: "被新的连接踢下线（同一机器人只能有一个连接）" })));
			ws.on("message", (f: Frame<BotMsg>) => {
				const m = f.body && wecomBotInbound(f.body);
				if (m) d.onMessage(m);
			});
			ws.on("event.template_card_event" as never, (f: Frame<BotMsg>) => {
				const b = f.body;
				const key = b?.event?.event_key;
				if (!b || !key || !d.onAction) return;
				void d
					.onAction({ userId: b.from.userid, action: key, ctx: { chatId: b.chattype === "group" ? b.chatid : b.from.userid } })
					.then((result) => ws?.updateTemplateCard(f as never, { card_type: "button_interaction", main_title: { title: result.slice(0, 26) }, task_id: b.event?.task_id, button_list: [{ text: result.slice(0, 10), style: 2, key: "done" }] } as never, [b.from.userid]))
					.catch(() => {});
			});
			ws.connect();
		},
		async stop() {
			ws?.disconnect();
			ws = null;
			authed = false;
			d.setStatus({ state: "off", detail: "已停止" });
		},
		async send(ctx, markdown) {
			const f = (await client().sendMessage(String(ctx.chatId), { msgtype: "markdown", markdown: { content: clip(markdown, 4000) } })) as { errcode?: number; errmsg?: string };
			if (f?.errcode) throw new Error(`企业微信发送失败：${f.errcode} ${f.errmsg ?? ""}`);
		},
		async sendFile(ctx, path, name, o) {
			if (o?.caption) await this.send(ctx, o.caption);
			const type = o?.kind === "image" ? "image" : "file";
			const { readFileSync } = await import("node:fs");
			const up = await client().uploadMedia(readFileSync(path), { type, filename: name });
			if (!up?.media_id) throw new Error("企业微信上传素材失败");
			const f = (await client().sendMediaMessage(String(ctx.chatId), type, up.media_id)) as { errcode?: number; errmsg?: string };
			if (f?.errcode) throw new Error(`企业微信发送失败：${f.errcode} ${f.errmsg ?? ""}`);
		},
		async sendCard(ctx, card) {
			const f = (await client().sendMessage(String(ctx.chatId), { msgtype: "template_card", template_card: wecomCard(card) as never })) as { errcode?: number; errmsg?: string };
			if (f?.errcode) throw new Error(`企业微信发送失败：${f.errcode} ${f.errmsg ?? ""}`);
		},
		async test() {
			if (ws && authed) return "长连接正常";
			// 临时连一次验证凭据（注意：会把正在运行的连接踢下线，所以只在没运行时测）
			const t = new WSClient({ botId: d.config.botId, secret: d.secret.botSecret, ...(d.config.wsUrl ? { wsUrl: d.config.wsUrl } : {}), maxReconnectAttempts: 0, maxAuthFailureAttempts: 0, logger: { debug() {}, info() {}, warn() {}, error() {} } as never });
			try {
				await new Promise<void>((res, rej) => {
					const timer = setTimeout(() => rej(new Error("10 秒内没有完成认证")), 10_000);
					t.on("authenticated", () => (clearTimeout(timer), res()));
					t.on("error", (e: Error) => (clearTimeout(timer), rej(new Error(`凭据无效或连不上：${e.message}`))));
					t.connect();
				});
				return "Bot ID / Secret 有效";
			} finally {
				t.disconnect();
			}
		},
	};
}
