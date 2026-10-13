/**
 * 渠道出站媒体：思考内容剥离、Markdown → 纯文本、渠道能力说明、图片按能力转换 / 改发文件、签名下载链接，
 * 以及企业微信 / 钉钉 / 飞书适配器的原生图片、文件消息（模拟 OpenAPI，校验上传 + 发送两步）。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const { splitThinking, stripThinking } = await import("../src/thinking.ts");
const { CAPS, channelContext, markdownToPlain } = await import("../src/channels/caps.ts");
const media = await import("../src/channels/media.ts");
const { wecomAdapter } = await import("../src/channels/wecom.ts");
const { dingtalkAdapter } = await import("../src/channels/dingtalk.ts");
const { feishuAdapter } = await import("../src/channels/feishu.ts");
const { channelText } = await import("../src/channels/index.ts");

const calls: { path: string; ctype: string; raw: string; body: Record<string, unknown> }[] = [];
const srv = createServer(async (req, res) => {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	const raw = Buffer.concat(chunks).toString("latin1");
	const ctype = String(req.headers["content-type"] ?? "");
	const body = ctype.includes("json") && raw ? JSON.parse(Buffer.from(raw, "latin1").toString()) : {};
	const url = req.url ?? "";
	calls.push({ path: url, ctype, raw, body });
	res.setHeader("content-type", "application/json");
	if (url.startsWith("/cgi-bin/gettoken")) return res.end(JSON.stringify({ errcode: 0, access_token: "TOKEN", expires_in: 7200 }));
	if (url.startsWith("/cgi-bin/media/upload") || url.startsWith("/media/upload")) return res.end(JSON.stringify({ errcode: 0, media_id: "MEDIA1" }));
	if (url.startsWith("/v1.0/oauth2/accessToken")) return res.end(JSON.stringify({ accessToken: "DTOKEN", expireIn: 7200 }));
	if (url.includes("tenant_access_token")) return res.end(JSON.stringify({ code: 0, tenant_access_token: "FTOKEN", expire: 7200 }));
	if (url.startsWith("/open-apis/im/v1/images")) return res.end(JSON.stringify({ code: 0, data: { image_key: "img_1" } }));
	if (url.startsWith("/open-apis/im/v1/files")) return res.end(JSON.stringify({ code: 0, data: { file_key: "file_1" } }));
	if (url.startsWith("/open-apis/im/v1/messages")) return res.end(JSON.stringify({ code: 0, data: { message_id: "om_1" } }));
	res.end(JSON.stringify({ errcode: 0 }));
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
const dir = mkdtempSync(join(tmpdir(), "pia-media-"));
const png = join(dir, "a.png");
writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100, 1)]));
const pdf = join(dir, "r.pdf");
writeFileSync(pdf, "%PDF-1.4 x");
test.after(() => srv.close());

test("思考内容：完整标签 / 只剩结束标签 / 流式未闭合 / 正常文本不动", () => {
	assert.deepEqual(splitThinking("<think>想一想</think>\n答案是 42"), { text: "答案是 42", thinking: "想一想" });
	assert.equal(stripThinking("<thinking>a\nb</thinking>你好"), "你好");
	const r = splitThinking("当前模型不支持图片。我先 sips 看尺寸。</thinking>\n点击超时了，我换个办法。");
	assert.equal(r.text, "点击超时了，我换个办法。");
	assert.match(r.thinking, /sips/);
	assert.equal(stripThinking("好的。<thinking>还在想"), "好的。");
	assert.equal(stripThinking("普通回答，没有标签"), "普通回答，没有标签");
	assert.equal(stripThinking("<reasoning>r</reasoning>ok"), "ok");
});

test("Markdown → 纯文本（微信）", () => {
	const t = markdownToPlain("## 标题\n**粗体** 和 *斜体*、`code`\n- 一\n- 二\n[官网](https://a.com)\n| a | b |\n|---|---|\n| 1 | 2 |\n```js\nx=1\n```");
	assert.doesNotMatch(t, /[#*`|]|```/);
	assert.match(t, /标题/);
	assert.match(t, /• 一/);
	assert.match(t, /官网 https:\/\/a\.com/);
	assert.match(t, /1 {2}2/);
	assert.match(t, /x=1/);
	assert.equal(channelText("wechat_clawbot", "我想想</thinking>**好**"), "好");
	assert.equal(channelText("feishu", "<think>x</think>**好**"), "**好**", "飞书保留 Markdown，只去思考");
});

test("渠道能力说明：告诉助理在哪个渠道、能不能发图 / 文件、格式", () => {
	const s = channelContext("wechat_clawbot");
	assert.match(s, /微信/);
	assert.match(s, /纯文本/);
	assert.match(s, /图片/);
	assert.match(s, /deliver_file/);
	assert.match(channelContext("feishu", { group: true }), /飞书.*群聊/);
});

test("图片按渠道能力：合适就原生图片；格式不支持转 JPEG；GIF 不支持改发文件；转换失败退回文件；非图片发文件；超限 none", async () => {
	assert.equal((await media.prepareMedia(png, "a.png", CAPS.wecom)).as, "image");
	assert.equal((await media.prepareMedia(pdf, "r.pdf", CAPS.wecom)).as, "file");
	media.setJpegConverter(async (_src, out) => (copyFileSync(png, out), true));
	const webp = join(dir, "b.webp");
	writeFileSync(webp, "RIFFxxxxWEBP");
	const p = await media.prepareMedia(webp, "b.webp", CAPS.wecom);
	assert.equal(p.as, "image");
	assert.equal(p.name, "b.jpg");
	p.cleanup();
	const gif = join(dir, "c.gif");
	writeFileSync(gif, "GIF89a");
	const g = await media.prepareMedia(gif, "c.gif", CAPS.wecom);
	assert.equal(g.as, "file");
	assert.match(g.note ?? "", /动图/);
	media.setJpegConverter(async () => false);
	assert.equal((await media.prepareMedia(webp, "b.webp", CAPS.wecom)).as, "file", "转换失败 → 发文件");
	assert.equal((await media.prepareMedia(pdf, "r.pdf", { ...CAPS.wecom, file: { maxBytes: 3 } })).as, "none", "超限 → 退回链接 / 提示");
});

test("签名下载链接：正确签名可用；改 ID / 过期 / 乱签名都拒绝", () => {
	const p = media.signedPath("f_1");
	const [, , , id, exp, sig] = p.split("/");
	assert.equal(media.verifySigned(decodeURIComponent(id), exp, sig), true);
	assert.equal(media.verifySigned("f_2", exp, sig), false);
	assert.equal(media.verifySigned("f_1", exp, "x".repeat(sig.length)), false);
	assert.equal(media.verifySigned("f_1", exp, sig, Date.now() + 8 * 86400_000), false);
});

test("企业微信自建应用：图片 = media/upload?type=image + msgtype image；文件同理；说明文字先发", async () => {
	const a = wecomAdapter({ config: { corpId: "c", agentId: "1000002", apiBase: BASE }, secret: { secret: "s", token: "t", aesKey: "k".repeat(43) }, onMessage() {}, setStatus() {} });
	calls.length = 0;
	await a.sendFile!({ userId: "u1" }, png, "a.png", { kind: "image", caption: "看图" });
	const up = calls.find((c) => c.path.startsWith("/cgi-bin/media/upload"))!;
	assert.match(up.path, /type=image/);
	assert.match(up.ctype, /multipart\/form-data/);
	assert.match(up.raw, /filename="a.png"/);
	const sends = calls.filter((c) => c.path.startsWith("/cgi-bin/message/send"));
	assert.equal(sends[0].body.msgtype, "markdown");
	assert.deepEqual(sends[1].body.image, { media_id: "MEDIA1" });
	calls.length = 0;
	await a.sendFile!({ userId: "u1" }, pdf, "r.pdf", { kind: "file" });
	assert.match(calls.find((c) => c.path.startsWith("/cgi-bin/media/upload"))!.path, /type=file/);
	assert.equal(calls.find((c) => c.path.startsWith("/cgi-bin/message/send"))!.body.msgtype, "file");
});

test("钉钉：上传 media → 单聊 sampleImageMsg / sampleFile；群聊走 groupMessages", async () => {
	const a = dingtalkAdapter({ config: { clientId: "ding1", apiBase: BASE }, secret: { clientSecret: "s" }, onMessage() {}, setStatus() {} });
	calls.length = 0;
	await a.sendFile!({ staffId: "st1", robotCode: "ding1" }, png, "a.png", { kind: "image" });
	assert.match(calls.find((c) => c.path.startsWith("/media/upload"))!.path, /type=image/);
	const b = calls.find((c) => c.path.startsWith("/v1.0/robot/oToMessages/batchSend"))!.body;
	assert.equal(b.msgKey, "sampleImageMsg");
	assert.deepEqual(JSON.parse(String(b.msgParam)), { photoURL: "MEDIA1" });
	calls.length = 0;
	await a.sendFile!({ group: true, conversationId: "cid1" }, pdf, "r.pdf", { kind: "file" });
	const g = calls.find((c) => c.path.startsWith("/v1.0/robot/groupMessages/send"))!.body;
	assert.equal(g.msgKey, "sampleFile");
	assert.equal(g.openConversationId, "cid1");
	assert.deepEqual(JSON.parse(String(g.msgParam)), { mediaId: "MEDIA1", fileName: "r.pdf", fileType: "pdf" });
});

test("飞书：上传图片拿 image_key → msg_type image；文件拿 file_key → msg_type file", async () => {
	const a = feishuAdapter({ config: { appId: "cli_x", domain: BASE }, secret: { appSecret: "sec" }, onMessage() {}, setStatus() {} });
	calls.length = 0;
	await a.sendFile!({ chatId: "oc_1" }, png, "a.png", { kind: "image" });
	assert.ok(calls.some((c) => c.path.startsWith("/open-apis/im/v1/images") && /multipart/.test(c.ctype)));
	const m = calls.find((c) => c.path.startsWith("/open-apis/im/v1/messages"))!.body;
	assert.equal(m.msg_type, "image");
	assert.deepEqual(JSON.parse(String(m.content)), { image_key: "img_1" });
	calls.length = 0;
	await a.sendFile!({ chatId: "oc_1" }, pdf, "r.pdf", { kind: "file" });
	assert.ok(calls.some((c) => c.path.startsWith("/open-apis/im/v1/files") && c.raw.includes("pdf")));
	const f = calls.find((c) => c.path.startsWith("/open-apis/im/v1/messages"))!.body;
	assert.equal(f.msg_type, "file");
	assert.deepEqual(JSON.parse(String(f.content)), { file_key: "file_1" });
});
