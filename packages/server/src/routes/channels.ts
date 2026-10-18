/** 从 http.ts 拆出的路由（行为不变）。 */
import { Hono } from "hono";
import QRCode from "qrcode";
import { config } from "../config.ts";
import { tunnelStatus } from "../tunnel.ts";
import { BRAND } from "@pi-assistant/shared";
import { openWechat, saveWechatSettings, wechatSettings, wechatStatus } from "../wechat.ts";
import { accountJson, deleteAccount, getAccount, listAccounts, PRESETS, saveAccount, saveOAuthAccount, testAccount } from "../email.ts";
import { finishGoogle, googleClient, saveGoogleClient, startGoogle } from "../email-oauth.ts";
import { channelJson, clawbotCancel, clawbotLogin, clawbotStatus, clawbotVerify, deleteChannel, getChannel, listChannels, rotateBindCode, saveChannel, setPeerAllowed, testChannel, type ChannelKind } from "../channels/index.ts";
import { localOnly, type Env } from "./common.ts";

async function withQr<T extends { qrUrl?: string }>(s: T) {
	return { ...s, qrImg: s.qrUrl ? await QRCode.toDataURL(s.qrUrl, { margin: 1, width: 320 }) : undefined };
}

export function mountChannelRoutes(app: Hono<Env>) {
	// ---------------------------------------------------------------- 聊天渠道（企业微信 / 飞书 / 钉钉）
	app.get("/api/channels", (c) => {
		const t = tunnelStatus();
		return c.json({ items: listChannels().map(channelJson), publicUrl: t.state === "online" ? t.url : null, tunnelMode: t.mode });
	});
	app.post("/api/channels", localOnly, async (c) => {
		try {
			const b = await c.req.json<{ kind: ChannelKind; name?: string; agentId: string; config?: Record<string, unknown>; secret?: Record<string, unknown> }>();
			return c.json(channelJson(saveChannel(b)));
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.put("/api/channels/:id", localOnly, async (c) => {
		const cur = getChannel(c.req.param("id")!);
		if (!cur) return c.json({ error: "not_found" }, 404);
		try {
			const b = await c.req.json<{ name?: string; agentId?: string; enabled?: boolean; config?: Record<string, unknown>; secret?: Record<string, unknown> }>();
			return c.json(channelJson(saveChannel({ ...b, id: cur.id, kind: cur.kind, agentId: b.agentId ?? cur.agent_id })));
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.delete("/api/channels/:id", localOnly, async (c) => {
		await deleteChannel(c.req.param("id")!);
		return c.json({ ok: true });
	});
	// 微信 ClawBot 扫码连接：已配对的手机也能看二维码（在手机上长按识别），所以不限本机
	app.post("/api/channels/:id/clawbot/login", async (c) => {
		try {
			return c.json(await withQr(await clawbotLogin(c.req.param("id")!)));
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.get("/api/channels/:id/clawbot/login", async (c) => c.json(await withQr(clawbotStatus(c.req.param("id")!))));
	app.post("/api/channels/:id/clawbot/verify", async (c) => {
		try {
			clawbotVerify(c.req.param("id")!, String((await c.req.json<{ code: string }>()).code ?? ""));
			return c.json({ ok: true });
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.delete("/api/channels/:id/clawbot/login", (c) => (clawbotCancel(c.req.param("id")!), c.json({ ok: true })));
	app.post("/api/channels/:id/test", localOnly, async (c) => {
		try {
			return c.json({ ok: true, message: await testChannel(c.req.param("id")!) });
		} catch (e) {
			return c.json({ ok: false, message: e instanceof Error ? e.message : String(e) });
		}
	});
	app.post("/api/channels/:id/bind-code", localOnly, (c) => c.json({ bindCode: rotateBindCode(c.req.param("id")!) }));
	app.put("/api/channels/:id/users/:peer", localOnly, async (c) => {
		const { allowed } = await c.req.json<{ allowed: boolean }>();
		setPeerAllowed(c.req.param("id")!, c.req.param("peer")!, !!allowed);
		return c.json({ ok: true });
	});
	// ---------------------------------------------------------------- 邮箱（IMAP / SMTP）
	// Gmail OAuth：用用户自己的 Google OAuth 客户端（桌面应用类型），回调到本机回环地址
	app.get("/api/email/oauth/google", (c) => {
		const g = googleClient();
		return c.json({ configured: !!g, clientId: g?.clientId ?? null, redirectUri: `http://127.0.0.1:${config.port}/api/email/oauth/google/callback` });
	});
	app.put("/api/email/oauth/google", localOnly, async (c) => {
		const b = await c.req.json<{ clientId?: string; clientSecret?: string; clear?: boolean }>();
		try {
			saveGoogleClient(b.clear ? null : { clientId: b.clientId ?? "", clientSecret: b.clientSecret ?? "" });
			return c.json({ ok: true });
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.post("/api/email/oauth/google/start", localOnly, async (c) => {
		const b = await c.req.json<{ agentId?: string | null; name?: string }>().catch(() => ({}) as { agentId?: string; name?: string });
		try {
			return c.json(startGoogle({ redirectUri: `http://127.0.0.1:${config.port}/api/email/oauth/google/callback`, agentId: b.agentId ?? null, name: b.name }));
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.get("/api/email/oauth/google/callback", localOnly, async (c) => {
		const page = (title: string, msg: string) => c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font-family:system-ui;padding:48px;max-width:560px;margin:auto"><h2>${title}</h2><p>${msg}</p><p style="color:#888">可以关闭这个页面，回到 ${BRAND.name}。</p><script>try{window.opener&&window.opener.postMessage({type:"pia-oauth",ok:${title.startsWith("✅")}},"*")}catch(e){}</script></body>`);
		const esc = (x: string) => x.replace(/[<>&"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
		const err = c.req.query("error");
		if (err) return page("❌ 没有完成授权", esc(err));
		try {
			const r = await finishGoogle(c.req.query("code") ?? "", c.req.query("state") ?? "");
			const a = saveOAuthAccount(r);
			return page("✅ 已连接 Gmail", `${esc(a.address)} 已添加，助理可以读邮件、写草稿；发送前仍会先问你。`);
		} catch (e) {
			return page("❌ 连接失败", esc(e instanceof Error ? e.message : String(e)));
		}
	});
	app.get("/api/email", (c) => c.json({ items: listAccounts().map(accountJson), presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, help: p.help, imap: p.imap, smtp: p.smtp })) }));
	app.post("/api/email", localOnly, async (c) => {
		try {
			const a = saveAccount(await c.req.json());
			return c.json(accountJson(a));
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.put("/api/email/:id", localOnly, async (c) => {
		const cur = getAccount(c.req.param("id")!);
		if (!cur) return c.json({ error: "not_found" }, 404);
		try {
			return c.json(accountJson(saveAccount({ ...(await c.req.json()), id: cur.id })));
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.delete("/api/email/:id", localOnly, (c) => (deleteAccount(c.req.param("id")!), c.json({ ok: true })));
	app.post("/api/email/:id/test", localOnly, async (c) => {
		try {
			return c.json({ ok: true, message: await testAccount(c.req.param("id")!) });
		} catch (e) {
			return c.json({ ok: false, message: e instanceof Error ? e.message : String(e) });
		}
	});
	// ---------------------------------------------------------------- 个人微信（可选，实验）
	app.get("/api/wechat", (c) => c.json(wechatSettings()));
	app.put("/api/wechat", localOnly, async (c) => {
		const b = (await c.req.json()) as { enabled?: boolean; acknowledge?: boolean; agentIds?: string[] };
		try {
			return c.json(saveWechatSettings({ ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), ...(b.agentIds ? { agentIds: b.agentIds } : {}), ...(b.acknowledge ? { acknowledgedAt: Date.now() } : {}) }));
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.get("/api/wechat/:agentId/status", async (c) => c.json(await wechatStatus(c.req.param("agentId")!)));
	app.post("/api/wechat/:agentId/open", localOnly, async (c) => {
		try {
			return c.json(await openWechat(c.req.param("agentId")!));
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
}
