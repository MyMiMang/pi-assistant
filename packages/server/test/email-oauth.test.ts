/**
 * Gmail OAuth（模拟 Google 授权服务 + 支持 XOAUTH2 的模拟 IMAP/SMTP）：
 * 填客户端 → 发起（PKCE + state）→ 回调换 token（校验 code_verifier）→ 读 Gmail 地址建账号（refresh token 加密保存）→
 * access token 过期自动刷新并写回 → IMAP / SMTP 都用 XOAUTH2 登录成功；伪造 state 拒绝；密钥不外露。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const hoodiecrow = require("hoodiecrow-imap");
const { SMTPServer } = await import("smtp-server");
const { db } = await import("../src/db.ts");
const oauth = await import("../src/email-oauth.ts");
const email = await import("../src/email.ts");

const ADDR = "me.assistant@gmail.com";
const imap = hoodiecrow({ plugins: ["SASL-IR", "XOAUTH2", "ID"], users: { [ADDR]: { password: "x", xoauth2: { accessToken: "AT-2", sessionTimeout: 3600 } } }, storage: { INBOX: { messages: [] } } });
await new Promise<void>((r) => imap.listen(0, "127.0.0.1", r));
const smtpAuth: string[] = [];
const smtp = new SMTPServer({
	authMethods: ["XOAUTH2"],
	allowInsecureAuth: true,
	disabledCommands: ["STARTTLS"],
	onAuth: (a, _s, cb) => (smtpAuth.push(`${a.method}:${a.username}:${a.accessToken}`), a.accessToken === "AT-2" ? cb(null, { user: a.username }) : cb(null, { data: { status: "401" } } as never)),
	logger: false,
});
await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));

let challenge = "";
const tokenCalls: Record<string, string>[] = [];
const google = createServer(async (req, res) => {
	let b = "";
	for await (const c of req) b += c;
	res.setHeader("content-type", "application/json");
	if (req.url === "/token") {
		const p = Object.fromEntries(new URLSearchParams(b));
		tokenCalls.push(p);
		if (p.client_secret !== "GOCSPX-test") return res.writeHead(401).end(JSON.stringify({ error: "invalid_client" }));
		if (p.grant_type === "authorization_code") {
			const ok = p.code === "CODE1" && createHash("sha256").update(p.code_verifier).digest("base64url") === challenge;
			if (!ok) return res.writeHead(400).end(JSON.stringify({ error: "invalid_grant", error_description: "PKCE 校验失败" }));
			return res.end(JSON.stringify({ access_token: "AT-1", refresh_token: "RT-1", expires_in: 30 })); // 30 秒：马上就要刷新
		}
		if (p.grant_type === "refresh_token" && p.refresh_token === "RT-1") return res.end(JSON.stringify({ access_token: "AT-2", expires_in: 3600 }));
		return res.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
	}
	if (req.url === "/profile") return req.headers.authorization === "Bearer AT-1" ? res.end(JSON.stringify({ emailAddress: ADDR })) : res.writeHead(401).end("{}");
	res.writeHead(404).end("{}");
});
await new Promise<void>((r) => google.listen(0, "127.0.0.1", r));
const G = `http://127.0.0.1:${(google.address() as { port: number }).port}`;
Object.assign(oauth.googleEndpoints, { auth: "https://accounts.google.com/o/oauth2/v2/auth", token: `${G}/token`, profile: `${G}/profile` });

test("Gmail OAuth：授权 → 建账号 → 自动刷新 → IMAP/SMTP XOAUTH2", async () => {
	assert.throws(() => oauth.startGoogle({ redirectUri: "http://127.0.0.1:1/cb" }), /Client ID/);
	assert.throws(() => oauth.saveGoogleClient({ clientId: "abc", clientSecret: "s" }), /apps\.googleusercontent\.com/);
	oauth.saveGoogleClient({ clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-test" });
	const { url, state } = oauth.startGoogle({ redirectUri: "http://127.0.0.1:8787/api/email/oauth/google/callback", agentId: null, name: "助理的 Gmail" });
	const u = new URL(url);
	assert.equal(u.searchParams.get("scope"), "https://mail.google.com/");
	assert.equal(u.searchParams.get("access_type"), "offline");
	assert.equal(u.searchParams.get("code_challenge_method"), "S256");
	assert.equal(u.searchParams.get("state"), state);
	challenge = u.searchParams.get("code_challenge")!;
	await assert.rejects(oauth.finishGoogle("CODE1", "forged"), /过期|不是从这里发起/);
	const r = await oauth.finishGoogle("CODE1", state);
	assert.equal(r.address, ADDR);
	await assert.rejects(oauth.finishGoogle("CODE1", state), /过期/, "state 只能用一次");
	const a = email.saveOAuthAccount(r);
	assert.equal(a.preset, "gmail");
	assert.equal(email.accountJson(a).oauth, true);
	assert.ok(!JSON.stringify(email.accountJson(a)).includes("RT-1"), "公开信息不含 token");
	assert.ok(!a.secret.includes("RT-1"), "refresh token 加密保存");
	// 指向本机模拟服务器
	const cfg = JSON.parse(a.config);
	cfg.imap = { host: "127.0.0.1", port: (imap.server.address() as { port: number }).port, secure: false };
	cfg.smtp = { host: "127.0.0.1", port: (smtp.server.address() as { port: number }).port, secure: false };
	cfg.insecure = true;
	db.prepare("UPDATE email_accounts SET config = ? WHERE id = ?").run(JSON.stringify(cfg), a.id);
	assert.match(await email.testAccount(a.id), /收信、发信都正常/);
	assert.equal(tokenCalls.filter((t) => t.grant_type === "refresh_token").length, 1, "快过期的 access token 先刷新");
	assert.deepEqual(smtpAuth, [`XOAUTH2:${ADDR}:AT-2`]);
	// 刷新后的 token 写回，再测一次不再刷新
	await email.testAccount(a.id);
	assert.equal(tokenCalls.filter((t) => t.grant_type === "refresh_token").length, 1);
	// 改名不会丢掉 OAuth 凭据
	email.saveAccount({ id: a.id, address: ADDR, preset: "gmail", name: "新名字" });
	assert.equal(email.getAccount(a.id)!.name, "新名字");
	assert.match(await email.testAccount(a.id), /正常/);
	// 同一地址再次授权 = 更新，不重复建账号
	email.saveOAuthAccount({ ...r, secret: { provider: "google", refreshToken: "RT-1" } });
	assert.equal(email.listAccounts().filter((x) => x.address === ADDR).length, 1);
});

test.after(() => {
	imap.close?.();
	smtp.close(() => {});
	google.close();
});
