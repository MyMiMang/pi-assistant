/**
 * 聊天渠道：在企业微信 / 飞书 / 钉钉里和助理聊天。
 *  - 每个渠道绑定一个助理；每个联系人（单聊）或群在助理下有自己的对话（不切换 App 里正在看的对话）。
 *  - 安全：只有“绑定”过的人才能使用——在渠道里发送「绑定 123456」（绑定码在 设置 › 渠道 里，用一次就换）。
 *  - 助理的回复、审批卡片、提问都会发回渠道；在渠道里回复「批准」/「拒绝」/「都允许」或选项序号即可处理。
 *  - 凭据加密保存在本机（sealJson），只发给对应平台的官方接口。
 */
import { randomInt } from "node:crypto";
import { bus } from "../bus.ts";
import { createConversation, getConversation } from "../conversations.ts";
import { db, now, uid } from "../db.ts";
import { insertMessage, type MessageRow } from "../messages.ts";
import { requests } from "../requests.ts";
import { getAgent, runtime } from "../runtime.ts";
import { openJson, sealJson } from "../secrets.ts";
import { dingtalkAdapter } from "./dingtalk.ts";
import { feishuAdapter } from "./feishu.ts";
import type { AdapterStatus, CardAction, ChannelAdapter, ChannelKind, Inbound, OutCard } from "./types.ts";
import { decodeAction, encodeAction } from "./types.ts";
import { type WecomAdapter, wecomAdapter } from "./wecom.ts";
import { wecomBotAdapter } from "./wecom-bot.ts";
import { type ClawbotConfig, cancelLogin, loginStatus, startLogin, submitVerifyCode, wechatClawbotAdapter } from "./wechat-clawbot.ts";
import { DeferredSend } from "./types.ts";
import { getFile, saveUpload } from "../files.ts";
import { notify } from "../push.ts";
import { existsSync } from "node:fs";
import { stripThinking } from "../thinking.ts";
import { tunnelStatus } from "../tunnel.ts";
import { CAPS, channelContext, markdownToPlain } from "./caps.ts";
import { prepareMedia, signedPath } from "./media.ts";

export type { ChannelKind } from "./types.ts";
export const KIND_LABEL: Record<ChannelKind, string> = { wecom: "企业微信", wecom_bot: "企业微信", feishu: "飞书", dingtalk: "钉钉", wechat_clawbot: "微信" };
/** 每种渠道需要的字段：config 明文保存，secret 加密保存 */
export const FIELDS: Record<ChannelKind, { config: string[]; secret: string[] }> = {
	feishu: { config: ["appId", "domain"], secret: ["appSecret"] },
	dingtalk: { config: ["clientId", "apiBase"], secret: ["clientSecret"] },
	wecom: { config: ["corpId", "agentId", "apiBase"], secret: ["secret", "token", "aesKey"] },
	wecom_bot: { config: ["botId", "wsUrl"], secret: ["botSecret"] },
	// 凭据来自扫码登录，不由用户填写；apiBase/cdnBase 只给测试用
	wechat_clawbot: { config: ["apiBase", "cdnBase"], secret: [] },
};

export interface ChannelRow {
	id: string;
	kind: ChannelKind;
	name: string;
	agent_id: string;
	enabled: number;
	config: string;
	secret: string | null;
	bind_code: string | null;
	created_at: number;
}
interface PeerRow {
	channel_id: string;
	peer_id: string;
	display: string | null;
	allowed: number;
	conversation_id: string | null;
	ctx: string | null;
	last_at: number | null;
}

const adapters = new Map<string, ChannelAdapter>();
const statuses = new Map<string, AdapterStatus>();
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

export const getChannel = (id: string) => db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as unknown as ChannelRow | undefined;
export const listChannels = () => db.prepare("SELECT * FROM channels ORDER BY created_at").all() as unknown as ChannelRow[];
const peers = (channelId: string) => db.prepare("SELECT * FROM channel_peers WHERE channel_id = ? ORDER BY last_at DESC").all(channelId) as unknown as PeerRow[];
const peer = (channelId: string, peerId: string) => db.prepare("SELECT * FROM channel_peers WHERE channel_id = ? AND peer_id = ?").get(channelId, peerId) as unknown as PeerRow | undefined;

