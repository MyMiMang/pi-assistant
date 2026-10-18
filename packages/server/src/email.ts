/**
 * 邮箱连接器：IMAP 收信 / SMTP 发信（QQ、163、126、Gmail、腾讯企业邮、Outlook 或自定义），用授权码 / 应用专用密码登录。
 * 先写草稿、批准后才发送（DESIGN §5.7）：助理只能 email_draft 生成草稿，email_send 只接受草稿 ID，并且每次都要用户批准。
 * 凭据加密保存在本机，只发给对应的邮件服务器。只用公开协议与开源库（imapflow / nodemailer / mailparser，MIT）。
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { simpleParser } from "mailparser";
import { freshAccessToken, type OAuthSecret } from "./email-oauth.ts";
import nodemailer, { type Transporter } from "nodemailer";
import { bus } from "./bus.ts";
import { db, now, uid } from "./db.ts";
import { openJson, sealJson } from "./secrets.ts";

export interface MailServer {
	host: string;
	port: number;
	secure: boolean;
}
export interface EmailPreset {
	label: string;
	imap: MailServer;
	smtp: MailServer;
	help: string;
	/** 服务器会自动把发出的邮件存到“已发送” */
	autoSent?: boolean;
}
export const PRESETS: Record<string, EmailPreset> = {
	qq: { label: "QQ 邮箱", imap: { host: "imap.qq.com", port: 993, secure: true }, smtp: { host: "smtp.qq.com", port: 465, secure: true }, help: "QQ 邮箱网页版 › 设置 › 账号 › POP3/IMAP/SMTP 服务 › 开启 IMAP/SMTP，按提示发短信后得到 16 位「授权码」，填在密码处（不是 QQ 密码）。" },
	"163": { label: "网易 163 邮箱", imap: { host: "imap.163.com", port: 993, secure: true }, smtp: { host: "smtp.163.com", port: 465, secure: true }, help: "163 邮箱网页版 › 设置 › POP3/SMTP/IMAP › 开启 IMAP/SMTP 服务，得到「授权码」，填在密码处。" },
	"126": { label: "网易 126 邮箱", imap: { host: "imap.126.com", port: 993, secure: true }, smtp: { host: "smtp.126.com", port: 465, secure: true }, help: "126 邮箱网页版 › 设置 › POP3/SMTP/IMAP › 开启 IMAP/SMTP 服务，得到「授权码」。" },
	gmail: { label: "Gmail", imap: { host: "imap.gmail.com", port: 993, secure: true }, smtp: { host: "smtp.gmail.com", port: 465, secure: true }, autoSent: true, help: "Google 账号开启两步验证后，在 myaccount.google.com/apppasswords 生成「应用专用密码」，填在密码处。" },
	exmail: { label: "腾讯企业邮", imap: { host: "imap.exmail.qq.com", port: 993, secure: true }, smtp: { host: "smtp.exmail.qq.com", port: 465, secure: true }, help: "企业邮箱 › 设置 › 客户端设置 › 开启 IMAP/SMTP；开启了安全登录的需要生成「客户端专用密码」。" },
	outlook: { label: "Outlook / Hotmail", imap: { host: "outlook.office365.com", port: 993, secure: true }, smtp: { host: "smtp-mail.outlook.com", port: 587, secure: false }, autoSent: true, help: "微软账号需开启两步验证并生成「应用密码」。注意：微软正逐步关闭基本认证，部分账号可能无法用密码登录。" },
	custom: { label: "其他（自定义服务器）", imap: { host: "", port: 993, secure: true }, smtp: { host: "", port: 465, secure: true }, help: "填写邮件服务商提供的 IMAP / SMTP 服务器地址与端口。" },
};

export interface AccountRow {
	id: string;
	agent_id: string | null;
	name: string;
	address: string;
	preset: string;
	config: string;
	secret: string;
	created_at: number;
}
interface AccountConfig {
	imap: MailServer;
	smtp: MailServer;
	user: string;
	/** 测试用：跳过证书校验 */
	insecure?: boolean;
}
export interface DraftPayload {
	to: string[];
	cc?: string[];
	subject: string;
	body: string;
	attachments?: string[];
	inReplyTo?: string;
	references?: string;
}

const changed = () => bus.emit({ type: "email.changed" });
export const listAccounts = () => db.prepare("SELECT * FROM email_accounts ORDER BY created_at").all() as unknown as AccountRow[];
export const getAccount = (id: string) => db.prepare("SELECT * FROM email_accounts WHERE id = ?").get(id) as unknown as AccountRow | undefined;
export const accountsFor = (agentId: string) => listAccounts().filter((a) => !a.agent_id || a.agent_id === agentId);
export const accountJson = (a: AccountRow) => {
	const c = JSON.parse(a.config) as AccountConfig;
	return { id: a.id, agentId: a.agent_id, name: a.name, address: a.address, preset: a.preset, imap: c.imap, smtp: c.smtp, user: c.user, oauth: !!openJson<{ oauth?: unknown }>(a.secret).oauth };
};

