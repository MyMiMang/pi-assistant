/**
 * 消息引用（reply / quote）后端测试：路由优先级、快照、编辑 / 删除 scrub、跨容器拒绝、provider payload。
 * 见 docs/design/message-replies.md §10。
 * 强制临时数据目录（setup.ts）；凭据用内存 store，不碰钥匙串。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { config } from "../src/config.ts";
import { createConversation } from "../src/conversations.ts";
import { db, now } from "../src/db.ts";
import { deleteMessage, getMessage, insertMessage, updateMessage } from "../src/messages.ts";
import { buildReplySnapshot, composeQuotedInput, formatQuotedContext, resolveReplyTarget, ReplyError } from "../src/replies.ts";
import { planForUserWithQuote } from "../src/rooms/logic.ts";
import { createPiSession, promptSession, PiModels } from "../src/pi-adapter/index.ts";
import { MOCK_MODEL, MOCK_PROVIDER, mockStats, registerMockProvider, resetMockStats } from "../src/pi-adapter/mock-provider.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

// ---------------------------------------------------------------- 纯路由逻辑

const ACTIVE = ["a", "b", "c"];
const quoteA = { quotable: true, role: "assistant" as const, authorAgentId: "b", authorActive: true };

test("路由：显式 @ 优先于引用（引用 A 但 @B ⇒ 只叫 B）", () => {
	const r = planForUserWithQuote({ mentioned: ["a"], managerId: "a", activeIds: ACTIVE, quote: { ...quoteA, authorAgentId: "b" } });
	assert.deepEqual(r.turns.map((t) => [t.agentId, t.reason, t.directed]), [["a", "mention", true]]);
});

test("路由：无 @ 引用群内助理 ⇒ 只叫作者，不叫管理者", () => {
	const r = planForUserWithQuote({ mentioned: [], managerId: "a", activeIds: ACTIVE, quote: quoteA });
	assert.deepEqual(r.turns.map((t) => [t.agentId, t.reason, t.directed]), [["b", "mention", true]]);
	assert.equal(r.notice, undefined);
});

test("路由：引用管理者自己的消息 ⇒ 只叫管理者（定向）", () => {
	const r = planForUserWithQuote({ mentioned: [], managerId: "a", activeIds: ACTIVE, quote: { ...quoteA, authorAgentId: "a" } });
	assert.deepEqual(r.turns.map((t) => [t.agentId, t.reason, t.directed]), [["a", "mention", true]]);
});

test("路由：引用已删除 / 停用成员 ⇒ 不误唤管理者，给明确提示", () => {
	const r = planForUserWithQuote({ mentioned: [], managerId: "a", activeIds: ACTIVE, quote: { ...quoteA, authorActive: false } });
	assert.deepEqual(r.turns, []);
	assert.match(r.notice ?? "", /删除或停用/);
});

test("路由：无 @ 引用用户 / 不可路由消息 ⇒ 走既有管理者", () => {
	const user = planForUserWithQuote({ mentioned: [], managerId: "a", activeIds: ACTIVE, quote: { quotable: true, role: "user", authorAgentId: null, authorActive: false } });
	assert.deepEqual(user.turns.map((t) => [t.agentId, t.reason]), [["a", "manager"]]);
	assert.equal(user.directed, false);
	const sys = planForUserWithQuote({ mentioned: [], managerId: "a", activeIds: ACTIVE, quote: { quotable: false, role: "system", authorAgentId: null, authorActive: false } });
	assert.deepEqual(sys.turns.map((t) => t.agentId), ["a"]);
});

test("路由：@所有人 是用户显式选择 ⇒ 全部成员", () => {
	const r = planForUserWithQuote({ mentioned: ACTIVE, managerId: "a", activeIds: ACTIVE, quote: quoteA });
	assert.deepEqual(r.turns.map((t) => t.agentId), ACTIVE);
});

// ---------------------------------------------------------------- 数据库：建基础数据

const mkAgent = (id: string, name: string) => db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run(id, name, "A", "#000", now());
mkAgent("rqa", "甲");
mkAgent("rqb", "乙");
mkAgent("rqc", "丙");
const rooms = await import("../src/rooms/index.ts");
const room = rooms.createRoom({ name: "引用测试群", memberIds: ["rqa", "rqb", "rqc"], managerId: "rqa" });
const roomMsg = (agentId: string, content: string, role: "assistant" | "user" = "assistant") => insertMessage({ agentId, roomId: room.id, conversationId: null, role, content });
const roomScope = { kind: "room" as const, id: room.id };

test("快照：从可信消息行生成、作者、截断、附件只带元数据", () => {
	const m = insertMessage({ agentId: "rqb", roomId: room.id, conversationId: null, role: "assistant", content: "x".repeat(2500), meta: { attachments: [{ fileId: "f1", name: "报告.pdf", mime: "application/pdf", size: 12, data: "SHOULD_NOT_LEAK" }] } });
	const snap = buildReplySnapshot(resolveReplyTarget({ scope: roomScope, messageId: m.id }), roomScope);
	assert.equal(snap.author.id, "rqb");
	assert.equal(snap.author.name, "乙");
	assert.equal(snap.author.role, "assistant");
	assert.equal(snap.excerpt.length, 2000);
	assert.equal(snap.truncated, true);
	assert.deepEqual(snap.attachments, [{ fileId: "f1", name: "报告.pdf", mime: "application/pdf", size: 12 }]);
	assert.ok(!JSON.stringify(snap).includes("SHOULD_NOT_LEAK"), "附件里的 data / 二进制不进快照");
});

test("引用解析：跨群 / 跨对话 fail closed，system 不可引用", () => {
	const conv = createConversation("rqa", "单聊", { makeCurrent: false });
	const convMsg = insertMessage({ agentId: "rqa", conversationId: conv.id, role: "assistant", content: "单聊内容" });
	assert.throws(() => resolveReplyTarget({ scope: roomScope, messageId: convMsg.id }), (e) => e instanceof ReplyError && e.code === "reply_cross_scope" && e.status === 403);
	const roomReply = roomMsg("rqb", "群内内容");
	assert.throws(() => resolveReplyTarget({ scope: { kind: "conversation", id: conv.id }, messageId: roomReply.id }), (e) => e instanceof ReplyError && e.code === "reply_cross_scope");
	const sysMsg = insertMessage({ agentId: "", roomId: room.id, conversationId: null, role: "system", content: "系统" });
	assert.throws(() => resolveReplyTarget({ scope: roomScope, messageId: sysMsg.id }), (e) => e instanceof ReplyError && e.code === "reply_not_quotable" && e.status === 403);
	assert.throws(() => resolveReplyTarget({ scope: roomScope, messageId: "m_nope" }), (e) => e instanceof ReplyError && e.code === "reply_not_found" && e.status === 404);
});

test("快照：原消息被编辑 ⇒ 保留原摘录 + edited 标记", () => {
	const target = insertMessage({ agentId: "", roomId: room.id, conversationId: null, role: "user", content: "原文" });
	const holder = insertMessage({ agentId: "rqb", roomId: room.id, conversationId: null, role: "assistant", content: "回应", replyToId: target.id, replySnapshot: buildReplySnapshot(target, roomScope) });
	updateMessage(target.id, { content: "改过的" });
	const reloaded = getMessage(holder.id)!;
	assert.equal(reloaded.reply!.edited, true);
	assert.equal(reloaded.reply!.excerpt, "原文", "快照保留原版本");
});

test("快照：原消息被删除 ⇒ scrub 为不可用，不泄露正文", () => {
	const target = insertMessage({ agentId: "", roomId: room.id, conversationId: null, role: "user", content: "即将删除的敏感内容" });
	const holder = insertMessage({ agentId: "rqb", roomId: room.id, conversationId: null, role: "assistant", content: "回应", replyToId: target.id, replySnapshot: buildReplySnapshot(target, roomScope) });
	deleteMessage(target.id);
	const reloaded = getMessage(holder.id)!;
	assert.equal(reloaded.reply!.unavailable, true);
	assert.equal(reloaded.reply!.excerpt, "");
	assert.equal(reloaded.reply!.attachments, undefined);
	assert.ok(!JSON.stringify(reloaded.reply).includes("敏感内容"));
});

test("发群消息带引用：跨群拒绝且不落库", () => {
	const conv = createConversation("rqa", "另一个单聊", { makeCurrent: false });
	const otherMsg = insertMessage({ agentId: "rqa", conversationId: conv.id, role: "assistant", content: "别的对话" });
	const before = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE room_id = ?").get(room.id) as { n: number }).n;
	assert.throws(() => rooms.postUserMessage(room.id, "引用跨群", { replyToId: otherMsg.id }), (e) => e instanceof ReplyError && e.code === "reply_cross_scope");
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE room_id = ?").get(room.id) as { n: number }).n, before, "校验失败不落库");
});

test("发群消息引用已删除成员：群内明确提示，不唤醒任何人", () => {
	const target = roomMsg("rqb", "我马上要退群");
	db.prepare("UPDATE room_members SET left_at = ?, deleted = 1 WHERE room_id = ? AND agent_id = 'rqb'").run(now(), room.id);
	const msg = rooms.postUserMessage(room.id, "引用已删除的乙", { replyToId: target.id });
	assert.equal(getMessage(msg.id)!.replyToId, target.id);
	assert.ok((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE room_id = ? AND meta LIKE '%reply-unroutable%'").get(room.id) as { n: number }).n >= 1, "有明确提示");
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM room_turns WHERE room_id = ?").get(room.id) as { n: number }).n, 0, "不误唤管理者 / 任何人");
	db.prepare("UPDATE room_members SET left_at = NULL, deleted = 0 WHERE room_id = ? AND agent_id = 'rqb'").run(room.id);
});

test("幂等：同 clientId 重复投递只落一条", () => {
	const a = rooms.postUserMessage(room.id, "幂等测试", { clientId: "cid-1", mentions: ["rqc"] });
	const b = rooms.postUserMessage(room.id, "幂等测试", { clientId: "cid-1", mentions: ["rqc"] });
	assert.equal(a.id, b.id);
	rooms.stop(room.id, false);
});

test("助理引用助理不自动唤醒（无机器循环）；旧消息无引用回读为 null", () => {
	const target = roomMsg("rqc", "丙说过的");
	const before = (db.prepare("SELECT COUNT(*) AS n FROM room_turns WHERE room_id = ?").get(room.id) as { n: number }).n;
	// 助理消息直接 insertMessage（不经 postUserMessage），引用另一条助理消息
	const a1 = insertMessage({ agentId: "rqb", roomId: room.id, conversationId: null, role: "assistant", content: "乙回应", replyToId: target.id, replySnapshot: buildReplySnapshot(target, roomScope) });
	assert.equal(getMessage(a1.id)!.reply!.excerpt, "丙说过的");
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM room_turns WHERE room_id = ?").get(room.id) as { n: number }).n, before, "助理引用不新增回合");
	// 旧消息（未带引用）回读为 null，向后兼容
	const plain = roomMsg("rqc", "普通消息");
	assert.equal(getMessage(plain.id)!.reply, null);
	assert.equal(getMessage(plain.id)!.replyToId, null);
});

// ---------------------------------------------------------------- provider payload（真实 Pi 会话 + mock provider）

test("provider payload：引用块 + 用户正文都进模型输入", async () => {
	const models = await PiModels.create({ credentials: memoryCredentialStore(), modelsPath: null, allowNetwork: false });
	await registerMockProvider(models);
	const agentId = "rq-payload";
	const ws = join(config.workspaceRoot, "rq-payload");
	mkdirSync(ws, { recursive: true });
	const session = await createPiSession({
		models,
		cwd: ws,
		agentDir: join(config.agentsDir, agentId),
		sessionDir: join(config.agentsDir, agentId, "sessions"),
		model: { provider: MOCK_PROVIDER, id: MOCK_MODEL },
		systemPromptAppend: ["你是测试助理。"],
		extensions: [],
	});
	const target = insertMessage({ agentId: "", roomId: room.id, conversationId: null, role: "user", content: "被引用的原始问题" });
	const snap = buildReplySnapshot(target, roomScope);
	resetMockStats();
	await promptSession(session, composeQuotedInput("用户的新正文XYZ", formatQuotedContext(snap)));
	assert.ok(mockStats.steps >= 1, "模型被调用");
	assert.ok(mockStats.lastUserText.includes("被引用的历史内容"), "payload 含引用块");
	assert.ok(mockStats.lastUserText.includes("被引用的原始问题"), "payload 含引用摘录");
	assert.ok(mockStats.lastUserText.includes("用户的新正文XYZ"), "payload 含用户新正文");
	session.dispose();
});