function changed() {
	bus.emit({ type: "channels.changed" } as never);
}

/** 给 UI 的公开信息（不含密钥） */
export function channelJson(c: ChannelRow) {
	const secretKeys = c.secret ? Object.keys(openJson<Record<string, string>>(c.secret)) : [];
	return {
		id: c.id,
		kind: c.kind,
		name: c.name,
		agentId: c.agent_id,
		enabled: !!c.enabled,
		config: JSON.parse(c.config) as Record<string, string>,
		secretsSet: secretKeys,
		bindCode: c.bind_code,
		status: statuses.get(c.id) ?? { state: c.enabled ? "connecting" : "off", detail: c.enabled ? "启动中" : "已停用" },
		users: peers(c.id)
			.filter((p) => !p.peer_id.startsWith("chat:"))
			.map((p) => ({ id: p.peer_id, display: p.display, allowed: !!p.allowed, lastAt: p.last_at })),
		callbackPath: c.kind === "wecom" ? `/hooks/channels/wecom/${c.id}` : undefined,
		login: c.kind === "wechat_clawbot" ? loginStatus(c.id) : undefined,
		queued: (db.prepare("SELECT COUNT(*) AS n FROM channel_outbox WHERE channel_id = ?").get(c.id) as { n: number }).n,
	};
}

function pick(obj: Record<string, unknown> | undefined, keys: string[]) {
	const out: Record<string, string> = {};
	for (const k of keys) if (typeof obj?.[k] === "string" && (obj[k] as string).trim()) out[k] = (obj[k] as string).trim();
	return out;
}

