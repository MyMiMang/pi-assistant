/**
 * 钉钉机器人：Stream 模式（官方 dingtalk-stream SDK，不需要公网地址）收消息；
 * 回复优先用消息里带的 sessionWebhook（有效期内），过期后用机器人单聊批量发送接口。
 * 需要：钉钉开放平台企业内部应用的 Client ID（AppKey）/ Client Secret；添加“机器人”能力，消息接收模式选 Stream 模式；
 * 主动发消息需要权限“企业内机器人发送消息”（qyapi_robot_sendmsg）。
 */
import { DWClient, TOPIC_ROBOT, type DWClientDownStream } from "dingtalk-stream";
import type { AdapterDeps, ChannelAdapter, Inbound } from "./types.ts";
import { clip } from "./types.ts";

export interface DingtalkConfig {
	clientId: string;
	/** 测试用：OpenAPI 地址 */
	apiBase?: string;
}
export interface DingtalkSecret {
	clientSecret: string;
}

export function dingtalkInbound(raw: string): Inbound | null {
	const m = JSON.parse(raw) as { conversationId: string; conversationType: string; senderStaffId?: string; senderId: string; senderNick?: string; msgId: string; msgtype: string; text?: { content: string }; sessionWebhook?: string; sessionWebhookExpiredTime?: number; robotCode?: string };
	const text = (m.msgtype === "text" ? (m.text?.content ?? "") : `[${m.msgtype} 消息，暂不支持]`).trim();
	if (!text) return null;
	const user = m.senderStaffId || m.senderId;
	const group = m.conversationType === "2";
	return { userId: user, peerId: group ? `chat:${m.conversationId}` : user, display: m.senderNick, text, group, msgId: m.msgId, ctx: { sessionWebhook: m.sessionWebhook, expires: m.sessionWebhookExpiredTime, staffId: m.senderStaffId, robotCode: m.robotCode, conversationId: m.conversationId, group } };
}

export function dingtalkAdapter(d: AdapterDeps<DingtalkConfig, DingtalkSecret>): ChannelAdapter {
	const api = d.config.apiBase ?? "https://api.dingtalk.com";
	let client: DWClient | null = null;
	let token: { v: string; exp: number } | null = null;
	const accessToken = async () => {
		if (token && token.exp > Date.now() + 60_000) return token.v;
		const r = await fetch(`${api}/v1.0/oauth2/accessToken`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appKey: d.config.clientId, appSecret: d.secret.clientSecret }) });
		const j = (await r.json()) as { accessToken?: string; expireIn?: number; message?: string };
		if (!j.accessToken) throw new Error(`获取钉钉 access token 失败：${j.message ?? r.status}`);
		token = { v: j.accessToken, exp: Date.now() + (j.expireIn ?? 7200) * 1000 };
		return token.v;
	};
	return {
		async start() {
			d.setStatus({ state: "connecting", detail: "正在建立 Stream 连接…" });
			client = new DWClient({ clientId: d.config.clientId, clientSecret: d.secret.clientSecret, keepAlive: true });
			client.registerCallbackListener(TOPIC_ROBOT, (res: DWClientDownStream) => {
				// 先应答，避免钉钉 60 秒后重推
				client?.socketCallBackResponse(res.headers.messageId, { ok: true });
				try {
					const m = dingtalkInbound(res.data);
					if (m) d.onMessage(m);
				} catch {}
			});
			client.on("open" as never, () => d.setStatus({ state: "online", detail: "Stream 连接已建立" }));
			client.on("close" as never, () => d.setStatus({ state: "connecting", detail: "连接断开，正在重连…" }));
			await client.connect();
			d.setStatus({ state: "online", detail: "Stream 连接已建立" });
		},
		async stop() {
			client?.disconnect();
			client = null;
			d.setStatus({ state: "off", detail: "已停止" });
		},
		async send(ctx, markdown) {
			const text = clip(markdown);
			const title = text.split("\n")[0].replace(/[#*`>]/g, "").slice(0, 30) || "回复";
			if (ctx.sessionWebhook && Number(ctx.expires ?? 0) > Date.now() + 5000) {
				const r = await fetch(String(ctx.sessionWebhook), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ msgtype: "markdown", markdown: { title, text } }) });
				const j = (await r.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
				if (!r.ok || j.errcode) throw new Error(`钉钉发送失败：${j.errmsg ?? r.status}`);
				return;
			}
			if (ctx.group || !ctx.staffId) throw new Error("会话已过期：请在钉钉里再发一条消息给机器人");
			const r = await fetch(`${api}/v1.0/robot/oToMessages/batchSend`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": await accessToken() },
				body: JSON.stringify({ robotCode: ctx.robotCode ?? d.config.clientId, userIds: [ctx.staffId], msgKey: "sampleMarkdown", msgParam: JSON.stringify({ title, text }) }),
			});
			if (!r.ok) throw new Error(`钉钉发送失败：HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
		},
		async test() {
			await accessToken();
			return "Client ID / Client Secret 有效";
		},
	};
}
