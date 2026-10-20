import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTranscript, capCheck, DEFAULT_CAPS, normalizeCaps, parseMentions, planAfter, planForUser, type TranscriptItem } from "../src/rooms/logic.ts";

const M = [
	{ id: "a", name: "小明" },
	{ id: "b", name: "小明明" },
	{ id: "c", name: "Bob" },
	{ id: "d", name: "设计师" },
	{ id: "e", name: "设计师" },
];

test("@ 解析：中文名无空格、最长匹配、顺序、去重", () => {
	assert.deepEqual(parseMentions("@小明明帮我看看，@小明 你也来", M).ids, ["b", "a"]);
	assert.deepEqual(parseMentions("@小明你好@小明", M).ids, ["a"]);
	assert.deepEqual(parseMentions("＠Bob hi", M).ids, ["c"]);
	assert.deepEqual(parseMentions("@Bobby hi", M).ids, [], "英文名后面紧跟字母不算");
	assert.deepEqual(parseMentions("发到 bob@小明.com", M).ids, [], "邮箱不算");
	assert.deepEqual(parseMentions("@bob 大小写不敏感", M).ids, ["c"]);
	assert.deepEqual(parseMentions("没有 @ 人", M).ids, []);
});
test("@ 解析：重名都算；界面带了精确 id 只算选中的", () => {
	assert.deepEqual(parseMentions("@设计师 做图", M).ids, ["d", "e"]);
	assert.deepEqual(parseMentions("@设计师 做图", M, ["e"]).ids, ["e"]);
});
test("@所有人 / @all", () => {
	const r = parseMentions("@所有人 开会", M);
	assert.equal(r.all, true);
	assert.deepEqual(r.ids, ["a", "b", "c", "d", "e"]);
	assert.equal(parseMentions("@all go", M).all, true);
	assert.equal(parseMentions("@allen go", M).all, false);
});