export function saveChannel(input: { id?: string; kind: ChannelKind; name?: string; agentId: string; enabled?: boolean; config?: Record<string, unknown>; secret?: Record<string, unknown> }) {
	if (!FIELDS[input.kind]) throw new Error("不支持的渠道");
	if (!getAgent(input.agentId)) throw new Error("助理不存在");
	const cur = input.id ? getChannel(input.id) : undefined;
	const f = FIELDS[input.kind];
	const config = { ...(cur ? JSON.parse(cur.config) : {}), ...pick(input.config, f.config) };
	// 密钥：留空 = 不修改
	const secret = { ...(cur?.secret ? openJson<Record<string, string>>(cur.secret) : {}), ...pick(input.secret, f.secret) };
	const required = { feishu: ["appId"], dingtalk: ["clientId"], wecom: ["corpId", "agentId"], wecom_bot: ["botId"], wechat_clawbot: [] as string[] }[input.kind];
	for (const k of required) if (!config[k]) throw new Error(`缺少 ${k}`);
	for (const k of f.secret) if (!secret[k]) throw new Error(`缺少 ${k}`);
	if (input.kind === "wecom" && String(secret.aesKey).length !== 43) throw new Error("EncodingAESKey 应为 43 位");
	const name = (input.name ?? cur?.name ?? KIND_LABEL[input.kind]).slice(0, 40);
	const enabled = input.enabled ?? (cur ? !!cur.enabled : true);
	const id = cur?.id ?? uid("ch");
	if (cur) db.prepare("UPDATE channels SET name = ?, agent_id = ?, enabled = ?, config = ?, secret = ? WHERE id = ?").run(name, input.agentId, enabled ? 1 : 0, JSON.stringify(config), sealJson(secret), id);
	else db.prepare("INSERT INTO channels(id, kind, name, agent_id, enabled, config, secret, bind_code, created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, input.kind, name, input.agentId, enabled ? 1 : 0, JSON.stringify(config), sealJson(secret), newCode(), now());
	void restartChannel(id);
	changed();
	return getChannel(id)!;
}

export async function deleteChannel(id: string) {
	await stopChannel(id);
	db.prepare("DELETE FROM channel_peers WHERE channel_id = ?").run(id);
	db.prepare("DELETE FROM channels WHERE id = ?").run(id);
	statuses.delete(id);
	changed();
}
export function rotateBindCode(id: string) {
	db.prepare("UPDATE channels SET bind_code = ? WHERE id = ?").run(newCode(), id);
	changed();
	return getChannel(id)!.bind_code;
}
export function setPeerAllowed(channelId: string, peerId: string, allowed: boolean) {
	db.prepare("UPDATE channel_peers SET allowed = ? WHERE channel_id = ? AND peer_id = ?").run(allowed ? 1 : 0, channelId, peerId);
	changed();
}

function makeAdapter(c: ChannelRow): ChannelAdapter {
	const deps = {
		config: JSON.parse(c.config),
		secret: c.secret ? openJson(c.secret) : {},
		onMessage: (m: Inbound) => void handleInbound(c.id, m).catch((e) => console.warn(`[channel ${c.kind}] ${e instanceof Error ? e.message : e}`)),
		onAction: (a: CardAction) => handleAction(c.id, a),
		setStatus: (s: AdapterStatus) => {
			statuses.set(c.id, s);
			changed();
		},
	};
	if (c.kind === "feishu") return feishuAdapter(deps as never);
	if (c.kind === "dingtalk") return dingtalkAdapter(deps as never);
	if (c.kind === "wecom_bot") return wecomBotAdapter(deps as never);
	if (c.kind === "wechat_clawbot") return wechatClawbotAdapter(deps as never);
	return wecomAdapter(deps as never);
}

/** 仅测试用：注入模拟适配器 */
export function _setAdapterForTest(id: string, a: ChannelAdapter | null) {
	if (a) adapters.set(id, a);
	else adapters.delete(id);
}

export async function stopChannel(id: string) {
	const a = adapters.get(id);
	adapters.delete(id);
	await a?.stop().catch(() => {});
}
export async function restartChannel(id: string) {
	await stopChannel(id);
	const c = getChannel(id);
	if (!c) return;
	if (!c.enabled) {
		statuses.set(id, { state: "off", detail: "已停用" });
		return changed();
	}
	const a = makeAdapter(c);
	adapters.set(id, a);
	try {
		await a.start();
	} catch (e) {
		statuses.set(id, { state: "error", detail: e instanceof Error ? e.message : String(e) });
		changed();
	}
}
export async function startChannels() {
	for (const c of listChannels()) if (c.enabled) void restartChannel(c.id);
}
export async function stopChannels() {
	await Promise.all([...adapters.keys()].map(stopChannel));
}
export async function testChannel(id: string) {
	const c = getChannel(id);
	if (!c) throw new Error("渠道不存在");
	return (adapters.get(id) ?? makeAdapter(c)).test();
}
// ---------------------------------------------------------------- 微信 ClawBot 扫码连接
export async function clawbotLogin(id: string) {
	const c = getChannel(id);
	if (!c || c.kind !== "wechat_clawbot") throw new Error("不是微信 ClawBot 渠道");
	const cfg = JSON.parse(c.config) as ClawbotConfig;
	const sec = c.secret ? openJson<{ botToken?: string }>(c.secret) : {};
	const st = await startLogin(id, cfg, sec.botToken, (r) => {
		const cur = getChannel(id);
		if (!cur) return;
		const next: ClawbotConfig = { ...JSON.parse(cur.config), accountId: r.accountId, ...(r.baseUrl ? { apiBase: r.baseUrl } : {}), ...(r.userId ? { ownerUserId: r.userId } : {}) };
		db.prepare("UPDATE channels SET config = ?, secret = ?, enabled = 1 WHERE id = ?").run(JSON.stringify(next), sealJson({ botToken: r.botToken }), id);
		// 扫码的人就是主人：直接授权（ClawBot 不能被别人添加）
		if (r.userId) db.prepare("INSERT INTO channel_peers(channel_id, peer_id, display, allowed, last_at) VALUES(?,?,?,1,?) ON CONFLICT(channel_id, peer_id) DO UPDATE SET allowed = 1").run(id, r.userId, "我", now());
		void restartChannel(id);
		notify({ title: "微信 ClawBot 已连接", body: `现在可以在微信里和「${getAgent(cur.agent_id)?.name ?? "助理"}」聊天了`, url: "/?settings=channels" });
		changed();
	});
	// 二维码也推到手机：在手机上打开设置页即可长按识别
	notify({ title: "用微信扫码连接 ClawBot", body: "打开设置 › 渠道，用微信扫码；在手机上可长按二维码识别", url: "/?settings=channels", tag: `clawbot-${id}` });
	changed();
	return st;
}
export { cancelLogin as clawbotCancel, loginStatus as clawbotStatus };
export function clawbotVerify(id: string, code: string) {
	submitVerifyCode(id, code);
	changed();
}

/** 企业微信回调入口 */
export function wecomCallback(id: string, method: string, q: Record<string, string>, body: string) {
	const a = adapters.get(id) as WecomAdapter | undefined;
	if (!a || getChannel(id)?.kind !== "wecom") return { status: 404, body: "not found" };
	try {
		return a.callback(method, q, body);
	} catch (e) {
		return { status: 400, body: e instanceof Error ? e.message : "error" };
	}
}

// ---------------------------------------------------------------- 入站
const nagged = new Map<string, number>();
export interface OutFile {
	/** 消息 meta.attachments 里是 fileId；旧的待发队列里是 id */
	fileId?: string;
	id?: string;
	name: string;
}
/** 图片说明文字不超过这个长度时，和图片合成一条发（微信 ClawBot 省额度） */
const CAPTION_MAX = 300;
/** 下载链接（只用固定地址：临时地址会变，链接过后就失效） */
function downloadLink(fileId: string): string | null {
	const t = tunnelStatus();
	if (t.state !== "online" || !t.url || t.mode !== "named") return null;
	return `${t.url.replace(/\/$/, "")}${signedPath(fileId)}`;
}
/** 渠道里发出去的文字：去掉思考内容，按渠道转格式 */
export function channelText(kind: ChannelKind, text: string): string {
	const clean = stripThinking(text);
	return CAPS[kind]?.format === "plain" ? markdownToPlain(clean) : clean.trim();
}
/** 发回渠道。平台暂时不让发（DeferredSend）→ 没发出去的部分进待发队列，用户下次发消息时补发，同时用 App 推送提醒 */
async function reply(channelId: string, ctx: Record<string, unknown>, rawText: string, card?: OutCard, files: OutFile[] = [], peerId?: string) {
	const a = adapters.get(channelId);
	const c = getChannel(channelId);
	if (!a || !c) return;
	const caps = CAPS[c.kind];
	let text = channelText(c.kind, rawText);
	let left = [...files];
	const notes: string[] = [];
	try {
		const captionMode = !card && left.length === 1 && !!a.sendFile && text.length > 0 && text.length <= CAPTION_MAX;
		if (text && !captionMode) {
			await (card && a.sendCard ? a.sendCard(ctx, card) : a.send(ctx, text));
			text = "";
		}
		while (left.length) {
			const f = left[0];
			const row = getFile(f.fileId ?? f.id ?? "");
			const caption = captionMode && text ? text : undefined;
			const fallback = (why: string) => {
				const link = row && downloadLink(row.id);
				notes.push(link ? `📎 ${f.name}：${link}（7 天内有效）` : `📎 ${f.name}（${why}，请在 App 里查看）`);
			};
			if (!row || !existsSync(row.stored_path)) fallback("文件已不存在");
			else if (!a.sendFile) fallback(`${caps.label}暂不支持发文件`);
			else {
				const prep = await prepareMedia(row.stored_path, f.name, caps);
				try {
					if (prep.as === "none") fallback(`${caps.label}不支持这类文件或文件太大`);
					else {
						await a.sendFile(ctx, prep.path, prep.name, { kind: prep.as, caption: [caption, prep.note].filter(Boolean).join(" ") || undefined });
						if (caption) text = "";
					}
				} catch (e) {
					if (e instanceof DeferredSend) throw e;
					console.warn(`[channels] 发送文件失败：${e instanceof Error ? e.message : e}`);
					if (caption) await a.send(ctx, caption).then(() => (text = ""));
					fallback("发送失败");
				} finally {
					prep.cleanup();
				}
			}
			left = left.slice(1);
		}
		if (text) await a.send(ctx, text), (text = "");
		if (notes.length) await a.send(ctx, notes.join("\n"));
	} catch (e) {
		const rest = [text, ...notes].filter(Boolean).join("\n\n");
		if (e instanceof DeferredSend && peerId) return defer(channelId, peerId, rest, left, e.message);
		statuses.set(channelId, { state: "error", detail: e instanceof Error ? e.message : String(e) });
		changed();
	}
}
function defer(channelId: string, peerId: string, text: string, files: OutFile[], reason: string) {
	db.prepare("INSERT INTO channel_outbox(id, channel_id, peer_id, text, files, reason, created_at) VALUES(?,?,?,?,?,?,?)").run(uid("ob"), channelId, peerId, text, JSON.stringify(files), reason, now());
	const c = getChannel(channelId);
	notify({ title: `${getAgent(c?.agent_id ?? "")?.name ?? "助理"}（${KIND_LABEL[c?.kind ?? "wechat_clawbot"]}暂时发不出去）`, body: `${text.slice(0, 120)}\n\n${reason}；你下次在${KIND_LABEL[c?.kind ?? "wechat_clawbot"]}里发消息时会补发。`, url: "/", tag: `outbox-${channelId}` });
	changed();
}
/** 用户发来消息（窗口重新打开）→ 先补发排队的消息 */
async function flushOutbox(channelId: string, peerId: string, ctx: Record<string, unknown>) {
	const rows = db.prepare("SELECT * FROM channel_outbox WHERE channel_id = ? AND peer_id = ? ORDER BY created_at").all(channelId, peerId) as { id: string; text: string; files: string | null }[];
	if (!rows.length) return;
	db.prepare("DELETE FROM channel_outbox WHERE channel_id = ? AND peer_id = ?").run(channelId, peerId);
	const head = `（你不在时有 ${rows.length} 条消息）`;
	for (const [i, r] of rows.entries()) await reply(channelId, ctx, i === 0 ? `${head}\n\n${r.text}` : r.text, undefined, r.files ? JSON.parse(r.files) : [], peerId);
	changed();
}
/** 能不能现在主动发到这个渠道会话（主动提醒选渠道用） */
export function channelCanPush(channelId: string, peerId: string) {
	const a = adapters.get(channelId);
	const p = peer(channelId, peerId);
	if (!a || !p?.ctx) return { ok: false, reason: "渠道未连接" };
	return a.canPush?.(JSON.parse(p.ctx)) ?? { ok: true };
}
/** 主动发到渠道（不能发就排队）；返回是否已立刻发出 */
export async function channelPush(channelId: string, peerId: string, text: string): Promise<boolean> {
	const p = peer(channelId, peerId);
	if (!p?.ctx) return false;
	const ok = channelCanPush(channelId, peerId).ok;
	if (!ok) return (defer(channelId, peerId, text, [], channelCanPush(channelId, peerId).reason ?? "暂时发不出去"), false);
	await reply(channelId, JSON.parse(p.ctx), text, undefined, [], peerId);
	return true;
}

const APPROVE = /^(批准|同意|允许|好|好的|可以|是|确认|ok|yes|y|1)$/i;
const APPROVE_TASK = /^(都允许|全部允许|本任务内都允许|总是允许)$/;
const REJECT = /^(拒绝|不|不要|不行|否|取消|no|n|2)$/i;

export async function handleInbound(channelId: string, m: Inbound) {
	const c = getChannel(channelId);
	if (!c || !c.enabled) return;
	const t = now();
	// 授权：按发消息的人
	db.prepare("INSERT INTO channel_peers(channel_id, peer_id, display, allowed, ctx, last_at) VALUES(?,?,?,0,?,?) ON CONFLICT(channel_id, peer_id) DO UPDATE SET display = COALESCE(excluded.display, display), last_at = excluded.last_at").run(channelId, m.userId, m.display ?? null, JSON.stringify(m.ctx), t);
	const user = peer(channelId, m.userId)!;
	if (!user.allowed) {
		const code = /^(?:绑定|bind)\s*(\d{6})$/i.exec(m.text)?.[1];
		if (code && code === c.bind_code) {
			setPeerAllowed(channelId, m.userId, true);
			rotateBindCode(channelId);
			const agent = getAgent(c.agent_id);
			// 先写进 Pi Assistant（单聊绑定后就有对话），再由出站镜像发回渠道
			if (m.peerId === m.userId) {
				db.prepare("INSERT INTO channel_peers(channel_id, peer_id, display, allowed, ctx, last_at, is_group) VALUES(?,?,?,1,?,?,0) ON CONFLICT(channel_id, peer_id) DO UPDATE SET ctx = excluded.ctx").run(channelId, m.peerId, m.display ?? null, JSON.stringify(m.ctx), t);
				const conv = createConversation(c.agent_id, `${KIND_LABEL[c.kind]} · ${m.display ?? "单聊"}`, { makeCurrent: false });
				db.prepare("UPDATE channel_peers SET conversation_id = ? WHERE channel_id = ? AND peer_id = ?").run(conv.id, channelId, m.peerId);
				insertMessage({ agentId: c.agent_id, conversationId: conv.id, role: "user", content: m.text.trim(), meta: { from: `${c.kind}:${m.display ?? m.userId}`, channel: { id: channelId, kind: c.kind }, command: true } });
				insertMessage({ agentId: c.agent_id, conversationId: conv.id, role: "assistant", content: `✅ 绑定成功。现在可以直接和「${agent?.name ?? "助理"}」聊天了。\n\n发送「新对话」开始新话题，「停止」中断当前任务。`, status: "done", meta: { system: "channel" } });
				return;
			}
			return reply(channelId, m.ctx, `✅ 绑定成功。现在可以直接和「${agent?.name ?? "助理"}」聊天了。\n\n发送「新对话」开始新话题，「停止」中断当前任务。`);
		}
		// 未绑定的人：每 10 分钟最多提示一次，不暴露任何内容
		if (Date.now() - (nagged.get(`${channelId}:${m.userId}`) ?? 0) > 600_000) {
			nagged.set(`${channelId}:${m.userId}`, Date.now());
			await reply(channelId, m.ctx, "你好！使用前需要先绑定：请在电脑上打开 Pi Assistant › 设置 › 渠道，找到 6 位绑定码，然后在这里发送「绑定 123456」。");
		}
		changed();
		return;
	}
	// 会话（群聊按群）
	db.prepare("INSERT INTO channel_peers(channel_id, peer_id, display, allowed, ctx, last_at, is_group) VALUES(?,?,?,1,?,?,?) ON CONFLICT(channel_id, peer_id) DO UPDATE SET ctx = excluded.ctx, last_at = excluded.last_at, is_group = excluded.is_group").run(channelId, m.peerId, m.display ?? null, JSON.stringify(m.ctx), t, m.group ? 1 : 0);
	let p = peer(channelId, m.peerId)!;
	await flushOutbox(channelId, m.peerId, m.ctx);
	const label = `${KIND_LABEL[c.kind]} · ${m.group ? "群聊" : (m.display ?? user.display ?? "单聊")}`;
	const newConv = () => {
		const conv = createConversation(c.agent_id, label, { makeCurrent: false });
		db.prepare("UPDATE channel_peers SET conversation_id = ? WHERE channel_id = ? AND peer_id = ?").run(conv.id, channelId, m.peerId);
		return conv.id;
	};
	let conv = p.conversation_id && getConversation(p.conversation_id)?.agent_id === c.agent_id ? p.conversation_id : newConv();
	const text = m.text.trim();
	const fromMeta = { from: `${c.kind}:${m.display ?? m.userId}`, channel: { id: channelId, kind: c.kind } };
	// 指令也先记进 Pi Assistant 对话，回复由出站镜像发回渠道（Pi Assistant 是唯一事实来源）
	const sys = (cv: string, content: string) => insertMessage({ agentId: c.agent_id, conversationId: cv, role: "assistant", content, status: "done", meta: { system: "channel" } });
	if (/^(新对话|\/new)$/i.test(text)) {
		insertMessage({ agentId: c.agent_id, conversationId: conv, role: "user", content: text, meta: { ...fromMeta, command: true } });
		conv = newConv();
		sys(conv, "好的，开始新的对话。");
		return;
	}
	if (/^(停止|\/stop)$/i.test(text)) {
		insertMessage({ agentId: c.agent_id, conversationId: conv, role: "user", content: text, meta: { ...fromMeta, command: true } });
		await runtime(c.agent_id, conv).abort();
		sys(conv, "已停止当前任务。");
		return;
	}
	// 有待处理的审批 / 提问 → 这条回复就是答案
	const card = db.prepare("SELECT meta FROM messages WHERE conversation_id = ? AND role = 'card' AND json_extract(meta, '$.status') = 'pending' ORDER BY created_at DESC LIMIT 1").get(conv) as { meta: string } | undefined;
	if (card) {
		const meta = JSON.parse(card.meta) as { kind: string; requestId: string; options?: string[]; allowFreeText?: boolean; allowTask?: boolean };
		const by = `${c.kind}:${m.userId}`;
		// 渠道里的回答也先记进 Pi Assistant 对话
		const rec = () => insertMessage({ agentId: c.agent_id, conversationId: conv, role: "user", content: text, meta: { ...fromMeta, answer: meta.requestId } });
		if (meta.kind === "approval") {
			if (APPROVE_TASK.test(text) && meta.allowTask) return void (rec(), requests.resolve(meta.requestId, { approved: true, scope: "task" }, by));
			if (APPROVE.test(text)) return void (rec(), requests.resolve(meta.requestId, { approved: true }, by));
			if (REJECT.test(text)) return void (rec(), requests.resolve(meta.requestId, { approved: false }, by));
		} else {
			const opts = meta.options ?? [];
			const n = Number(text);
			const ans = Number.isInteger(n) && n >= 1 && n <= opts.length ? opts[n - 1] : opts.find((o) => o === text) ?? (meta.allowFreeText !== false ? text : undefined);
			if (ans !== undefined) return void (rec(), requests.resolve(meta.requestId, { answer: ans }, by));
		}
	}
	p = peer(channelId, m.peerId)!;
	// 发来的图片 / 文件存进助理工作区 uploads/，告诉助理路径
	const saved = (m.files ?? []).map((f) => saveUpload(c.agent_id, f.name, f.data));
	const note = saved.length ? `\n\n（附件已保存到工作区：${saved.map((f) => f.workspace_path).join("、")}）` : "";
	insertMessage({ agentId: c.agent_id, conversationId: conv, role: "user", content: text, meta: { from: `${c.kind}:${m.display ?? m.userId}`, channel: { id: channelId, kind: c.kind }, ...(saved.length ? { attachments: saved.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size })) } : {}) } });
	await runtime(c.agent_id, conv).send(`${channelContext(c.kind, { group: m.group })}\n${m.group && m.display ? `（${m.display} 在${KIND_LABEL[c.kind]}群里说）${text}` : text}${note}`);
}

