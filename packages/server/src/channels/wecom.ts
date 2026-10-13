/**
 * 企业微信自建应用：回调模式收消息（企业微信只支持回调，需要公网 HTTPS 地址——用本应用的远程访问 / 固定地址），
 * OpenAPI（message/send）回消息。回调地址：<你的公网地址>/hooks/channels/wecom/<渠道 ID>。
 * 需要：企业 ID（CorpID）、应用 AgentId、应用 Secret、接收消息的 Token 与 EncodingAESKey；
 * 新建的应用还要在“企业可信 IP”里加入这台电脑的出口 IP，否则发消息会报 60020。
 */
import { readFileSync } from "node:fs";
import type { AdapterDeps, ChannelAdapter, Inbound, OutCard } from "./types.ts";
import { clip, taskId } from "./types.ts";
import { wecomDecrypt, wecomSignature, xmlValue } from "./wecom-crypto.ts";

export interface WecomConfig {
	corpId: string;
	agentId: string;
	apiBase?: string;
}
export interface WecomSecret {
	secret: string;
	token: string;
	aesKey: string;
}

export interface WecomAdapter extends ChannelAdapter {
	/** 处理回调：GET 校验返回 echostr 明文；POST 解密消息，返回 "success" */
	callback(method: string, q: Record<string, string>, body: string): { status: number; body: string };
}

/** 按钮交互型模板卡片（自建应用 message/send 与智能机器人共用这个结构） */
export function wecomCard(card: OutCard) {
	return {
		card_type: "button_interaction",
		main_title: { title: card.title.slice(0, 26), desc: "" },
		sub_title_text: clip(card.body, 1000),
		task_id: taskId(card.buttons[0]?.action ?? "pia"),
		button_list: card.buttons.slice(0, 6).map((b) => ({ text: b.label.slice(0, 10), style: b.style === "danger" ? 3 : b.style === "primary" ? 1 : 2, key: b.action })),
	};
}

