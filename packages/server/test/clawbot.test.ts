/**
 * 微信 ClawBot（模拟腾讯 iLink 后端）：扫码登录（wait → scaned → 需要数字 → confirmed）、凭据加密保存、主人自动授权、
 * 长轮询收消息（文字 / 图片解密存工作区）、正在输入、回复带 context_token、发文件走官方 CDN 上传、
 * 平台限制：没有 token 不发；超过 23 小时 / 本轮预算用完 / 被限流（ret=-2）→ 排队，用户下次发消息时补发；隔离：状态目录在数据目录。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
const { config } = await import("../src/config.ts");
const { db, now } = await import("../src/db.ts");
db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run("wa", "小微", "W", "#000", now());
const ch = await import("../src/channels/index.ts");
const { wechatClawbotAdapter, WINDOW_BUDGET, clawbotText } = await import("../src/channels/wechat-clawbot.ts");
const { DeferredSend } = await import("../src/channels/types.ts");
const { insertMessage } = await import("../src/messages.ts");
const { openJson } = await import("../src/secrets.ts");

const KEY = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const enc = (b: Buffer) => {
	const c = createCipheriv("aes-128-ecb", KEY, null);
	return Buffer.concat([c.update(b), c.final()]);
};

// ---- 模拟 iLink
const calls: { path: string; body: Record<string, unknown>; headers: Record<string, unknown> }[] = [];
const inbox: Record<string, unknown>[] = [];
let qrSeq = ["wait", "scaned", "need_verifycode", "confirmed"];
let rateLimit = false;
const srv = createServer(async (req, res) => {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	const raw = Buffer.concat(chunks);
	const url = req.url ?? "";
	const body = req.headers["content-type"]?.includes("json") && raw.length ? JSON.parse(raw.toString()) : {};
	calls.push({ path: url, body, headers: req.headers });
	const json = (o: unknown) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(o)));
	if (url.startsWith("/ilink/bot/get_bot_qrcode")) return json({ qrcode: "QR1", qrcode_img_content: "https://liteapp.weixin.qq.com/q/mock" });
	if (url.startsWith("/ilink/bot/get_qrcode_status")) {
		const s = qrSeq.length > 1 ? qrSeq.shift()! : qrSeq[0];
		if (s === "need_verifycode" && url.includes("verify_code=123456")) return json({ status: "confirmed", bot_token: "BOT_TOKEN_SECRET", ilink_bot_id: "bot1@im.bot", ilink_user_id: "owner@im.wechat", baseurl: BASE });
		if (s === "need_verifycode") qrSeq.unshift("need_verifycode");
		return json({ status: s, ...(s === "confirmed" ? { bot_token: "BOT_TOKEN_SECRET", ilink_bot_id: "bot1@im.bot", ilink_user_id: "owner@im.wechat", baseurl: BASE } : {}) });
	}
	if (url === "/ilink/bot/getupdates") {
		for (let i = 0; i < 10 && !inbox.length; i++) await new Promise((r) => setTimeout(r, 30));
		return json({ ret: 0, msgs: inbox.splice(0), get_updates_buf: `buf${calls.length}` });
	}
	if (url === "/ilink/bot/sendmessage") return json(rateLimit ? { ret: -2, errmsg: "rate limited" } : { ret: 0, message_id: "1" });
	if (url === "/ilink/bot/getconfig") return json({ ret: 0, typing_ticket: "TT" });
	if (url === "/ilink/bot/getuploadurl") return json({ upload_full_url: `${BASE}/cdn/upload` });
	if (url === "/cdn/upload") return (res.setHeader("x-encrypted-param", "DL"), res.end());
	if (url === "/cdn/img") return res.end(enc(PNG));
	json({ ret: 0 });
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
const wait = async (pred: () => boolean, ms = 5000) => {
	for (let t = Date.now(); Date.now() - t < ms; ) {
		if (pred()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("等待超时");
};
const sends = () => calls.filter((c) => c.path === "/ilink/bot/sendmessage");
const textOf = (c: (typeof calls)[number]) => ((c.body.msg as { item_list: { text_item?: { text: string } }[] }).item_list[0]?.text_item?.text ?? "");

test("隔离：官方插件的状态目录在我们的数据目录里，不是 ~/.openclaw", () => {
	assert.ok(process.env.OPENCLAW_STATE_DIR?.startsWith(config.dataDir));
});

test("入站文字解析：文字、语音转文字、引用", () => {
	assert.equal(clawbotText({ item_list: [{ type: 1, text_item: { text: "你好" } }] }), "你好");
	assert.equal(clawbotText({ item_list: [{ type: 3, voice_item: { text: "语音内容" } }] }), "语音内容");
	assert.match(clawbotText({ item_list: [{ type: 1, text_item: { text: "嗯" }, ref_msg: { title: "原话" } }] }), /引用：原话/);
});

let chId = "";
test("扫码登录 → 输入数字 → 凭据加密保存 → 主人自动授权 → 上线", async () => {
	const c = ch.saveChannel({ kind: "wechat_clawbot", agentId: "wa", config: { apiBase: BASE, cdnBase: BASE } });
	chId = c.id;
	await wait(() => ch.channelJson(ch.getChannel(c.id)!).status.state === "waiting");
	const st = await ch.clawbotLogin(c.id);
	assert.equal(st.qrUrl, "https://liteapp.weixin.qq.com/q/mock");
	await wait(() => ch.clawbotStatus(c.id).state === "need_verifycode");
	ch.clawbotVerify(c.id, "123456");
	await wait(() => ch.clawbotStatus(c.id).state === "confirmed");
	await wait(() => ch.channelJson(ch.getChannel(c.id)!).status.state === "online");
	const row = ch.getChannel(c.id)!;
	assert.ok(!row.secret!.includes("BOT_TOKEN_SECRET"), "token 加密保存");
	assert.equal(openJson<{ botToken: string }>(row.secret!).botToken, "BOT_TOKEN_SECRET");
	assert.equal(JSON.parse(row.config).accountId, "bot1@im.bot");
	assert.ok(ch.channelJson(row).users.find((u) => u.id === "owner@im.wechat")?.allowed);
	// 轮询请求带官方的鉴权头
	const gu = calls.find((x) => x.path === "/ilink/bot/getupdates")!;
	assert.equal(gu.headers.authorizationtype, "ilink_bot_token");
	assert.equal(gu.headers.authorization, "Bearer BOT_TOKEN_SECRET");
});

test("收消息（文字 + 图片）→ 进助理对话、图片解密存工作区、正在输入；助理回复带 context_token 发回微信", async () => {
	inbox.push({ message_id: "m1", from_user_id: "owner@im.wechat", message_type: 1, context_token: "CTX1", item_list: [{ type: 1, text_item: { text: "看看这张图" } }, { type: 2, image_item: { aeskey: KEY.toString("hex"), media: { full_url: `${BASE}/cdn/img`, encrypt_query_param: "x" } } }] });
	const conv = () => (db.prepare("SELECT conversation_id FROM channel_peers WHERE channel_id = ? AND peer_id = ?").get(chId, "owner@im.wechat") as { conversation_id: string | null })?.conversation_id;
	await wait(() => !!conv() && !!db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND role = 'user'").get(conv()!));
	const um = db.prepare("SELECT content, meta FROM messages WHERE conversation_id = ? AND role = 'user'").get(conv()!) as { content: string; meta: string };
	assert.equal(um.content, "看看这张图");
	const att = JSON.parse(um.meta).attachments[0];
	assert.match(att.name, /\.png$/);
	const { workspaceOf } = await import("../src/files.ts");
	assert.ok(existsSync(join(workspaceOf("wa"), "uploads", att.name)));
	await wait(() => calls.some((x) => x.path === "/ilink/bot/sendtyping" && (x.body as { status: number }).status === 1));
	const before = sends().length;
	insertMessage({ agentId: "wa", conversationId: conv()!, role: "assistant", content: "**收到**，这是一张 PNG。", status: "done" });
	await wait(() => sends().length > before);
	const s = sends().at(-1)!;
	assert.equal((s.body.msg as { context_token: string }).context_token, "CTX1");
	assert.equal((s.body.msg as { to_user_id: string }).to_user_id, "owner@im.wechat");
	assert.match(textOf(s), /收到/);
	assert.ok(calls.some((x) => x.path === "/ilink/bot/sendtyping" && (x.body as { status: number }).status === 2), "回复后取消正在输入");
});

test("发文件：走官方 getuploadurl + CDN 加密上传 + 文件消息", async () => {
	const conv = (db.prepare("SELECT conversation_id FROM channel_peers WHERE channel_id = ? AND peer_id = ?").get(chId, "owner@im.wechat") as { conversation_id: string }).conversation_id;
	const { saveUpload } = await import("../src/files.ts");
	const f = saveUpload("wa", "报告.txt", Buffer.from("hello"));
	const before = sends().length;
	insertMessage({ agentId: "wa", conversationId: conv, role: "assistant", content: "报告做好了", status: "done", meta: { attachments: [{ id: f.id, name: f.name }] } });
	await wait(() => sends().length >= before + 2);
	assert.ok(calls.some((x) => x.path === "/ilink/bot/getuploadurl"));
	assert.ok(calls.some((x) => x.path === "/cdn/upload"));
	const fileMsg = sends().at(-1)!.body.msg as { item_list: { type: number; file_item?: { file_name: string } }[] };
	assert.equal(fileMsg.item_list[0].type, 4);
	assert.equal(fileMsg.item_list[0].file_item?.file_name, "报告.txt");
});

test("平台限制（适配器）：没 token 不发；超过 23 小时不发；本轮预算用完不发；被限流 → DeferredSend", async () => {
	const a = wechatClawbotAdapter({ config: { apiBase: BASE, cdnBase: BASE }, secret: { botToken: "T" }, onMessage() {}, setStatus() {} });
	await assert.rejects(a.send({ to: "u" }, "hi"), DeferredSend);
	await assert.rejects(a.send({ to: "u", contextToken: "C", at: Date.now() - 24 * 3600_000 }, "hi"), /23 小时/);
	const ctx = { to: "u", contextToken: "C", at: Date.now() };
	assert.equal(a.canPush!(ctx).ok, true);
	for (let i = 0; i < WINDOW_BUDGET; i++) await a.send(ctx, `第${i}条`);
	assert.equal(a.canPush!(ctx).ok, false);
	await assert.rejects(a.send(ctx, "多一条"), /本轮已发/);
	const b = wechatClawbotAdapter({ config: { apiBase: BASE, cdnBase: BASE }, secret: { botToken: "T" }, onMessage() {}, setStatus() {} });
	rateLimit = true;
	await assert.rejects(b.send(ctx, "x"), /限流/);
	rateLimit = false;
});

test("主动发送：窗口外 → 排队 + 不调用 sendmessage；用户下次发消息时先补发", async () => {
	// 把主人的最近入站时间改成 25 小时前（窗口已关）
	const p = db.prepare("SELECT ctx FROM channel_peers WHERE channel_id = ? AND peer_id = ?").get(chId, "owner@im.wechat") as { ctx: string };
	const ctx = { ...JSON.parse(p.ctx), at: Date.now() - 25 * 3600_000 };
	db.prepare("UPDATE channel_peers SET ctx = ? WHERE channel_id = ? AND peer_id = ?").run(JSON.stringify(ctx), chId, "owner@im.wechat");
	assert.equal(ch.channelCanPush(chId, "owner@im.wechat").ok, false);
	const before = sends().length;
	assert.equal(await ch.channelPush(chId, "owner@im.wechat", "提醒：下午 5 点开会"), false);
	assert.equal(sends().length, before, "窗口外不发");
	assert.equal(ch.channelJson(ch.getChannel(chId)!).queued, 1);
	inbox.push({ message_id: "m2", from_user_id: "owner@im.wechat", message_type: 1, context_token: "CTX2", item_list: [{ type: 1, text_item: { text: "在吗" } }] });
	await wait(() => sends().some((s) => textOf(s).includes("提醒：下午 5 点开会")));
	const s = sends().find((x) => textOf(x).includes("提醒"))!;
	assert.equal((s.body.msg as { context_token: string }).context_token, "CTX2", "补发用新的 token");
	assert.match(textOf(s), /你不在时有 1 条消息/);
	assert.equal(ch.channelJson(ch.getChannel(chId)!).queued, 0);
});

test.after(async () => {
	await ch.stopChannels();
	srv.close();
	void writeFileSync;
});