/**
 * 卡片按钮回调。校验：点按的人已绑定；卡片所在对话确实属于这个渠道；卡片还没处理。返回结果文字（用于更新卡片 / toast）。
 */
export async function handleAction(channelId: string, a: CardAction): Promise<string> {
	const c = getChannel(channelId);
	const act = decodeAction(a.action);
	if (!c || !c.enabled || !act) return "这个按钮已失效";
	if (!peer(channelId, a.userId)?.allowed) return "无权操作：请先绑定";
	const row = db.prepare("SELECT conversation_id, meta FROM messages WHERE role = 'card' AND json_extract(meta, '$.requestId') = ? LIMIT 1").get(act.requestId) as { conversation_id: string; meta: string } | undefined;
	if (!row) return "这个请求已失效";
	const bound = db.prepare("SELECT 1 FROM channel_peers WHERE channel_id = ? AND conversation_id = ? LIMIT 1").get(channelId, row.conversation_id);
	if (!bound) return "无权操作这个请求";
	const meta = JSON.parse(row.meta) as { kind: string; status?: string; options?: string[]; allowTask?: boolean };
	if (meta.status !== "pending") return "已经处理过了";
	const by = `${c.kind}:${a.display ?? a.userId}`;
	if (meta.kind === "approval") {
		if (act.kind === "approve") return (requests.resolve(act.requestId, { approved: true }, by), "已批准 ✅");
		if (act.kind === "task" && meta.allowTask) return (requests.resolve(act.requestId, { approved: true, scope: "task" }, by), "本任务内都允许 ✅");
		if (act.kind === "reject") return (requests.resolve(act.requestId, { approved: false }, by), "已拒绝");
		return "这个按钮已失效";
	}
	const opt = act.kind === "opt" && act.i !== undefined ? meta.options?.[act.i] : undefined;
	if (opt === undefined) return "这个按钮已失效";
	requests.resolve(act.requestId, { answer: opt }, by);
	return `已选择：${opt}`.slice(0, 40);
}

