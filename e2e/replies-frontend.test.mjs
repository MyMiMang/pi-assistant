/**
 * 消息引用回复的纯逻辑夹具测试（node:test，不启动服务、不碰 DOM / 真实数据）。
 * 运行：node --import tsx --test e2e/replies-frontend.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	agentSendBody,
	attachmentLabel,
	buildReplyRef,
	copyTextOf,
	excerptOf,
	isQuotable,
	liveMentions,
	quotedBlock,
	replyAttachments,
	replyDraftKey,
	resolveAgentReplyTarget,
	resolveRoomReplyTarget,
	roomSendBody,
	sanitizeExcerpt,
	subagentSendBody,
	draftSignature,
	newClientId,
} from "../apps/web/src/replies.ts";

const msg = (over = {}) => ({ id: "m1", agent_id: "a1", role: "assistant", content: "你好", meta: {}, status: "done", created_at: 1, updated_at: 1, ...over });

test("候选过滤：只有用户 / 助理普通消息可引用，工具 / 系统 / 卡片排除", () => {
	assert.equal(isQuotable(msg({ role: "user" })), true);
	assert.equal(isQuotable(msg({ role: "assistant" })), true);
	assert.equal(isQuotable(msg({ role: "tool" })), false);
	assert.equal(isQuotable(msg({ role: "system" })), false);
	assert.equal(isQuotable(msg({ role: "card" })), false);
	// 隐藏 system / 工具结果不当候选
	assert.equal(isQuotable(msg({ role: "assistant", meta: { hidden: true } })), false);
	assert.equal(isQuotable(msg({ role: "assistant", meta: { visible: false } })), false);
});

test("摘录 sanitize：思考块 / 标签去掉、压缩空白、危险内容只当纯文本", () => {
	assert.equal(sanitizeExcerpt("<think>secret</think> 正式回答"), "正式回答");
	assert.equal(sanitizeExcerpt("<script>alert(1)</script>"), "alert(1)");
	assert.equal(sanitizeExcerpt('<svg onload="evil()"></svg> x'), "x");
	assert.equal(sanitizeExcerpt("a\n\n  b\tc"), "a b c");
	// 不含可执行标签 / 尖括号
	const s = sanitizeExcerpt("<img src=x onerror=alert(1)>看图");
	assert.ok(!s.includes("<") && !s.includes(">") && s.includes("看图"));
	// markdown 图片不会变成可加载资源，只留文字
	assert.equal(sanitizeExcerpt("![remote](https://example.com/x.png)"), "![remote](https://example.com/x.png)");
});

test("摘录超长截断；附件只留摘要（无 fileId / url）", () => {
	const long = "字".repeat(500);
	assert.ok(excerptOf(long).length <= 241 && excerptOf(long).endsWith("…"));
	const atts = replyAttachments([{ fileId: "f1", name: "报告.pdf", mime: "application/pdf", size: 123, workspacePath: "/secret/path" }]);
	assert.deepEqual(atts, [{ name: "报告.pdf", mime: "application/pdf", size: 123 }]);
	assert.equal(JSON.stringify(atts).includes("f1"), false);
	assert.equal(attachmentLabel({ name: "a.png", mime: "image/png", size: 1 }), "图片：a.png");
});

test("buildReplyRef：从消息构造安全的 draft 引用", () => {
	const ref = buildReplyRef(msg({ id: "m9", role: "user", content: "帮我看看报告", meta: { attachments: [{ fileId: "f1", name: "报告.pdf", mime: "application/pdf", size: 10 }] } }), { id: "user", name: "我" });
	assert.equal(ref.messageId, "m9");
	assert.equal(ref.authorRole, "user");
	assert.equal(ref.authorName, "我");
	assert.equal(ref.excerpt, "帮我看看报告");
	assert.equal(ref.hasText, true);
	assert.deepEqual(ref.attachments, [{ name: "报告.pdf", mime: "application/pdf", size: 10 }]);
});

test("quotedBlock：读取服务端 ReplySnapshot（Message.reply）", () => {
	const a = quotedBlock(msg({ reply: { messageId: "m1", author: { id: "a1", name: "测试助理", role: "assistant" }, source: { kind: "conversation", id: "c1" }, excerpt: "原话", truncated: false, edited: true, attachments: [{ fileId: "f1", name: "x.png", mime: "image/png", size: 2 }], createdAt: 1 } }));
	assert.deepEqual(a, { messageId: "m1", authorName: "测试助理", excerpt: "原话", attachments: [{ name: "x.png", mime: "image/png", size: 2 }], unavailable: false, edited: true, truncated: false });
	const gone = quotedBlock(msg({ reply: { messageId: "m2", author: { id: "a1", name: "甲", role: "assistant" }, source: { kind: "conversation", id: "c1" }, excerpt: "", truncated: false, edited: false, createdAt: 1, unavailable: true } }));
	assert.equal(gone?.unavailable, true);
	assert.equal(gone?.excerpt, "");
	assert.equal(quotedBlock(msg({ meta: {} })), null);
});

test("群规则：explicit @ 优先；无 @ 引用助理只该助理；引用用户不误导；作者缺失需 @", () => {
	const members = [
		{ agentId: "mgr", name: "管家" },
		{ agentId: "a1", name: "甲" },
		{ agentId: "a2", name: "乙" },
	];
	const refA = buildReplyRef(msg({ id: "x", agent_id: "a1" }), { id: "a1", name: "甲" });
	// 无 @，引用活跃助理 A → 只 A
	let t = resolveRoomReplyTarget({ ref: refA, mentions: [], members, managerId: "mgr" });
	assert.equal(t.quoteLabel, "回复给 甲");
	assert.equal(t.replyToId, "x");
	assert.equal(t.mentionLabel, null);
	assert.equal(t.unavailable, false);
	// quote A + @B → @ 优先（两个标签并存，B 回复）
	t = resolveRoomReplyTarget({ ref: refA, mentions: [{ agentId: "a2", name: "乙" }], members, managerId: "mgr" });
	assert.equal(t.quoteLabel, "回复给 甲");
	assert.equal(t.mentionLabel, "@乙 将回复");
	// 引用管理者 → 管理者
	const refMgr = buildReplyRef(msg({ id: "y", agent_id: "mgr" }), { id: "mgr", name: "管家" });
	t = resolveRoomReplyTarget({ ref: refMgr, mentions: [], members, managerId: "mgr" });
	assert.equal(t.quoteLabel, "回复给 管家");
	// 引用用户消息 → 不显示「只有用户」误导标签，但仍带 replyToId 作历史 context
	const refUser = buildReplyRef(msg({ id: "z", role: "user", content: "大家看看" }), { id: "user", name: "我" });
	t = resolveRoomReplyTarget({ ref: refUser, mentions: [], members, managerId: "mgr" });
	assert.equal(t.quoteLabel, null);
	assert.equal(t.replyToId, "z");
	assert.equal(t.unavailable, false);
	// 作者已删除 / 离群 → 目标不可用，需 @
	const gone = resolveRoomReplyTarget({ ref: refA, mentions: [], members: [{ agentId: "a1", name: "甲", deleted: true }], managerId: "mgr" });
	assert.equal(gone.unavailable, true);
	assert.equal(gone.needMention, true);
	const left = resolveRoomReplyTarget({ ref: refA, mentions: [], members: [{ agentId: "a1", name: "甲", left: true }], managerId: "mgr" });
	assert.equal(left.unavailable, true);
	// 无引用
	assert.deepEqual(resolveRoomReplyTarget({ ref: null, mentions: [], members, managerId: "mgr" }), { quoteLabel: null, mentionLabel: null, replyToId: null, unavailable: false, needMention: false });
});

test("单聊 / 子代理：引用目标恒为当前助理，不跨助理路由", () => {
	assert.deepEqual(resolveAgentReplyTarget(null, "助理A"), { quoteLabel: null, replyToId: null });
	const ref = buildReplyRef(msg({ id: "m1" }), { id: "a1", name: "助理A" });
	assert.deepEqual(resolveAgentReplyTarget(ref, "助理A"), { quoteLabel: "回复给 助理A", replyToId: "m1" });
});

test("draft key：助理 + 对话 / 群 / 子代理互不相同", () => {
	const keys = new Set([replyDraftKey.agent("a1", "c1"), replyDraftKey.agent("a1", "c2"), replyDraftKey.agent("a2", "c1"), replyDraftKey.room("c1"), replyDraftKey.subagent("c1")]);
	assert.equal(keys.size, 5);
	assert.notEqual(replyDraftKey.agent("a1", "c1"), replyDraftKey.agent("a1", "c2"));
});

test("发送 payload：replyToId / clientId 可选，后端定字段", () => {
	assert.deepEqual(agentSendBody("hi", ["f1"], "c1"), { text: "hi", attachments: ["f1"], conversationId: "c1" });
	assert.deepEqual(agentSendBody("hi", [], "c1", "m1"), { text: "hi", attachments: [], conversationId: "c1", replyToId: "m1" });
	assert.deepEqual(agentSendBody("hi", [], "c1", "m1", "cid1"), { text: "hi", attachments: [], conversationId: "c1", replyToId: "m1", clientId: "cid1" });
	assert.deepEqual(roomSendBody("hi", ["a2"], ["f1"], "m1", "cid1"), { text: "hi", mentions: ["a2"], attachments: ["f1"], replyToId: "m1", clientId: "cid1" });
	assert.deepEqual(roomSendBody("hi", [], []), { text: "hi", mentions: [], attachments: [] });
	assert.deepEqual(subagentSendBody("hi", "m1"), { text: "hi", replyToId: "m1" });
	assert.deepEqual(subagentSendBody("hi"), { text: "hi" });
});

test("幂等 clientId：同一份草稿签名不变，变了一项就换新", () => {
	const a = draftSignature({ text: "hi", attachmentIds: ["f1"], replyToId: "m1" });
	const b = draftSignature({ text: "hi", attachmentIds: ["f1"], replyToId: "m1" });
	const c = draftSignature({ text: "hi2", attachmentIds: ["f1"], replyToId: "m1" });
	const d = draftSignature({ text: "hi", attachmentIds: ["f1"], replyToId: null });
	assert.equal(a, b);
	assert.notEqual(a, c);
	assert.notEqual(a, d);
	assert.ok(newClientId().length > 8);
	assert.notEqual(newClientId(), newClientId());
});

test("liveMentions：文字里删掉的 @ 不再生效", () => {
	const names = { a1: "甲", a2: "乙" };
	assert.deepEqual(liveMentions(["a1", "a2"], "@甲 看一下", (id) => names[id]), ["a1"]);
	assert.deepEqual(liveMentions(["a1"], "没有 @", (id) => names[id]), []);
});

test("复制原文：去掉思考过程，Markdown 原样保留", () => {
	assert.equal(copyTextOf(msg({ content: "<think>先想想</think>\n**结论**：好的 [链接](https://x.y)" })), "**结论**：好的 [链接](https://x.y)");
	assert.equal(copyTextOf(msg({ role: "user", content: "  请看一下  " })), "请看一下");
	assert.equal(copyTextOf(msg({ content: "<think>只有思考</think>" })), "");
});
