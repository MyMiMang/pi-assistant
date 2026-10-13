/**
 * 钉钉机器人：Stream 模式（官方 dingtalk-stream SDK，不需要公网地址）收消息；
 * 回复优先用消息里带的 sessionWebhook（有效期内），过期后用机器人单聊批量发送接口。
 * 需要：钉钉开放平台企业内部应用的 Client ID（AppKey）/ Client Secret；添加“机器人”能力，消息接收模式选 Stream 模式；
 * 主动发消息需要权限“企业内机器人发送消息”（qyapi_robot_sendmsg）。
 */
import { readFileSync } from "node:fs";
import { DWClient, TOPIC_ROBOT, type DWClientDownStream } from "dingtalk-stream";
import type { AdapterDeps, ChannelAdapter, Inbound, OutCard } from "./types.ts";
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

/**
 * 钉钉的按钮：ActionCard 的按钮链接用 dtmd://dingtalkclient/sendMessage?content=…，
 * 点按后钉钉替用户把这段文字发给机器人（单聊有效），走普通的文字回复流程（「批准」/「拒绝」/序号）。
 * 这样不需要在卡片平台建模板，也不需要额外的回调权限。
 */
export const dtmd = (text: string) => `dtmd://dingtalkclient/sendMessage?content=${encodeURIComponent(text)}`;
export function dingtalkCardText(card: OutCard): { title: string; text: string; btns: { title: string; actionURL: string }[] } {
	const btns = card.buttons.map((b) => ({ title: b.label, actionURL: dtmd(b.text) }));
	return { title: card.title.slice(0, 30), text: `### ${card.title}\n\n${clip(card.body, 3000)}\n\n${card.fallback}`, btns };
}

export function dingtalkAdapter(d: AdapterDeps<DingtalkConfig, DingtalkSecret>): ChannelAdapter {
	const api = d.config.apiBase ?? "https://api.dingtalk.com";
	const oapi = d.config.apiBase ?? "https://oapi.dingtalk.com";
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
		async sendCard(ctx, card) {
			const c = dingtalkCardText(card);
			// 群聊里 dtmd 链接发出的文字不会 @机器人，机器人收不到：群聊退回文字
			if (ctx.group || c.btns.length > 5 || !c.btns.length) return this.send(ctx, `**${card.title}**\n\n${card.body}\n\n${card.fallback}`);
			if (ctx.sessionWebhook && Number(ctx.expires ?? 0) > Date.now() + 5000) {
				const r = await fetch(String(ctx.sessionWebhook), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ msgtype: "actionCard", actionCard: { title: c.title, text: c.text, btnOrientation: c.btns.length <= 2 ? "1" : "0", btns: c.btns } }) });
				const j = (await r.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
				if (!r.ok || j.errcode) throw new Error(`钉钉发送失败：${j.errmsg ?? r.status}`);
				return;
			}
			if (!ctx.staffId) throw new Error("会话已过期：请在钉钉里再发一条消息给机器人");
			// 主动发送：sampleActionCard2…5（竖向 2~5 个按钮）
			const n = Math.max(2, c.btns.length);
			const param: Record<string, string> = { title: c.title, text: c.text };
			c.btns.forEach((b, i) => ((param[`actionTitle${i + 1}`] = b.title), (param[`actionURL${i + 1}`] = b.actionURL)));
			const r = await fetch(`${api}/v1.0/robot/oToMessages/batchSend`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": await accessToken() },
				body: JSON.stringify({ robotCode: ctx.robotCode ?? d.config.clientId, userIds: [ctx.staffId], msgKey: `sampleActionCard${n}`, msgParam: JSON.stringify(param) }),
			});
			if (!r.ok) throw new Error(`钉钉发送失败：HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
		},
		async sendFile(ctx, path, name, o) {
			if (o?.caption) await this.send(ctx, o.caption);
			const type = o?.kind === "image" ? "image" : "file";
			// 上传媒体文件拿 media_id（企业内部应用的 access token 两套接口通用）
			const form = new FormData();
			form.append("media", new Blob([readFileSync(path)]), name);
			const up = (await (await fetch(`${oapi}/media/upload?access_token=${await accessToken()}&type=${type}`, { method: "POST", body: form })).json()) as { errcode?: number; errmsg?: string; media_id?: string };
			if (up.errcode || !up.media_id) throw new Error(`钉钉上传${type === "image" ? "图片" : "文件"}失败：${up.errcode} ${up.errmsg ?? ""}`);
			const ext = name.split(".").pop()?.toLowerCase() || "file";
			const msgKey = type === "image" ? "sampleImageMsg" : "sampleFile";
			const msgParam = JSON.stringify(type === "image" ? { photoURL: up.media_id } : { mediaId: up.media_id, fileName: name, fileType: ext });
			const robotCode = ctx.robotCode ?? d.config.clientId;
			const [url, body] = ctx.group
				? [`${api}/v1.0/robot/groupMessages/send`, { robotCode, openConversationId: ctx.conversationId, msgKey, msgParam }]
				: [`${api}/v1.0/robot/oToMessages/batchSend`, { robotCode, userIds: [ctx.staffId], msgKey, msgParam }];
			if (!ctx.group && !ctx.staffId) throw new Error("拿不到钉钉用户 ID，无法发文件");
			const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": await accessToken() }, body: JSON.stringify(body) });
			if (!r.ok) throw new Error(`钉钉发送失败：HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
		},
		async test() {
			await accessToken();
			return "Client ID / Client Secret 有效";
		},
	};
}