/** 待处理的审批 / 提问 → 卡片（按钮 + 文字回复的后备说明） */
export function cardFor(meta: Record<string, unknown>): OutCard | null {
	const rid = String(meta.requestId ?? "");
	if (!rid) return null;
	if (meta.kind === "approval") {
		const buttons: OutCard["buttons"] = [
			{ label: "批准", text: "批准", action: encodeAction(rid, "approve"), style: "primary" },
			...(meta.allowTask ? [{ label: "本任务内都允许", text: "都允许", action: encodeAction(rid, "task") }] : []),
			{ label: "拒绝", text: "拒绝", action: encodeAction(rid, "reject"), style: "danger" as const },
		];
		return { title: String(meta.risk) === "high" ? "⚠️ 需要你批准" : "需要你批准", body: String(meta.summary ?? meta.toolName ?? ""), buttons, fallback: `也可以直接回复「批准」或「拒绝」${meta.allowTask ? "，或「都允许」" : ""}` };
	}
	const opts = (meta.options as string[] | undefined) ?? [];
	if (!opts.length) return null;
	return {
		title: "请选择",
		body: String(meta.question ?? ""),
		buttons: opts.slice(0, 6).map((o, i) => ({ label: o.slice(0, 20), text: String(i + 1), action: encodeAction(rid, "opt", i) })),
		fallback: `也可以回复序号${meta.allowFreeText !== false ? "或直接回答" : ""}`,
	};
}