export function saveAccount(input: { id?: string; agentId?: string | null; name?: string; address: string; preset: string; password?: string; user?: string; imap?: Partial<MailServer>; smtp?: Partial<MailServer>; insecure?: boolean }) {
	const p = PRESETS[input.preset];
	if (!p) throw new Error("不支持的邮箱类型");
	const address = input.address.trim();
	if (!/^[^@\s]+@[^@\s]+$/.test(address)) throw new Error("邮箱地址不对");
	const cur = input.id ? getAccount(input.id) : undefined;
	const curCfg = cur ? (JSON.parse(cur.config) as AccountConfig) : null;
	const cfg: AccountConfig = {
		imap: { ...p.imap, ...curCfg?.imap, ...input.imap } as MailServer,
		smtp: { ...p.smtp, ...curCfg?.smtp, ...input.smtp } as MailServer,
		user: input.user?.trim() || curCfg?.user || address,
		...(input.insecure ? { insecure: true } : {}),
	};
	if (!cfg.imap.host || !cfg.smtp.host) throw new Error("请填写 IMAP / SMTP 服务器");
	const curSec = cur ? openJson<{ password?: string; oauth?: OAuthSecret }>(cur.secret) : null;
	if (curSec?.oauth && !input.password) {
		// OAuth 账号：只改名字 / 归属助理
		db.prepare("UPDATE email_accounts SET agent_id = ?, name = ? WHERE id = ?").run(input.agentId ?? null, (input.name || cur!.name).slice(0, 60), cur!.id);
		changed();
		return getAccount(cur!.id)!;
	}
	const password = input.password || curSec?.password || "";
	if (!password) throw new Error("请填写授权码 / 应用专用密码");
	const id = cur?.id ?? uid("mail");
	const name = (input.name || cur?.name || address).slice(0, 60);
	if (cur) db.prepare("UPDATE email_accounts SET agent_id = ?, name = ?, address = ?, preset = ?, config = ?, secret = ? WHERE id = ?").run(input.agentId ?? null, name, address, input.preset, JSON.stringify(cfg), sealJson({ password }), id);
	else db.prepare("INSERT INTO email_accounts(id, agent_id, name, address, preset, config, secret, created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, input.agentId ?? null, name, address, input.preset, JSON.stringify(cfg), sealJson({ password }), now());
	changed();
	return getAccount(id)!;
}
export function deleteAccount(id: string) {
	db.prepare("DELETE FROM email_drafts WHERE account_id = ?").run(id);
	db.prepare("DELETE FROM email_accounts WHERE id = ?").run(id);
	changed();
}

const refreshing = new Map<string, ReturnType<typeof freshAccessToken>>();
/** 凭据：授权码 / 应用专用密码，或 OAuth（Gmail XOAUTH2，按需刷新 access token 并写回） */
async function auth(a: AccountRow): Promise<{ cfg: AccountConfig; imap: { user: string; pass?: string; accessToken?: string }; smtp: Record<string, string> }> {
	const cfg = JSON.parse(a.config) as AccountConfig;
	// 读最新的凭据（刷新过的 token 写回了库，调用方手里的行可能是旧的）
	const sec = openJson<{ password?: string; oauth?: OAuthSecret }>((getAccount(a.id) ?? a).secret);
	if (sec.oauth) {
		// 同一账号并发刷新只刷一次
		let p = refreshing.get(a.id);
		if (!p) {
			p = freshAccessToken(sec.oauth).finally(() => refreshing.delete(a.id));
			refreshing.set(a.id, p);
		}
		const { token, secret, refreshed } = await p;
		if (refreshed) db.prepare("UPDATE email_accounts SET secret = ? WHERE id = ?").run(sealJson({ oauth: secret }), a.id);
		return { cfg, imap: { user: cfg.user, accessToken: token }, smtp: { type: "OAuth2", user: cfg.user, accessToken: token } };
	}
	return { cfg, imap: { user: cfg.user, pass: sec.password ?? "" }, smtp: { user: cfg.user, pass: sec.password ?? "" } };
}

/** OAuth 登录完成后创建 / 更新 Gmail 账号 */
export function saveOAuthAccount(input: { address: string; secret: OAuthSecret; agentId?: string | null; name?: string }) {
	const p = PRESETS.gmail;
	const cur = listAccounts().find((x) => x.address.toLowerCase() === input.address.toLowerCase());
	const cfg: AccountConfig = { imap: p.imap as MailServer, smtp: p.smtp as MailServer, user: input.address };
	const id = cur?.id ?? uid("mail");
	const name = (input.name || cur?.name || input.address).slice(0, 60);
	if (cur) db.prepare("UPDATE email_accounts SET name = ?, preset = 'gmail', config = ?, secret = ? WHERE id = ?").run(name, JSON.stringify(cfg), sealJson({ oauth: input.secret }), id);
	else db.prepare("INSERT INTO email_accounts(id, agent_id, name, address, preset, config, secret, created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, input.agentId ?? null, name, input.address, "gmail", JSON.stringify(cfg), sealJson({ oauth: input.secret }), now());
	changed();
	return getAccount(id)!;
}
async function withImap<T>(a: AccountRow, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
	const { cfg, imap } = await auth(a);
	const opts: ImapFlowOptions = {
		host: cfg.imap.host,
		port: cfg.imap.port,
		secure: cfg.imap.secure,
		auth: imap,
		logger: false,
		// 163/126 要求客户端先发 IMAP ID，否则报 “Unsafe Login”
		clientInfo: { name: "Pi Assistant", version: "1.0", vendor: "pi-assistant" },
		...(cfg.insecure ? { tls: { rejectUnauthorized: false }, doSTARTTLS: false } : {}),
	} as ImapFlowOptions;
	const c = new ImapFlow(opts);
	c.on("error", () => {});
	await c.connect();
	try {
		return await fn(c);
	} finally {
		await c.logout().catch(() => c.close());
	}
}
/** 测试用：替换 SMTP 发送器 */
let transportOverride: ((a: AccountRow) => Transporter) | null = null;
export const setTransportOverride = (f: typeof transportOverride) => (transportOverride = f);
async function transport(a: AccountRow): Promise<Transporter> {
	if (transportOverride) return transportOverride(a);
	const { cfg, smtp } = await auth(a);
	return nodemailer.createTransport({ host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.secure, auth: smtp as never, ...(cfg.insecure ? { tls: { rejectUnauthorized: false } } : {}) });
}

/** 找特殊文件夹（已发送 / 草稿），各家名字不同 */
async function specialFolder(c: ImapFlow, use: "\\Sent" | "\\Drafts"): Promise<string | null> {
	const list = await c.list();
	const hit = list.find((f) => f.specialUse === use) ?? list.find((f) => (use === "\\Sent" ? /^(sent|sent messages|sent items|已发送)/i : /^(drafts?|草稿)/i).test(f.name));
	return hit?.path ?? null;
}

export async function testAccount(id: string) {
	const a = getAccount(id);
	if (!a) throw new Error("邮箱不存在");
	const n = await withImap(a, async (c) => (await c.status("INBOX", { messages: true, unseen: true })) as { messages?: number; unseen?: number });
	await (await transport(a)).verify();
	return `收信、发信都正常：收件箱 ${n.messages ?? 0} 封（未读 ${n.unseen ?? 0}）`;
}

export interface MailSummary {
	uid: number;
	from: string;
	subject: string;
	date: string;
	seen: boolean;
}
export async function listMail(a: AccountRow, opts: { folder?: string; unreadOnly?: boolean; limit?: number; query?: string }): Promise<MailSummary[]> {
	return withImap(a, async (c) => {
		const lock = await c.getMailboxLock(opts.folder || "INBOX");
		try {
			const crit: Record<string, unknown> = {};
			if (opts.unreadOnly) crit.seen = false;
			if (opts.query) crit.or = [{ subject: opts.query }, { from: opts.query }, { body: opts.query }];
			const uids = ((await c.search(Object.keys(crit).length ? crit : { all: true }, { uid: true })) || []) as number[];
			const pick = uids.slice(-Math.min(opts.limit ?? 20, 50));
			if (!pick.length) return [];
			const out: MailSummary[] = [];
			for await (const m of c.fetch(pick, { uid: true, envelope: true, flags: true }, { uid: true })) {
				const f = m.envelope?.from?.[0];
				out.push({ uid: m.uid, from: f ? `${f.name ? `${f.name} ` : ""}<${f.address}>` : "", subject: m.envelope?.subject ?? "（无主题）", date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : "", seen: !!m.flags?.has("\\Seen") });
			}
			return out.reverse();
		} finally {
			lock.release();
		}
	});
}
export async function readMail(a: AccountRow, uidN: number, folder = "INBOX") {
	return withImap(a, async (c) => {
		const lock = await c.getMailboxLock(folder);
		try {
			const m = await c.fetchOne(String(uidN), { source: true }, { uid: true });
			if (!m || !m.source) throw new Error(`找不到这封邮件（uid ${uidN}）`);
			const p = await simpleParser(m.source);
			const text = (p.text || (typeof p.html === "string" ? p.html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ") : "") || "").replace(/\n{3,}/g, "\n\n").trim();
			return {
				messageId: p.messageId,
				references: Array.isArray(p.references) ? p.references.join(" ") : p.references,
				from: p.from?.text ?? "",
				to: Array.isArray(p.to) ? p.to.map((x) => x.text).join(", ") : (p.to?.text ?? ""),
				subject: p.subject ?? "",
				date: p.date?.toISOString() ?? "",
				text: text.slice(0, 20_000),
				attachments: p.attachments.map((x) => ({ filename: x.filename ?? "attachment", size: x.size, content: x.content })),
			};
		} finally {
			lock.release();
		}
	});
}

// ---------------------------------------------------------------- 草稿 → 批准 → 发送
export function saveDraft(accountId: string, agentId: string, d: DraftPayload, draftId?: string) {
	if (!d.to.length) throw new Error("没有收件人");
	for (const x of [...d.to, ...(d.cc ?? [])]) if (!/^[^@\s<>]+@[^@\s<>]+$/.test(x.replace(/^.*<|>$/g, ""))) throw new Error(`邮箱地址不对：${x}`);
	if (draftId) {
		const cur = db.prepare("SELECT * FROM email_drafts WHERE id = ? AND agent_id = ?").get(draftId, agentId) as { status: string } | undefined;
		if (!cur) throw new Error("草稿不存在");
		if (cur.status === "sent") throw new Error("这封草稿已经发出去了");
		db.prepare("UPDATE email_drafts SET payload = ?, account_id = ?, status = 'draft' WHERE id = ?").run(JSON.stringify(d), accountId, draftId);
		return draftId;
	}
	const id = uid("draft");
	db.prepare("INSERT INTO email_drafts(id, account_id, agent_id, payload, status, created_at) VALUES(?,?,?,?,?,?)").run(id, accountId, agentId, JSON.stringify(d), "draft", now());
	return id;
}
export function getDraft(id: string, agentId: string) {
	const r = db.prepare("SELECT * FROM email_drafts WHERE id = ? AND agent_id = ?").get(id, agentId) as { id: string; account_id: string; payload: string; status: string } | undefined;
	return r ? { ...r, payload: JSON.parse(r.payload) as DraftPayload } : null;
}
/** 尽量把草稿也放到邮箱的“草稿箱”，用户在手机邮件 App 里也能看到 */
export async function appendDraftToMailbox(a: AccountRow, raw: Buffer) {
	await withImap(a, async (c) => {
		const f = await specialFolder(c, "\\Drafts");
		if (f) await c.append(f, raw, ["\\Draft"]);
	}).catch(() => {});
}
export async function buildRaw(a: AccountRow, d: DraftPayload, readFile: (p: string) => { name: string; data: Buffer }) {
	const mail = new (await import("nodemailer/lib/mail-composer/index.js")).default({
		from: { name: a.name === a.address ? "" : a.name, address: a.address },
		to: d.to,
		cc: d.cc,
		subject: d.subject,
		text: d.body,
		inReplyTo: d.inReplyTo,
		references: d.references,
		attachments: (d.attachments ?? []).map((p) => {
			const f = readFile(p);
			return { filename: f.name, content: f.data };
		}),
	});
	return new Promise<Buffer>((res, rej) => mail.compile().build((e: Error | null, b: Buffer) => (e ? rej(e) : res(b))));
}
export async function sendDraft(id: string, agentId: string, readFile: (p: string) => { name: string; data: Buffer }) {
	const dr = getDraft(id, agentId);
	if (!dr) throw new Error("草稿不存在");
	if (dr.status === "sent") throw new Error("这封草稿已经发出去了");
	const a = getAccount(dr.account_id);
	if (!a) throw new Error("邮箱账号已删除");
	const raw = await buildRaw(a, dr.payload, readFile);
	try {
		await (await transport(a)).sendMail({ envelope: { from: a.address, to: [...dr.payload.to, ...(dr.payload.cc ?? [])] }, raw });
	} catch (e) {
		db.prepare("UPDATE email_drafts SET status = 'failed', error = ? WHERE id = ?").run(e instanceof Error ? e.message : String(e), id);
		throw e;
	}
	db.prepare("UPDATE email_drafts SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?").run(now(), id);
	// QQ / 163 等不会自动保存已发送：放一份到“已发送”
	if (!PRESETS[a.preset]?.autoSent)
		await withImap(a, async (c) => {
			const f = await specialFolder(c, "\\Sent");
			if (f) await c.append(f, raw, ["\\Seen"]);
		}).catch(() => {});
	return { to: dr.payload.to, subject: dr.payload.subject };
}
/** 工作区文件 → 附件 */
export function fileReader(insideWorkspace: (p: string) => string) {
	return (p: string) => {
		const abs = insideWorkspace(p);
		if (statSync(abs).size > 20 * 1024 * 1024) throw new Error(`附件太大：${p}`);
		return { name: basename(abs), data: readFileSync(abs) };
	};
}
