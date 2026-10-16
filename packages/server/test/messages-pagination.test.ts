/**
 * 聊天历史分页：稳定游标（同一毫秒多条消息不跳不重）+ 旧接口契约不变。
 *
 * 背景：手机端首屏「向上加载更早」原来用 `before=created_at`（毫秒）。同一毫秒落多条消息
 * （工具结果 + 正文常常同刻）时，`created_at < before` 会把边界那批整批跳过 → 缺消息。
 * 现在客户端改用 `beforeSeq`（rowid）复合游标；旧客户端只传 `before` 时保持 `created_at < before` 原语义。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db, now } from "../src/db.ts";

db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run("ap", "分页", "A", "#000", now());

const { createConversation } = await import("../src/conversations.ts");
const { listMessages, listRoomMessages } = await import("../src/messages.ts");

const conv = createConversation("ap").id;
const ins = db.prepare(
	"INSERT INTO messages(id, agent_id, conversation_id, task_id, role, content, meta, status, created_at, updated_at, room_id, subagent_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
);

/** 同一毫秒写入 n 条（模拟工具结果与正文同刻落库），rowid 递增保证先后。 */
const seedSameMs = (n: number, at: number) => {
	for (let i = 0; i < n; i++) ins.run(`m_same_${i}`, "ap", conv, null, i % 2 ? "assistant" : "tool", `内容 ${i}`, "{}", "done", at, at, null, null);
};

test("单聊：beforeSeq 复合游标在 created_at 相同时逐页不漏不重", () => {
	const base = now() - 10_000;
	seedSameMs(10, base); // 10 条同一毫秒
	ins.run("m_older", "ap", conv, null, "user", "更早", "{}", "done", base - 1000, base - 1000, null, null);
	ins.run("m_newer", "ap", conv, null, "user", "更新", "{}", "done", base + 1000, base + 1000, null, null);

	const seen: string[] = [];
	let page = listMessages("ap", { conversationId: conv, limit: 3 });
	while (page.length) {
		for (const m of page) assert.equal(typeof m.seq, "number", "每条都应带 seq（rowid），供下一页复用");
		// 倒序逐页取回：每页内部升序，向前翻的页要拼在已收集的前面
		seen.unshift(...page.map((m) => m.id));
		const oldest = page[0];
		page = listMessages("ap", { conversationId: conv, limit: 3, before: oldest.created_at, beforeSeq: oldest.seq });
	}
	assert.equal(new Set(seen).size, seen.length, "不应重复");
	assert.deepEqual(seen, ["m_older", "m_same_0", "m_same_1", "m_same_2", "m_same_3", "m_same_4", "m_same_5", "m_same_6", "m_same_7", "m_same_8", "m_same_9", "m_newer"], "正序、无缺");
});

test("单聊：只传 before（旧客户端）仍是 created_at < before 原语义", () => {
	const base = now() - 10_000;
	// 上一测试已全部落库；这里再补两条边界数据确认旧语义不会把同毫秒的捞回来
	ins.run("m_legacy_edge", "ap", conv, null, "user", "边界", "{}", "done", base, base, null, null);
	const legacy = listMessages("ap", { conversationId: conv, limit: 500, before: base });
	assert.ok(!legacy.some((m) => m.created_at === base), "旧 before 语义仍排除等于边界的同毫秒消息");
	assert.ok(legacy.some((m) => m.id === "m_older"), "更早的仍在");
});

test("群聊：seq（rowid）游标逐页不漏不重", () => {
	db.prepare("INSERT INTO rooms(id, name, created_at, updated_at) VALUES(?,?,?,?)").run("rp", "分页群", now(), now());
	const at = now() - 5000;
	for (let i = 0; i < 7; i++) db.prepare("INSERT INTO messages(id, agent_id, conversation_id, role, content, meta, status, created_at, updated_at, room_id) VALUES(?,?,?,?,?,?,?,?,?,?)").run(`rm_${i}`, "ap", null, i % 2 ? "assistant" : "user", `群 ${i}`, "{}", "done", at, at, "rp");
	const seen: string[] = [];
	let page = listRoomMessages("rp", { limit: 2 });
	while (page.length) {
		// 倒序逐页取回：每页内部升序，向前翻的页要拼在已收集的前面
		seen.unshift(...page.map((m) => m.id));
		page = listRoomMessages("rp", { limit: 2, before: page[0].seq });
	}
	assert.equal(seen.length, 7);
	assert.deepEqual(seen, ["rm_0", "rm_1", "rm_2", "rm_3", "rm_4", "rm_5", "rm_6"]);
});

test("单聊：afterSeq 复合游标前向分页在 created_at 相同时不漏不重（历史窗口「加载较新消息」）", () => {
	const convFwd = createConversation("ap").id;
	const at = now() - 8000;
	for (let i = 0; i < 10; i++) ins.run(`m_fwd_${i}`, "ap", convFwd, null, i % 2 ? "assistant" : "tool", `前向 ${i}`, "{}", "done", at, at, null, null);
	ins.run("m_fwd_after", "ap", convFwd, null, "user", "更新", "{}", "done", at + 1000, at + 1000, null, null);
	const expected = [...Array.from({ length: 10 }, (_, i) => `m_fwd_${i}`), "m_fwd_after"];
	const seen: string[] = [];
	// 从最早一条之前开始，按升序逐页向前（第一页用旧语义 after=created_at，后续用复合游标）
	let page = listMessages("ap", { conversationId: convFwd, limit: 3, after: at - 1 });
	while (page.length) {
		for (const m of page) assert.equal(typeof m.seq, "number", "每条都应带 seq（rowid），供前向游标复用");
		seen.push(...page.map((m) => m.id));
		const newest = page[page.length - 1];
		page = listMessages("ap", { conversationId: convFwd, limit: 3, after: newest.created_at, afterSeq: newest.seq });
	}
	assert.equal(new Set(seen).size, seen.length, "不应重复");
	assert.deepEqual(seen, expected, "正序、无缺");
});

test("群聊：after（rowid）前向分页不漏不重", () => {
	db.prepare("INSERT INTO rooms(id, name, created_at, updated_at) VALUES(?,?,?,?)").run("rp2", "前向群", now(), now());
	const at = now() - 3000;
	for (let i = 0; i < 7; i++) db.prepare("INSERT INTO messages(id, agent_id, conversation_id, role, content, meta, status, created_at, updated_at, room_id) VALUES(?,?,?,?,?,?,?,?,?,?)").run(`rm2_${i}`, "ap", null, i % 2 ? "assistant" : "user", `前向群 ${i}`, "{}", "done", at + i, at + i, "rp2");
	const seen: string[] = [];
	let page = listRoomMessages("rp2", { limit: 2, after: 0 });
	while (page.length) {
		seen.push(...page.map((m) => m.id));
		page = listRoomMessages("rp2", { limit: 2, after: page[page.length - 1].seq });
	}
	assert.deepEqual(seen, ["rm2_0", "rm2_1", "rm2_2", "rm2_3", "rm2_4", "rm2_5", "rm2_6"]);
});