// ---------------------------------------------------------------- 出站：把这个对话里助理的回复发回渠道
const forwarded = new Set<string>();
function format(msg: MessageRow): string | null {
	const meta = (typeof msg.meta === "string" ? JSON.parse(msg.meta || "{}") : (msg.meta ?? {})) as Record<string, unknown>;
	if (msg.role === "card") {
		if (meta.status !== "pending") return null;
		if (meta.kind === "approval") return `**需要你批准**\n${String(meta.summary ?? meta.toolName ?? "")}\n\n回复「批准」或「拒绝」${meta.allowTask ? "，或「都允许」（本任务内同类操作不再询问）" : ""}`;
		const opts = (meta.options as string[] | undefined) ?? [];
		return `**${String(meta.question ?? "")}**\n${opts.map((o, i) => `${i + 1}. ${o}`).join("\n")}\n\n${opts.length ? "回复序号" : "直接回复"}${opts.length && meta.allowFreeText !== false ? "或直接回答" : ""}`;
	}
	if (msg.role === "assistant" && msg.status === "done") {
		// 附件由 reply() 按渠道能力发送（原生图片 / 文件 / 下载链接 / 提示），这里只给正文；思考内容不外发
		const files = (meta.attachments as unknown[] | undefined) ?? [];
		const body = stripThinking(msg.content ?? "").trim();
		return body || (files.length ? "" : null);
	}
	if (msg.role === "system" && msg.status === "error") return `⚠️ ${msg.content}`;
	return null;
}
bus.on((e) => {
	const ev = e as unknown as { type: string; message?: MessageRow };
	if ((ev.type !== "message.created" && ev.type !== "message.updated") || !ev.message?.conversation_id || ev.message.task_id) return;
	const msg = ev.message;
	if (forwarded.has(msg.id)) return;
	if (/"noMirror":true/.test(typeof msg.meta === "string" ? msg.meta : JSON.stringify(msg.meta ?? {}))) return; // 用户选了“只在 App”
	// 消息已经写进 Pi Assistant（message.created 在写库之后才发出）→ 把副本镜像到绑定了这个对话的每个渠道会话
	const peers = db.prepare("SELECT * FROM channel_peers WHERE conversation_id = ?").all(msg.conversation_id) as unknown as PeerRow[];
	if (!peers.length) return;
	let sent = false;
	for (const p of peers) {
		const text = format(msg);
		if (text === null) continue;
		sent = true;
		const meta = msg.role === "card" ? ((typeof msg.meta === "string" ? JSON.parse(msg.meta || "{}") : (msg.meta ?? {})) as Record<string, unknown>) : null;
		const mm = (typeof msg.meta === "string" ? JSON.parse(msg.meta || "{}") : (msg.meta ?? {})) as { attachments?: OutFile[] };
		const files = msg.role === "assistant" ? (mm.attachments ?? []) : [];
		void reply(p.channel_id, p.ctx ? JSON.parse(p.ctx) : {}, text, (meta && cardFor(meta)) || undefined, files, p.peer_id);
	}
	if (!sent) return;
	forwarded.add(msg.id);
	if (forwarded.size > 5000) forwarded.clear();
});