export function wecomAdapter(d: AdapterDeps<WecomConfig, WecomSecret>): WecomAdapter {
	const api = d.config.apiBase ?? "https://qyapi.weixin.qq.com";
	let token: { v: string; exp: number } | null = null;
	const seen = new Map<string, number>();
	const accessToken = async () => {
		if (token && token.exp > Date.now() + 60_000) return token.v;
		const r = await fetch(`${api}/cgi-bin/gettoken?corpid=${encodeURIComponent(d.config.corpId)}&corpsecret=${encodeURIComponent(d.secret.secret)}`);
		const j = (await r.json()) as { errcode?: number; errmsg?: string; access_token?: string; expires_in?: number };
		if (j.errcode || !j.access_token) throw new Error(`获取企业微信 access token 失败：${j.errcode} ${j.errmsg ?? ""}`);
		token = { v: j.access_token, exp: Date.now() + (j.expires_in ?? 7200) * 1000 };
		return token.v;
	};
	/** 点按后把按钮换成结果文字（response_code 72 小时内有效，只能用一次） */
	const updateCard = async (user: string, code: string, result: string) => {
		await fetch(`${api}/cgi-bin/message/update_template_card?access_token=${await accessToken()}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ userids: [user], agentid: Number(d.config.agentId), response_code: code, button: { replace_name: result.slice(0, 10) } }),
		});
	};
	const verify = (q: Record<string, string>, enc: string) => wecomSignature(d.secret.token, q.timestamp ?? "", q.nonce ?? "", enc) === q.msg_signature;
	return {
		async start() {
			d.setStatus({ state: "waiting", detail: "等待企业微信回调（需要公网地址）" });
		},
		async stop() {
			d.setStatus({ state: "off", detail: "已停止" });
		},
		callback(method, q, body) {
			if (method === "GET") {
				if (!q.echostr || !verify(q, q.echostr)) return { status: 403, body: "bad signature" };
				const { message, receiveId } = wecomDecrypt(d.secret.aesKey, q.echostr);
				if (receiveId !== d.config.corpId) return { status: 403, body: "bad corp" };
				d.setStatus({ state: "online", detail: "回调地址已验证" });
				return { status: 200, body: message };
			}
			const enc = xmlValue(body, "Encrypt");
			if (!enc || !verify(q, enc)) return { status: 403, body: "bad signature" };
			const { message: xml, receiveId } = wecomDecrypt(d.secret.aesKey, enc);
			if (receiveId !== d.config.corpId) return { status: 403, body: "bad corp" };
			d.setStatus({ state: "online", detail: "正在接收消息" });
			const type = xmlValue(xml, "MsgType");
			const id = xmlValue(xml, "MsgId") ?? `${xmlValue(xml, "FromUserName")}:${xmlValue(xml, "CreateTime")}`;
			// 企业微信 5 秒没收到应答会重推：按 MsgId 去重
			if (seen.has(id)) return { status: 200, body: "success" };
			seen.set(id, Date.now());
			for (const [k, t] of seen) if (Date.now() - t > 600_000) seen.delete(k);
			const user = xmlValue(xml, "FromUserName") ?? "";
			if (type === "event" && xmlValue(xml, "Event") === "template_card_event" && user && d.onAction) {
				const key = xmlValue(xml, "EventKey") ?? "";
				const code = xmlValue(xml, "ResponseCode");
				void d.onAction({ userId: user, action: key, ctx: { userId: user } }).then((result) => (code ? updateCard(user, code, result) : undefined)).catch(() => {});
				return { status: 200, body: "success" };
			}
			if (type === "text" && user) {
				const m: Inbound = { userId: user, peerId: user, text: (xmlValue(xml, "Content") ?? "").trim(), msgId: id, ctx: { userId: user } };
				if (m.text) setImmediate(() => d.onMessage(m));
			} else if (type && type !== "event" && user) setImmediate(() => d.onMessage({ userId: user, peerId: user, text: `[${type} 消息，暂不支持]`, ctx: { userId: user } }));
			return { status: 200, body: "success" };
		},
		async sendCard(ctx, card) {
			const r = await fetch(`${api}/cgi-bin/message/send?access_token=${await accessToken()}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ touser: ctx.userId, msgtype: "template_card", agentid: Number(d.config.agentId), template_card: wecomCard(card) }),
			});
			const j = (await r.json()) as { errcode?: number; errmsg?: string };
			if (j.errcode) throw new Error(`企业微信发送失败：${j.errcode} ${j.errmsg ?? ""}`);
		},
		async send(ctx, markdown) {
			const r = await fetch(`${api}/cgi-bin/message/send?access_token=${await accessToken()}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ touser: ctx.userId, msgtype: "markdown", agentid: Number(d.config.agentId), markdown: { content: clip(markdown, 2000) } }),
			});
			const j = (await r.json()) as { errcode?: number; errmsg?: string };
			if (j.errcode) throw new Error(`企业微信发送失败：${j.errcode} ${j.errmsg ?? ""}${j.errcode === 60020 ? "（请把这台电脑的出口 IP 加到应用的“企业可信 IP”）" : ""}`);
		},
		async sendFile(ctx, path, name, o) {
			if (o?.caption) await this.send(ctx, o.caption);
			const type = o?.kind === "image" ? "image" : "file";
			// 上传临时素材（multipart，3 天有效）→ message/send
			const form = new FormData();
			form.append("media", new Blob([readFileSync(path)]), name);
			const up = (await (await fetch(`${api}/cgi-bin/media/upload?access_token=${await accessToken()}&type=${type}`, { method: "POST", body: form })).json()) as { errcode?: number; errmsg?: string; media_id?: string };
			if (up.errcode || !up.media_id) throw new Error(`企业微信上传${type === "image" ? "图片" : "文件"}失败：${up.errcode} ${up.errmsg ?? ""}`);
			const r = await fetch(`${api}/cgi-bin/message/send?access_token=${await accessToken()}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ touser: ctx.userId, msgtype: type, agentid: Number(d.config.agentId), [type]: { media_id: up.media_id } }),
			});
			const j = (await r.json()) as { errcode?: number; errmsg?: string };
			if (j.errcode) throw new Error(`企业微信发送失败：${j.errcode} ${j.errmsg ?? ""}`);
		},
		async test() {
			await accessToken();
			return "企业 ID / Secret 有效";
		},
	};
}
