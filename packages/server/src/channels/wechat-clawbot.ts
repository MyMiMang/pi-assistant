/**
 * 微信 ClawBot（腾讯官方“微信 › 设置 › 插件 › ClawBot”）渠道。
 *
 * 复用腾讯官方插件 @tencent-weixin/openclaw-weixin（MIT）的协议层：api（getupdates / sendmessage / getconfig /
 * sendtyping / getuploadurl）、CDN 上传下载与 AES 加解密、Markdown 过滤、文字/图片/文件消息构造。插件依赖的
 * OpenClaw SDK 只用到 3 个小函数，由 packages/openclaw-shim 提供；状态目录强制在我们的数据目录里。
 * 扫码登录流程按官方实现的同一组接口（ilink/bot/get_bot_qrcode、get_qrcode_status）自己驱动，方便在网页/手机上显示二维码。
 *
 * 平台限制（来自官方插件源码与文档，我们照做、不绕过）：
 *  - 只支持单聊；扫码绑定的人就是主人（其他人加不了这个 bot）。
 *  - 每条出站消息必须带该用户最近一条入站消息下发的 context_token（官方 sendWeixinOutbound / 定时任务投递也是复用最近的 token）。
 *    没有 token 时我们直接不发（fail closed），不伪造。
 *  - 用户 24 小时没发消息后，下发会被丢弃；同一窗口内条数有限（超出 sendmessage 返回 ret=-2 rate limited）。
 *    所以：距离用户上次发消息超过 23 小时、或本窗口已发满预算、或被限流 → 抛 DeferredSend，渠道层排队到用户下次发消息时补发。
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config as appConfig } from "../config.ts";
import type { AdapterDeps, ChannelAdapter, Inbound } from "./types.ts";
import { DeferredSend } from "./types.ts";

type Api = typeof import("@tencent-weixin/openclaw-weixin/dist/src/api/api.js");
const OFFICIAL = "@tencent-weixin/openclaw-weixin/dist/src";
let mods: Promise<{
	api: Api;
	send: typeof import("@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js");
	media: typeof import("@tencent-weixin/openclaw-weixin/dist/src/messaging/send-media.js");
	download: typeof import("@tencent-weixin/openclaw-weixin/dist/src/media/media-download.js");
}> | null = null;
/** 懒加载官方模块（加载前确认状态目录已指向我们的数据目录） */
export function official() {
	if (!process.env.OPENCLAW_STATE_DIR?.startsWith(appConfig.dataDir)) throw new Error("OPENCLAW_STATE_DIR 未指向数据目录");
	mods ??= (async () => ({
		api: await import(`${OFFICIAL}/api/api.js`),
		send: await import(`${OFFICIAL}/messaging/send.js`),
		media: await import(`${OFFICIAL}/messaging/send-media.js`),
		download: await import(`${OFFICIAL}/media/media-download.js`),
	}))();
	return mods;
}

export const DEFAULT_API = "https://ilinkai.weixin.qq.com";
export const DEFAULT_CDN = "https://novac2c.cdn.weixin.qq.com/c2c";
/** 距用户上次发消息多久以内可以发（平台约 24 小时，留 1 小时余量） */
export const WINDOW_MS = 23 * 3600_000;
/** 每个窗口（用户发一条消息后）最多发几条，超出排队（平台对条数有限制） */
export const WINDOW_BUDGET = 10;

export interface ClawbotConfig {
	apiBase?: string;
	cdnBase?: string;
	accountId?: string;
	ownerUserId?: string;
	ownerName?: string;
}
export interface ClawbotSecret {
	botToken?: string;
}

// ---------------------------------------------------------------- 扫码登录
type LoginState = { state: "idle" | "wait" | "scaned" | "need_verifycode" | "confirmed" | "expired" | "error"; qrUrl?: string; message: string; startedAt: number };
const logins = new Map<string, LoginState & { qrcode?: string; base?: string; verify?: string; stop?: boolean }>();

