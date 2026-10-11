/**
 * Gmail OAuth（XOAUTH2）：用用户自己在 Google Cloud 建的 OAuth 客户端（类型选“桌面应用”），不内置任何密钥。
 * 流程：设置里填 Client ID / Secret → 点「用 Google 登录」→ 浏览器打开 Google 授权页（PKCE + state）→
 * 回调到本机 http://127.0.0.1:<端口>/api/email/oauth/google/callback → 换取 refresh token（加密保存）→
 * IMAP / SMTP 用 access token 登录（imapflow / nodemailer 都支持 XOAUTH2），过期自动刷新。
 * 授权范围 https://mail.google.com/（IMAP/SMTP 必需）。必须在这台电脑上完成（回调地址是本机回环地址）。
 */
import { createHash, randomBytes } from "node:crypto";
import { getSetting, setSetting } from "./db.ts";
import { openJson, sealJson } from "./secrets.ts";

export const GOOGLE_SCOPE = "https://mail.google.com/";
/** 测试时可替换的端点 */
export const googleEndpoints = {
	auth: "https://accounts.google.com/o/oauth2/v2/auth",
	token: "https://oauth2.googleapis.com/token",
	profile: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
};

export interface GoogleClient {
	clientId: string;
	clientSecret: string;
}
export interface OAuthSecret {
	provider: "google";
	refreshToken: string;
	accessToken?: string;
	expiresAt?: number;
}

export function googleClient(): GoogleClient | null {
	const v = getSetting<string | null>("email.googleClient", null);
	return v ? openJson<GoogleClient>(v) : null;
}
export function saveGoogleClient(c: GoogleClient | null) {
	if (c && (!c.clientId.trim().endsWith(".apps.googleusercontent.com") || !c.clientSecret.trim())) throw new Error("Client ID 应以 .apps.googleusercontent.com 结尾，Client Secret 不能为空");
	setSetting("email.googleClient", c ? sealJson({ clientId: c.clientId.trim(), clientSecret: c.clientSecret.trim() }) : null);
}

const pending = new Map<string, { verifier: string; redirectUri: string; agentId: string | null; name?: string; at: number }>();
const b64url = (b: Buffer) => b.toString("base64url");

export function startGoogle(opts: { redirectUri: string; agentId?: string | null; name?: string }) {
	const c = googleClient();
	if (!c) throw new Error("请先填写 Google OAuth 客户端（Client ID / Secret）");
	for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60_000) pending.delete(k);
	const state = b64url(randomBytes(24));
	const verifier = b64url(randomBytes(48));
	pending.set(state, { verifier, redirectUri: opts.redirectUri, agentId: opts.agentId ?? null, name: opts.name, at: Date.now() });
	const q = new URLSearchParams({
		client_id: c.clientId,
		redirect_uri: opts.redirectUri,
		response_type: "code",
		scope: GOOGLE_SCOPE,
		access_type: "offline",
		prompt: "consent",
		state,
		code_challenge: b64url(createHash("sha256").update(verifier).digest()),
		code_challenge_method: "S256",
	});
	return { url: `${googleEndpoints.auth}?${q}`, state };
}

async function tokenRequest(params: Record<string, string>) {
	const r = await fetch(googleEndpoints.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
	const j = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
	if (!r.ok || !j.access_token) throw new Error(`Google 授权失败：${j.error_description ?? j.error ?? r.status}`);
	return j;
}

/** 回调：用 code 换 token，取邮箱地址 */
export async function finishGoogle(code: string, state: string): Promise<{ address: string; secret: OAuthSecret; agentId: string | null; name?: string }> {
	const p = pending.get(state);
	pending.delete(state);
	if (!p) throw new Error("授权已过期或不是从这里发起的，请重新点「用 Google 登录」");
	const c = googleClient();
	if (!c) throw new Error("Google OAuth 客户端未配置");
	const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: p.redirectUri, client_id: c.clientId, client_secret: c.clientSecret, code_verifier: p.verifier });
	if (!t.refresh_token) throw new Error("Google 没有返回 refresh token：请在 myaccount.google.com/permissions 移除这个应用后重试");
	const prof = await fetch(googleEndpoints.profile, { headers: { authorization: `Bearer ${t.access_token}` } });
	const pj = (await prof.json().catch(() => ({}))) as { emailAddress?: string };
	if (!pj.emailAddress) throw new Error("无法读取 Gmail 地址");
	return { address: pj.emailAddress, agentId: p.agentId, name: p.name, secret: { provider: "google", refreshToken: t.refresh_token, accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 } };
}

/** 拿可用的 access token（快过期就刷新）；返回新的 secret 供保存 */
export async function freshAccessToken(s: OAuthSecret): Promise<{ token: string; secret: OAuthSecret; refreshed: boolean }> {
	if (s.accessToken && (s.expiresAt ?? 0) > Date.now() + 60_000) return { token: s.accessToken, secret: s, refreshed: false };
	const c = googleClient();
	if (!c) throw new Error("Google OAuth 客户端未配置，无法刷新登录");
	const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: s.refreshToken, client_id: c.clientId, client_secret: c.clientSecret });
	const secret: OAuthSecret = { ...s, accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000, ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}) };
	return { token: t.access_token!, secret, refreshed: true };
}
