/**
 * 聊天渠道（模拟平台）：企业微信加解密与回调全流程（验签、解密、去重、绑定码、未绑定不受理）、
 * 回复发回平台（模拟 qyapi）、审批卡片发到渠道并用“批准 / 都允许”回复处理、
 * 飞书 / 钉钉事件解析与回复（模拟 OpenAPI / sessionWebhook / 过期后改用机器人单聊接口）。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
const { db, now } = await import("../src/db.ts");
db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run("ca", "小助", "A", "#000", now());
const { wecomDecrypt, wecomEncrypt, wecomSignature, xmlValue } = await import("../src/channels/wecom-crypto.ts");
const ch = await import("../src/channels/index.ts");
const { feishuInbound, feishuAdapter } = await import("../src/channels/feishu.ts");
const { dingtalkInbound, dingtalkAdapter } = await import("../src/channels/dingtalk.ts");
const { insertMessage } = await import("../src/messages.ts");
const { requests } = await import("../src/requests.ts");

// 模拟平台 OpenAPI：记录所有请求
const calls: { path: string; body: Record<string, unknown> }[] = [];
const srv = createServer(async (req, res) => {
	let b = "";
	for await (const c of req) b += c;
	const body = b ? JSON.parse(b) : {};
	calls.push({ path: req.url ?? "", body });
	res.setHeader("content-type", "application/json");
	if (req.url?.startsWith("/cgi-bin/gettoken")) return res.end(JSON.stringify({ errcode: 0, access_token: "TOKEN", expires_in: 7200 }));
	if (req.url?.startsWith("/v1.0/oauth2/accessToken")) return res.end(JSON.stringify({ accessToken: "DTOKEN", expireIn: 7200 }));
	if (req.url?.includes("tenant_access_token")) return res.end(JSON.stringify({ code: 0, tenant_access_token: "FTOKEN", expire: 7200 }));
	if (req.url?.startsWith("/open-apis/im/v1/messages")) return res.end(JSON.stringify({ code: 0, data: { message_id: "om_1" } }));
	res.end(JSON.stringify({ errcode: 0 }));
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
const wait = async (pred: () => boolean, ms = 3000) => {
	for (let t = Date.now(); Date.now() - t < ms; ) {
		if (pred()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("等待超时");
};

const AES = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"; // 43 位
const CORP = "ww123";
test("企业微信加解密：与官方算法互通（往返 + 验签）", () => {
	const enc = wecomEncrypt(AES, "<xml>你好</xml>", CORP);
	assert.deepEqual(wecomDecrypt(AES, enc), { message: "<xml>你好</xml>", receiveId: CORP });
	assert.equal(wecomSignature("tok", "1", "n", "e").length, 40);
	assert.equal(xmlValue("<xml><A><![CDATA[x<y]]></A><B>2</B></xml>", "A"), "x<y");
	assert.equal(xmlValue("<xml><B>2</B></xml>", "B"), "2");
});

test("企业微信：回调验签 → 未绑定提示 → 绑定码 → 消息进助理对话 → 回复与审批发回企业微信", async () => {
	const c = ch.saveChannel({ kind: "wecom", agentId: "ca", config: { corpId: CORP, agentId: "1000002", apiBase: BASE }, secret: { secret: "S", token: "tok", aesKey: AES } });
	await wait(() => ch.channelJson(ch.getChannel(c.id)!).status.state === "waiting");
	const sign = (enc: string) => {
		const q = { timestamp: "1700000000", nonce: "n1", msg_signature: wecomSignature("tok", "1700000000", "n1", enc) };
		return q;
	};
	// URL 验证
	const echo = wecomEncrypt(AES, "echo-123", CORP);
	assert.deepEqual(ch.wecomCallback(c.id, "GET", { ...sign(echo), echostr: echo }, ""), { status: 200, body: "echo-123" });
	assert.equal(ch.wecomCallback(c.id, "GET", { ...sign(echo), echostr: echo, msg_signature: "bad" }, "").status, 403, "签名不对拒绝");
	const post = (user: string, content: string, id: string) => {
		const xml = `<xml><ToUserName><![CDATA[${CORP}]]></ToUserName><FromUserName><![CDATA[${user}]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content><MsgId>${id}</MsgId><AgentID>1000002</AgentID></xml>`;
		const enc = wecomEncrypt(AES, xml, CORP);
		return ch.wecomCallback(c.id, "POST", sign(enc), `<xml><ToUserName><![CDATA[${CORP}]]></ToUserName><Encrypt><![CDATA[${enc}]]></Encrypt><AgentID><![CDATA[1000002]]></AgentID></xml>`);
	};
	const sends = () => calls.filter((x) => x.path.startsWith("/cgi-bin/message/send"));
	// 未绑定：只提示绑定，不进助理
	assert.equal(post("zhangsan", "帮我查天气", "m1").body, "success");
	await wait(() => sends().length === 1);
	assert.match(String((sends()[0].body.markdown as { content: string }).content), /绑定/);
	assert.equal(sends()[0].body.touser, "zhangsan");
	assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE agent_id = 'ca' AND role = 'user'").get()!.n, 0);
	// 绑定码错误无效；正确则绑定并换新码
	post("zhangsan", "绑定 000000", "m2");
	const code = ch.getChannel(c.id)!.bind_code!;
	post("zhangsan", `绑定 ${code}`, "m3");
	await wait(() => sends().some((s) => /绑定成功/.test(String((s.body.markdown as { content: string }).content))));
	assert.notEqual(ch.getChannel(c.id)!.bind_code, code, "绑定码用一次就换");
	// 重推去重
	post("zhangsan", "今天有什么安排", "m4");
	post("zhangsan", "今天有什么安排", "m4");
	await wait(() => (db.prepare("SELECT COUNT(*) n FROM messages WHERE agent_id = 'ca' AND role = 'user'").get()!.n as number) >= 1);
	await new Promise((r) => setTimeout(r, 200));
	const userMsgs = db.prepare("SELECT conversation_id, content, meta FROM messages WHERE agent_id = 'ca' AND role = 'user'").all() as { conversation_id: string; content: string; meta: string }[];
	assert.equal(userMsgs.length, 1, "同一 MsgId 只处理一次");
	assert.equal(userMsgs[0].content, "今天有什么安排");
	assert.match(userMsgs[0].meta, /wecom/);
	const conv = userMsgs[0].conversation_id;
	assert.ok(conv);
	// 助理在这个对话里的回复 → 发回企业微信
	const before = sends().length;
	insertMessage({ agentId: "ca", conversationId: conv, role: "assistant", content: "今天下午 3 点有个会。" });
	await wait(() => sends().length === before + 1);
	assert.match(String((sends().at(-1)!.body.markdown as { content: string }).content), /下午 3 点/);
	// 审批卡片 → 发到企业微信；回复「都允许」= 批准且本任务内都允许
	const p = requests.approval("ca", null, "browser:提交表单", { url: "x" }, "在网页「报名」点击「提交」", "high", conv, { allowTask: true });
	await wait(() => sends().some((s) => /需要你批准/.test(String((s.body.markdown as { content: string }).content))));
	assert.match(String((sends().at(-1)!.body.markdown as { content: string }).content), /都允许/);
	post("zhangsan", "都允许", "m5");
	assert.deepEqual(await p, { approved: true, scope: "task" });
	// 提问卡片：回复序号
	const q = requests.question("ca", null, "选哪个城市？", ["北京", "上海"], false, conv);
	await wait(() => sends().some((s) => /选哪个城市/.test(String((s.body.markdown as { content: string }).content))));
	post("zhangsan", "2", "m6");
	assert.equal((await q).answer, "上海");
	// 新对话
	post("zhangsan", "新对话", "m7");
	await wait(() => ch.channelJson(ch.getChannel(c.id)!).users.length === 1);
	await new Promise((r) => setTimeout(r, 100));
	const p2 = db.prepare("SELECT conversation_id FROM channel_peers WHERE channel_id = ? AND peer_id = 'zhangsan'").get(c.id) as { conversation_id: string };
	assert.notEqual(p2.conversation_id, conv);
	// 渠道对话不切换 App 里的当前对话
	const cur = db.prepare("SELECT conversation_id FROM agents WHERE id = 'ca'").get() as { conversation_id: string | null };
	assert.notEqual(cur.conversation_id, p2.conversation_id);
	// 公开信息不含密钥
	const j = JSON.stringify(ch.channelJson(ch.getChannel(c.id)!));
	assert.ok(!j.includes(AES) && !j.includes('"S"'));
	await ch.deleteChannel(c.id);
});

test("飞书：事件解析（单聊 / 群聊去掉 @）与 Markdown 卡片回复（模拟 OpenAPI）", async () => {
	const p2p = feishuInbound({ sender: { sender_id: { open_id: "ou_1" }, sender_type: "user" }, message: { message_id: "om", chat_id: "oc_1", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "你好" }) } });
	assert.deepEqual([p2p?.userId, p2p?.peerId, p2p?.text, p2p?.ctx.chatId], ["ou_1", "ou_1", "你好", "oc_1"]);
	const grp = feishuInbound({ sender: { sender_id: { open_id: "ou_2" }, sender_type: "user" }, message: { message_id: "om2", chat_id: "oc_g", chat_type: "group", message_type: "text", content: JSON.stringify({ text: "@_user_1 总结一下" }), mentions: [{ key: "@_user_1", name: "助理" }] } });
	assert.deepEqual([grp?.peerId, grp?.text, grp?.group], ["chat:oc_g", "总结一下", true]);
	assert.equal(feishuInbound({ sender: { sender_type: "app" }, message: { message_id: "x", chat_id: "c", chat_type: "p2p", message_type: "text", content: '{"text":"hi"}' } }), null, "忽略机器人自己的消息");
	const a = feishuAdapter({ config: { appId: "cli_x", domain: BASE }, secret: { appSecret: "sec" }, onMessage() {}, setStatus() {} });
	assert.match(await a.test(), /有效/);
	await a.send({ chatId: "oc_1" }, "**你好**");
	const sent = calls.filter((x) => x.path.startsWith("/open-apis/im/v1/messages")).at(-1)!;
	assert.match(sent.path, /receive_id_type=chat_id/);
	assert.equal(sent.body.msg_type, "interactive");
	assert.match(String(sent.body.content), /\*\*你好\*\*/);
});