export function loginStatus(channelId: string): LoginState {
	const l = logins.get(channelId);
	if (!l) return { state: "idle", message: "", startedAt: 0 };
	return { state: l.state, qrUrl: l.qrUrl, message: l.message, startedAt: l.startedAt };
}
export function submitVerifyCode(channelId: string, code: string) {
	const l = logins.get(channelId);
	if (!l || l.state !== "need_verifycode") throw new Error("现在不需要输入数字");
	l.verify = code.replace(/\D/g, "").slice(0, 12);
	l.state = "scaned";
	l.message = "正在验证…";
}
export function cancelLogin(channelId: string) {
	const l = logins.get(channelId);
	if (l) l.stop = true;
	logins.delete(channelId);
}

/**
 * 发起扫码：返回二维码内容（一个链接，用微信扫，或在手机上长按识别）。后台轮询状态，确认后调用 onConfirmed 保存凭据。
 */
export async function startLogin(channelId: string, cfg: ClawbotConfig, existingToken: string | undefined, onConfirmed: (r: { botToken: string; accountId: string; baseUrl?: string; userId?: string }) => void): Promise<LoginState> {
	cancelLogin(channelId);
	const { api } = await official();
	const base = cfg.apiBase || DEFAULT_API;
	const fetchQr = async () =>
		JSON.parse(await api.apiPostFetch({ baseUrl: base, endpoint: "ilink/bot/get_bot_qrcode?bot_type=3", body: JSON.stringify({ local_token_list: existingToken ? [existingToken] : [] }), label: "fetchQRCode" })) as { qrcode: string; qrcode_img_content: string };
	const qr = await fetchQr();
	const l = { state: "wait" as LoginState["state"], qrUrl: qr.qrcode_img_content, qrcode: qr.qrcode, base, message: "用微信扫码（或在手机上长按二维码识别），在微信里确认连接", startedAt: Date.now() } as LoginState & { qrcode?: string; base?: string; verify?: string; stop?: boolean };
	logins.set(channelId, l);
	void (async () => {
		let refreshes = 0;
		const deadline = Date.now() + 8 * 60_000;
		while (!l.stop && Date.now() < deadline) {
			let st: { status: string; bot_token?: string; ilink_bot_id?: string; baseurl?: string; ilink_user_id?: string; redirect_host?: string };
			try {
				let ep = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(l.qrcode!)}`;
				if (l.verify) ep += `&verify_code=${encodeURIComponent(l.verify)}`;
				st = JSON.parse(await api.apiGetFetch({ baseUrl: l.base!, endpoint: ep, timeoutMs: 35_000, label: "pollQRStatus" }));
			} catch {
				st = { status: "wait" };
			}
			if (l.stop) return;
			switch (st.status) {
				case "scaned":
					l.verify = undefined;
					(l.state = "scaned"), (l.message = "已扫码，请在微信里确认");
					break;
				case "scaned_but_redirect":
					if (st.redirect_host) l.base = `https://${st.redirect_host}`;
					break;
				case "need_verifycode":
					if (l.state !== "need_verifycode") (l.state = "need_verifycode"), (l.message = l.verify ? "数字不对，请重新输入微信里显示的数字" : "请输入手机微信上显示的数字");
					l.verify = undefined;
					await new Promise((r) => setTimeout(r, 1000));
					while (!l.stop && l.state === "need_verifycode") await new Promise((r) => setTimeout(r, 300));
					continue;
				case "expired":
				case "verify_code_blocked":
					if (++refreshes > 3) return void ((l.state = "expired"), (l.message = "二维码多次失效，请稍后重试"));
					try {
						const n = await fetchQr();
						Object.assign(l, { qrcode: n.qrcode, qrUrl: n.qrcode_img_content, state: "wait", message: "二维码已刷新，请重新扫描", startedAt: Date.now() });
					} catch (e) {
						return void ((l.state = "error"), (l.message = `刷新二维码失败：${e instanceof Error ? e.message : e}`));
					}
					break;
				case "binded_redirect":
					return void ((l.state = "confirmed"), (l.message = "这个微信已经连接过了，继续使用原来的凭据"));
				case "confirmed":
					if (!st.bot_token || !st.ilink_bot_id) return void ((l.state = "error"), (l.message = "登录失败：服务器没有返回凭据"));
					(l.state = "confirmed"), (l.message = "已连接微信 ✅");
					l.qrUrl = undefined;
					onConfirmed({ botToken: st.bot_token, accountId: st.ilink_bot_id, baseUrl: st.baseurl, userId: st.ilink_user_id });
					return;
			}
			await new Promise((r) => setTimeout(r, 1000));
		}
		if (!l.stop && l.state !== "confirmed") (l.state = "expired"), (l.message = "登录超时，请重试");
	})();
	return loginStatus(channelId);
}