test("发言规则：@ 谁谁说；没 @ 只有管理者；管理者不在了退到第一个成员", () => {
	assert.deepEqual(planForUser(["b", "a"], "a", ["a", "b", "c"]).map((t) => [t.agentId, t.reason]), [["b", "mention"], ["a", "mention"]]);
	assert.deepEqual(planForUser([], "c", ["a", "b", "c"]).map((t) => [t.agentId, t.reason]), [["c", "manager"]]);
	assert.deepEqual(planForUser([], "x", ["a", "b"]).map((t) => t.agentId), ["a"]);
	assert.deepEqual(planForUser(["zz"], "a", ["a"]).map((t) => t.reason), ["manager"], "@ 了不在群里的人 = 没 @");
	assert.deepEqual(planForUser([], null, []), []);
});
test("派活：管理者派的才触发；成员 @ 别人不触发；成员都做完管理者总结", () => {
	const caps = DEFAULT_CAPS;
	const base = { managerId: "a", activeIds: ["a", "b", "c"], caps, batchDone: false, anyWorkerRan: false };
	const fromMgr = planAfter({ agentId: "a", reason: "manager", depth: 0 }, { ...base, assignments: [{ agentId: "b", task: "写" }, { agentId: "b" }, { agentId: "a" }, { agentId: "zz" }] });
	assert.deepEqual(fromMgr.map((t) => [t.agentId, t.reason, t.depth]), [["b", "assign", 1]], "去重、不派给自己、不派给非成员");
	assert.deepEqual(planAfter({ agentId: "b", reason: "assign", depth: 1 }, { ...base, assignments: [{ agentId: "c" }] }), [], "成员 @ 别人不触发，批次没完成也不总结");
	assert.deepEqual(planAfter({ agentId: "b", reason: "assign", depth: 1 }, { ...base, assignments: [], batchDone: true, anyWorkerRan: true }).map((t) => t.reason), ["followup"]);
	assert.deepEqual(planAfter({ agentId: "b", reason: "assign", depth: 1 }, { ...base, assignments: [], caps: { ...caps, followup: false }, batchDone: true, anyWorkerRan: true }), [], "关掉总结");
	assert.deepEqual(planAfter({ agentId: "b", reason: "mention", depth: 0 }, { ...base, assignments: [], batchDone: true, anyWorkerRan: true }), [], "用户 @ 的成员说完不叫管理者");
	assert.deepEqual(planAfter({ agentId: "a", reason: "followup", depth: 3 }, { ...base, assignments: [{ agentId: "b" }] }), [], "派活深度上限");
});
test("上限：总次数 / 每人次数（没有 token 预算，旧数据里的 tokenBudget 被忽略）", () => {
	const caps = normalizeCaps({ maxTurns: 3, perAgent: 2, tokenBudget: 1000 } as never);
	const t = { agentId: "a", reason: "assign" as const, depth: 1 };
	assert.equal(capCheck(t, { turns: 0, perAgent: {} }, caps), null);
	assert.match(capCheck(t, { turns: 3, perAgent: {} }, caps)!, /3 次/);
	assert.match(capCheck(t, { turns: 1, perAgent: { a: 2 } }, caps)!, /上限/);
	assert.equal(capCheck(t, { turns: 1, perAgent: {}, tokens: 9_999_999 } as never, caps), null, "token 用量再大也不挡");
	assert.equal("tokenBudget" in normalizeCaps({ tokenBudget: 1000 } as never), false);
	assert.deepEqual(normalizeCaps({ maxTurns: 999, perAgent: -3 }), { ...DEFAULT_CAPS, maxTurns: 30, perAgent: 1 });
});
test("两波派活后管理者收尾不被每人次数上限挡住", () => {
	const caps = normalizeCaps({ maxTurns: 8, perAgent: 2 });
	// 管理者已发言 2 次（第一次派活 + 第二波派活），成员回报后它的收尾 followup 仍可进行
	assert.equal(capCheck({ agentId: "mgr", reason: "followup", depth: 1 }, { turns: 5, perAgent: { mgr: 2 } }, caps), null);
	// 普通派活/点名仍受每人上限
	assert.match(capCheck({ agentId: "mgr", reason: "manager", depth: 0 }, { turns: 5, perAgent: { mgr: 2 } }, caps)!, /上限/);
	// 总次数上限对收尾仍生效
	assert.match(capCheck({ agentId: "mgr", reason: "followup", depth: 1 }, { turns: 8, perAgent: { mgr: 2 } }, caps)!, /8 次/);
});
test("增量注入：只有最终文字和卡片摘要，跳过自己的，超预算保留最近的", () => {
	const items: TranscriptItem[] = [
		{ seq: 1, role: "user", agentId: "", content: "大家好", meta: {}, status: "done" },
		{ seq: 2, role: "assistant", agentId: "a", content: "我是 A", meta: {}, status: "done" },
		{ seq: 3, role: "assistant", agentId: "b", content: "我是 B", meta: {}, status: "done" },
		{ seq: 4, role: "card", agentId: "b", content: "", meta: { kind: "approval", summary: "删除 x.txt", status: "approved" }, status: "done" },
		{ seq: 5, role: "assistant", agentId: "b", content: "", meta: {}, status: "streaming" },
		{ seq: 6, role: "system", agentId: "", content: "整理", meta: { kind: "compaction" }, status: "done" },
	];
	const names = (id: string) => ({ a: "A", b: "B" })[id] ?? "?";
	const r = buildTranscript(items, "a", names);
	assert.equal(r.lastSeq, 6);
	assert.equal(r.text, "【用户】大家好\n【B】我是 B\n[B 请求批准] 删除 x.txt（用户已批准）");
	const small = buildTranscript(items, "a", names, 20);
	assert.ok(small.omitted >= 1 && small.text.startsWith("（更早的"));
});