test("钉钉：Stream 消息解析，回复走 sessionWebhook；过期后改用机器人单聊接口", async () => {
	const m = dingtalkInbound(JSON.stringify({ conversationId: "cid", conversationType: "1", senderStaffId: "staff1", senderId: "s1", senderNick: "张三", msgId: "msg1", msgtype: "text", text: { content: " 帮我写周报 " }, sessionWebhook: `${BASE}/robot/sendBySession?session=x`, sessionWebhookExpiredTime: Date.now() + 3600_000, robotCode: "ding123" }));
	assert.deepEqual([m?.userId, m?.peerId, m?.text, m?.display], ["staff1", "staff1", "帮我写周报", "张三"]);
	const a = dingtalkAdapter({ config: { clientId: "ding123", apiBase: BASE }, secret: { clientSecret: "s" }, onMessage() {}, setStatus() {} });
	await a.send(m!.ctx, "## 周报\n内容");
	const viaSession = calls.at(-1)!;
	assert.match(viaSession.path, /sendBySession/);
	assert.equal(viaSession.body.msgtype, "markdown");
	await a.send({ ...m!.ctx, expires: Date.now() - 1 }, "稍后的通知");
	const viaApi = calls.at(-1)!;
	assert.equal(viaApi.path, "/v1.0/robot/oToMessages/batchSend");
	assert.deepEqual(viaApi.body.userIds, ["staff1"]);
	assert.equal(viaApi.body.msgKey, "sampleMarkdown");
	assert.match(await a.test(), /有效/);
});

test.after(async () => {
	await ch.stopChannels();
	srv.close();
});
