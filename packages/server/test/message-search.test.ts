import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../src/db.ts";
import { searchMessages, type SearchScope } from "../src/message-search.ts";

const direct: SearchScope = { kind: "conversation", id: "chat1", agentId: "a" };
const add = db.prepare("INSERT INTO messages(id,agent_id,conversation_id,room_id,task_id,subagent_id,role,content,meta,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?, ?, ?)");
const seed = (id: string, body: string, { chat = "chat1", room = null as string | null, agent = "a", role = "assistant", time = 10, task = null as string | null, sub = null as string | null } = {}) => add.run(id, agent, chat, room, task, sub, role, body, '{"thinking":"隐藏思想","attachments":[{"name":"隐藏附件"}]}', time, time);

test("搜索按会话或群分域，思考、工具、系统、任务和附件不进结果", () => {
	seed("good", "<think>隐藏思想</think> 正文中文 **Release** [说明](https://hidden-url.invalid)");
	seed("other", "正文中文", { chat: "chat2" });
	seed("room1", "正文中文", { room: "room1" });
	seed("room2", "正文中文", { room: "room2" });
	seed("bad-owner", "正文中文", { agent: "b" });
	for (const role of ["tool", "system", "card"]) seed(role, "正文中文", { role });
	seed("task", "正文中文", { task: "t" });
	seed("subagent", "正文中文", { sub: "s" });
	const ids = (scope: SearchScope, q: string) => searchMessages(scope, q)?.items.map((m) => m.id);
	assert.deepEqual(ids(direct, "正文中文"), ["good"]);
	assert.deepEqual(ids(direct, "rElEaSe"), ["good"]);
	for (const term of ["隐藏思想", "隐藏附件", "hidden-url", "无匹配"]) assert.deepEqual(ids(direct, term), []);
	assert.deepEqual(ids({ ...direct, id: "chat2" }, "正文中文"), ["other"]);
	assert.deepEqual(ids({ kind: "room", id: "room1" }, "正文中文"), ["room1"]);
	assert.deepEqual(ids({ kind: "room", id: "room2" }, "正文中文"), ["room2"]);
});

test("全历史、相同毫秒时稳定分页，并测量 30000 条会话", (t) => {
	const scope: SearchScope = { ...direct, id: "long" };
	db.exec("BEGIN");
	for (let i = 0; i < 30_000; i++) seed(`long-${i}`, i < 65 ? "历史命中 Needle" : `普通合成正文 ${i} ${"用于模拟较长历史正文。".repeat(18)}`, { chat: "long", time: i < 65 ? 1 : i, role: "user" });
	db.exec("COMMIT");
	const start = performance.now();
	const first = searchMessages(scope, "needle")!;
	const firstMs = performance.now() - start;
	const absentStart = performance.now();
	assert.deepEqual(searchMessages(scope, "绝无此词")?.items, []);
	t.diagnostic(`30000 条：旧历史首批 ${firstMs.toFixed(1)}ms；无命中 ${(performance.now() - absentStart).toFixed(1)}ms（SQLite/本进程）`);
	assert.equal(first.items.length, 30);
	assert.ok(first.nextCursor);
	assert.equal(searchMessages(direct, "needle", first.nextCursor), null);
	assert.equal(searchMessages(scope, "另一搜索", first.nextCursor), null);
	const second = searchMessages(scope, "needle", first.nextCursor)!;
	const third = searchMessages(scope, "needle", second.nextCursor!)!;
	assert.deepEqual([...first.items, ...second.items, ...third.items].map((m) => m.id), Array.from({ length: 65 }, (_, i) => `long-${64 - i}`));
	assert.equal(third.nextCursor, null);
});