// ---------------------------------------------------------------- 收发
interface Msg {
	message_id?: string;
	from_user_id?: string;
	message_type?: number;
	context_token?: string;
	item_list?: { type?: number; text_item?: { text?: string }; voice_item?: { text?: string }; file_item?: { file_name?: string }; ref_msg?: { title?: string; message_item?: { text_item?: { text?: string } } } }[];
}

export function sniffExt(b: Buffer, ct?: string) {
	if (b[0] === 0x89 && b[1] === 0x50) return ".png";
	if (b[0] === 0xff && b[1] === 0xd8) return ".jpg";
	if (b.subarray(0, 3).toString() === "GIF") return ".gif";
	if (b.subarray(4, 8).toString() === "ftyp") return ".mp4";
	if (ct?.includes("wav")) return ".wav";
	if (ct?.includes("silk")) return ".silk";
	return ".bin";
}

/** 一条入站消息 → 文字（含语音转文字、引用） */
export function clawbotText(m: Msg): string {
	const parts: string[] = [];
	for (const it of m.item_list ?? []) {
		if (it.type === 1 && it.text_item?.text) parts.push(it.text_item.text);
		else if (it.type === 3) parts.push(it.voice_item?.text ? it.voice_item.text : "[语音]");
		if (it.ref_msg) parts.unshift(`（引用：${it.ref_msg.title ?? it.ref_msg.message_item?.text_item?.text ?? ""}）`);
	}
	return parts.join("\n").trim();
}

export interface ClawbotAdapter extends ChannelAdapter {
	/** 测试用：当前窗口内已发条数 */
	_sent(to: string): number;
}