// ---------------------------------------------------------------- 数据库层：成员、删除、注入游标、群专属助理
const { db, now } = await import("../src/db.ts");
const mk = (id: string, name: string) => db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run(id, name, "A", "#000", now());
mk("ra", "甲");
mk("rb", "乙");
mk("rc", "丙");
const rooms = await import("../src/rooms/index.ts");
const { insertMessage, listRoomMessages } = await import("../src/messages.ts");
const { listConversations } = await import("../src/conversations.ts");

test("建群：默认第一个是管理者；成员对话消息自动进群且不算私聊未读；隐藏对话不出现在对话列表", async () => {
	const r = rooms.createRoom({ name: "测试群", memberIds: ["ra", "rb", "rc"] });
	assert.equal(r.manager_id, "ra");
	assert.equal(rooms.membersOf(r.id).length, 3);
	rooms.postUserMessage; // 存在
	const conv = (await import("../src/conversations.ts")).createConversation("rb", "群聊", { makeCurrent: false }).id;
	db.prepare("UPDATE conversations SET hidden = 1 WHERE id = ?").run(conv);
	db.prepare("UPDATE room_members SET conversation_id = ? WHERE room_id = ? AND agent_id = ?").run(conv, r.id, "rb");
	const before = (db.prepare("SELECT unread FROM agents WHERE id = 'rb'").get() as { unread: number }).unread;
	const m = insertMessage({ agentId: "rb", conversationId: conv, role: "assistant", content: "乙说话了" });
	assert.equal(m.room_id, r.id);
	assert.equal((db.prepare("SELECT unread FROM agents WHERE id = 'rb'").get() as { unread: number }).unread, before, "私聊未读不变");
	assert.ok(rooms.getRoom(r.id)!.unread >= 1);
	assert.ok(!listConversations("rb").some((c) => c.id === conv));
	assert.ok(listRoomMessages(r.id).some((x) => x.content === "乙说话了"));
	// 分页
	const all = listRoomMessages(r.id);
	const page = listRoomMessages(r.id, { before: all[all.length - 1].seq, limit: 1 });
	assert.equal(page.length, 1);
	assert.equal(page[0].id, all[all.length - 2].id);
});
test("删除助理：群里历史保留并标记已删除；删的是管理者就换人", () => {
	const r = rooms.createRoom({ name: "删人群", memberIds: ["ra", "rb"], managerId: "ra" });
	rooms.onAgentDeleted("ra");
	const j = rooms.roomJson(rooms.getRoom(r.id)!);
	assert.equal(j.managerId, "rb");
	assert.ok(j.members.find((m) => m.agentId === "ra")!.deleted);
	assert.ok(listRoomMessages(r.id).some((m) => /管理者 甲 已删除/.test(m.content)));
	db.prepare("UPDATE room_members SET left_at = NULL, deleted = 0 WHERE agent_id = 'ra'").run();
});
test("移出 / 改管理者 / 没有成员时报错", () => {
	const r = rooms.createRoom({ name: "改群", memberIds: ["ra", "rb", "rc"] });
	rooms.updateRoom(r.id, { memberIds: ["rb", "rc"] });
	assert.equal(rooms.getRoom(r.id)!.manager_id, "rb", "管理者被移出 → 第一个成员");
	rooms.updateRoom(r.id, { managerId: "rc" });
	assert.equal(rooms.getRoom(r.id)!.manager_id, "rc");
	assert.throws(() => rooms.updateRoom(r.id, { memberIds: [] }));
	assert.throws(() => rooms.createRoom({ memberIds: ["nope"] }));
});
test("提议：模型只能是已配置的；确认后创建群专属助理；删群可保留或删除", async () => {
	const p = rooms.normalizeProposal({ name: "x", manager: 5, members: [{ name: "A", model: { provider: "nope", id: "m" } }, { agentId: "rb" }] });
	assert.equal(p.manager, 0);
	assert.match(p.members[0].modelReason!, /没有配置/);
	assert.deepEqual(p.members[1], { agentId: "rb" });
	const room = await rooms.confirmProposal(p);
	const scoped = db.prepare("SELECT id, scope, room_id FROM agents WHERE room_id = ?").all(room.id) as { id: string; scope: string }[];
	assert.equal(scoped.length, 1);
	assert.equal(scoped[0].scope, "room");
	assert.equal(room.manager_id, scoped[0].id);
	const { copyAgentToUser } = await import("../src/rooms/copy.ts");
	const copy = await copyAgentToUser(scoped[0].id, {});
	assert.equal((db.prepare("SELECT scope FROM agents WHERE id = ?").get(copy.id) as { scope: string }).scope, "user");
	const res = await rooms.deleteRoom(room.id, {});
	assert.ok(res && res.deletedAgents.includes(scoped[0].id));
	assert.ok(db.prepare("SELECT 1 FROM agents WHERE id = ?").get(copy.id), "复制出来的不受影响");
	assert.equal(rooms.getRoom(room.id), undefined);
	// 保留：转成我的助理
	const room2 = await rooms.confirmProposal({ name: "y", manager: 0, members: [{ name: "B" }] });
	const b = (db.prepare("SELECT id FROM agents WHERE room_id = ?").get(room2.id) as { id: string }).id;
	await rooms.deleteRoom(room2.id, { keepAgents: [b] });
	assert.equal((db.prepare("SELECT scope FROM agents WHERE id = ?").get(b) as { scope: string }).scope, "user");
});
test("群成员声明的 skills 落成真实启用集合（不只是 persona 说明）", async () => {
	const { listSkills } = await import("../src/skills.ts");
	const { assignedSkillIds } = await import("../src/skill-assignments.ts");
	const s = listSkills()[0];
	const room = await rooms.confirmProposal({ name: "技能群", manager: 0, members: [{ name: "C", skills: [s.name, "不存在的技能"] }] });
	const cid = (db.prepare("SELECT id FROM agents WHERE room_id = ?").get(room.id) as { id: string }).id;
	assert.deepEqual(assignedSkillIds(cid), [s.id], "成员声明的技能应写成该成员的 canonical 启用集合，未知名字被过滤");
});