export function wechatClawbotAdapter(d: AdapterDeps<ClawbotConfig, ClawbotSecret> & { channelId?: string }): ClawbotAdapter {
	const base = () => d.config.apiBase || DEFAULT_API;
	const cdn = () => d.config.cdnBase || DEFAULT_CDN;
	const token = () => d.secret.botToken;
	let stopped = false;
	let abort: AbortController | null = null;
	const sent = new Map<string, number>();
	const typing = new Map<string, { ticket?: string; timer?: NodeJS.Timeout; until: number }>();
	const bufFile = () => join(process.env.OPENCLAW_STATE_DIR!, "pia", `${d.config.accountId ?? "x"}.buf`);
	const loadBuf = async () => (await import("node:fs")).readFileSync(bufFile(), "utf8");
	const saveBuf = (b: string) => (mkdirSync(join(process.env.OPENCLAW_STATE_DIR!, "pia"), { recursive: true }), writeFileSync(bufFile(), b));

	const opts = (ctx: Record<string, unknown>) => ({ baseUrl: base(), token: token(), contextToken: String(ctx.contextToken ?? "") || undefined });
	function gate(ctx: Record<string, unknown>) {
		const to = String(ctx.to ?? "");
		if (!to || !ctx.contextToken) return { ok: false, reason: "还没有收到过这个人的消息（微信要求先由用户发起）" };
		if (Date.now() - Number(ctx.at ?? 0) > WINDOW_MS) return { ok: false, reason: "用户超过 23 小时没发消息，微信不允许现在发" };
		if ((sent.get(to) ?? 0) >= WINDOW_BUDGET) return { ok: false, reason: `本轮已发 ${WINDOW_BUDGET} 条，等用户回复后再发` };
		return { ok: true };
	}
	const check = (ctx: Record<string, unknown>) => {
		const g = gate(ctx);
		if (!g.ok) throw new DeferredSend(g.reason!);
	};
	const rateLimited = (e: unknown) => /ret=-2|rate limited/i.test(String(e instanceof Error ? e.message : e));

	async function startTyping(to: string, contextToken?: string) {
		const { api } = await official();
		let t = typing.get(to);
		if (!t?.ticket) {
			const cfg = (await api.getConfig({ baseUrl: base(), token: token(), ilinkUserId: to, contextToken }).catch(() => null)) as { typing_ticket?: string } | null;
			if (!cfg?.typing_ticket) return;
			t = { ticket: cfg.typing_ticket, until: 0 };
			typing.set(to, t);
		}
		t.until = Date.now() + 3 * 60_000;
		const tick = () => void api.sendTyping({ baseUrl: base(), token: token(), body: { ilink_user_id: to, typing_ticket: t!.ticket, status: 1 } as never }).catch(() => {});
		tick();
		clearInterval(t.timer);
		t.timer = setInterval(() => (Date.now() > t!.until ? stopTyping(to) : tick()), 5000);
	}
	async function stopTyping(to: string) {
		const t = typing.get(to);
		if (!t?.timer) return;
		clearInterval(t.timer);
		t.timer = undefined;
		const { api } = await official();
		await api.sendTyping({ baseUrl: base(), token: token(), body: { ilink_user_id: to, typing_ticket: t.ticket, status: 2 } as never }).catch(() => {});
	}

	async function handle(m: Msg) {
		if (m.message_type !== 1 || !m.from_user_id) return; // 只处理用户发来的（不处理 bot 自己的回显）
		const to = m.from_user_id;
		sent.set(to, 0); // 新窗口
		const files: { name: string; data: Buffer }[] = [];
		const { download } = await official();
		for (const it of m.item_list ?? []) {
			if (![2, 4, 5].includes(it.type ?? 0)) continue;
			await download
				.downloadMediaFromItem(it as never, {
					cdnBaseUrl: cdn(),
					saveMedia: (async (buf: Buffer, contentType?: string, _sub?: string, _max?: number, name?: string) => {
						const fname = name || it.file_item?.file_name || `wechat-${Date.now()}${sniffExt(buf, contentType)}`;
						files.push({ name: basename(fname), data: buf });
						return { path: fname, contentType };
					}) as never,
					log: () => {},
					errLog: (s: string) => console.warn(`[clawbot] ${s}`),
					label: "inbound",
				})
				.catch((e: unknown) => console.warn(`[clawbot] 下载媒体失败：${e instanceof Error ? e.message : e}`));
		}
		const text = clawbotText(m) || (files.length ? "（发来了文件）" : "");
		if (!text) return;
		void startTyping(to, m.context_token);
		const inbound: Inbound = { userId: to, peerId: to, display: to === d.config.ownerUserId ? (d.config.ownerName ?? "我") : undefined, text, msgId: m.message_id, ctx: { to, contextToken: m.context_token, at: Date.now() }, files };
		d.onMessage(inbound);
	}

	async function loop() {
		const { api } = await official();
		let buf = "";
		try {
			buf = await loadBuf();
		} catch {}
		let backoff = 1000;
		while (!stopped) {
			abort = new AbortController();
			try {
				const r = (await api.getUpdates({ baseUrl: base(), token: token(), get_updates_buf: buf, abortSignal: abort.signal } as never)) as { ret?: number; errcode?: number; errmsg?: string; msgs?: Msg[]; get_updates_buf?: string };
				if (stopped) break;
				if (r.errcode === -14 || r.ret === -14) {
					d.setStatus({ state: "error", detail: "微信登录已过期，请在设置里重新扫码" });
					return;
				}
				if (r.ret && r.ret !== 0) throw new Error(`getupdates ret=${r.ret} ${r.errmsg ?? ""}`);
				d.setStatus({ state: "online", detail: "已连接（单聊）" });
				backoff = 1000;
				if (r.get_updates_buf && r.get_updates_buf !== buf) (buf = r.get_updates_buf), saveBuf(buf);
				for (const m of r.msgs ?? []) await handle(m).catch((e) => console.warn(`[clawbot] ${e instanceof Error ? e.message : e}`));
			} catch (e) {
				if (stopped) break;
				d.setStatus({ state: "connecting", detail: `重连中：${e instanceof Error ? e.message : e}` });
				await new Promise((r) => setTimeout(r, backoff));
				backoff = Math.min(backoff * 2, 60_000);
			}
		}
	}

	return {
		async start() {
			if (!token()) return d.setStatus({ state: "waiting", detail: "还没连接：点「扫码连接」，用微信扫码" });
			stopped = false;
			d.setStatus({ state: "connecting", detail: "连接中" });
			const { api } = await official();
			await api.notifyStart({ baseUrl: base(), token: token() }).catch(() => {});
			void loop();
		},
		async stop() {
			stopped = true;
			abort?.abort();
			for (const to of typing.keys()) await stopTyping(to);
			if (token()) await (await official()).api.notifyStop({ baseUrl: base(), token: token() }).catch(() => {});
		},
		canPush: gate,
		async send(ctx, markdown) {
			check(ctx);
			const to = String(ctx.to);
			await stopTyping(to);
			const { send } = await official();
			const f = new send.StreamingMarkdownFilter();
			const text = (f.feed(markdown) + f.flush()).trim();
			// 长消息分段（太长或连发太快，平台会丢 / 显示“请稍后再试”）
			const chunks = text.match(/[\s\S]{1,1800}/g) ?? [];
			for (const [i, chunk] of chunks.entries()) {
				check(ctx);
				try {
					await send.sendMessageWeixin({ to, text: chunk, opts: opts(ctx) as never });
				} catch (e) {
					if (rateLimited(e)) throw new DeferredSend("微信限流（本轮发得太多），等用户回复后补发");
					throw e;
				}
				sent.set(to, (sent.get(to) ?? 0) + 1);
				if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 600));
			}
		},
		async sendFile(ctx, path, name, o) {
			check(ctx);
			await stopTyping(String(ctx.to));
			const { media, send } = await official();
			// 说明文字和图片同一次发（官方实现里是同一条消息的两个条目），省一条窗口额度
			let caption = "";
			if (o?.caption) {
				const f = new send.StreamingMarkdownFilter();
				caption = (f.feed(o.caption) + f.flush()).trim().slice(0, 1800);
			}
			// 官方实现用文件名作为微信里显示的名字：复制一份到临时目录，保留原名
			mkdirSync(join(process.env.OPENCLAW_STATE_DIR!, "tmp"), { recursive: true });
			const dir = mkdtempSync(join(process.env.OPENCLAW_STATE_DIR!, "tmp", "out-"));
			const named = join(dir, basename(name).replace(/[\\/:*?"<>|]/g, "_") || "file");
			try {
				copyFileSync(path, named);
				await media.sendWeixinMediaFile({ filePath: named, to: String(ctx.to), text: caption, opts: opts(ctx) as never, cdnBaseUrl: cdn() });
			} catch (e) {
				if (rateLimited(e)) throw new DeferredSend("微信限流，等用户回复后补发");
				throw new Error(`发送文件 ${name} 失败：${e instanceof Error ? e.message : e}`);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
			sent.set(String(ctx.to), (sent.get(String(ctx.to)) ?? 0) + 1);
		},
		async test() {
			if (!token()) throw new Error("还没扫码连接");
			return `已连接（账号 ${d.config.accountId ?? "?"}）`;
		},
		_sent: (to) => sent.get(to) ?? 0,
	};
}