test("复制群成员为我的助理：不会扩大技能启用集合", async () => {
	const { listSkills } = await import("../src/skills.ts");
	const { assignedSkillIds } = await import("../src/skill-assignments.ts");
	const { copyAgentToUser } = await import("../src/rooms/copy.ts");
	const s = listSkills()[0];
	const room = await rooms.confirmProposal({ name: "复制群", manager: 0, members: [{ name: "D", skills: [s.name] }] });
	const src = (db.prepare("SELECT id FROM agents WHERE room_id = ?").get(room.id) as { id: string }).id;
	assert.deepEqual(assignedSkillIds(src), [s.id]);
	const copy = await copyAgentToUser(src, {});
	const copied = assignedSkillIds(copy.id);
	assert.ok(copied.every((id) => assignedSkillIds(src).includes(id)), "复制出来的不会多出源没有的技能");
});

test("服务重启：运行中的群聊回合标记中断，群里出现“继续”", () => {
	const r = rooms.createRoom({ name: "重启群", memberIds: ["rb", "rc"] });
	db.prepare("INSERT INTO room_turns(id, room_id, round_id, agent_id, reason, depth, status, created_at) VALUES('t1', ?, 'rd', 'rb', 'manager', 0, 'running', ?)").run(r.id, now());
	db.prepare("INSERT INTO room_turns(id, room_id, round_id, agent_id, reason, task, depth, status, created_at) VALUES('t2', ?, 'rd', 'rc', 'assign', '写报告', 1, 'queued', ?)").run(r.id, now());
	rooms.bootstrapRooms();
	const paused = JSON.parse(rooms.getRoom(r.id)!.paused!);
	assert.deepEqual(paused.pending.map((p: { agentId: string; reason: string }) => [p.agentId, p.reason]), [["rb", "resume"], ["rc", "assign"]]);
	assert.ok(listRoomMessages(r.id).some((m) => m.meta.action === "room-continue"));
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM room_turns WHERE room_id = ? AND status = 'interrupted'").get(r.id) as { n: number }).n, 2);
});
