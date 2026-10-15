/**
 * 群聊入队幂等（room_turns.source_message_id）测试。
 *
 * 缺口：设计 §7 承诺「入队前若已存在该 source 的未取消回合就跳过」，但此前只写了列、没读写；
 * 真正的去重只靠 UI 传来的 clientId。这里验证按**可信持久化来源消息 id**路由：
 * 重复路由事件 / 客户端重试 / 服务重启都不重复入队唤醒，同时不影响 @所有人 每人 1 条、
 * 引用定向（只叫被引用者）、管理者分工（不同 reason）等正常多步行为。
 *
 * 强制临时数据目录 + 假 provider（setup.ts），不碰真实用户数据 / 钥匙串 / 付费模型。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db, now } from "../src/db.ts";
import { insertMessage } from "../src/messages.ts";
import * as rooms from "../src/rooms/index.ts";

const mkAgent = (id: string, name: string) => db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run(id, name, "A", "#000", now());
mkAgent("qd-mgr", "管");
mkAgent("qd-a", "甲");
mkAgent("qd-b", "乙");

const room = rooms.createRoom({ name: "入队去重群", memberIds: ["qd-mgr", "qd-a", "qd-b"], managerId: "qd-mgr" });
const assistantMsg = (agentId: string, content: string) => insertMessage({ agentId, roomId: room.id, conversationId: null, role: "assistant", content });

type Turn = { agent_id: string; reason: string; status: string; round_id: string; source_message_id: string | null; depth: number };
const turnsFor = (sourceId: string) => db.prepare("SELECT * FROM room_turns WHERE room_id = ? AND source_message_id = ? ORDER BY rowid").all(room.id, sourceId) as unknown as Turn[];
const totalTurns = () => (db.prepare("SELECT COUNT(*) AS n FROM room_turns WHERE room_id = ?").get(room.id) as { n: number }).n;

test("根路由：同一来源消息路由两次只入队一组，source_message_id 记录可信来源", async () => {
	const msg = rooms.postUserMessage(room.id, "普通的无 @ 消息");
	const first = turnsFor(msg.id);
	assert.equal(first.length, 1, "无 @ 默认只叫管理者一人");
	assert.equal(first[0].agent_id, "qd-mgr");
	assert.equal(first[0].reason, "manager");
	assert.equal(first[0].source_message_id, msg.id, "写入了可信来源消息 id");

	// 同一持久化来源再路由（重复路由事件 / 重试）：不再新增回合
	const before = totalTurns();
	rooms.routeUserMessage(room.id, msg.id);
	assert.equal(totalTurns(), before, "重复路由不新增任何回合");
	assert.deepEqual(turnsFor(msg.id).map((t) => [t.agent_id, t.reason]), first.map((t) => [t.agent_id, t.reason]));
	await rooms.stop(room.id, false);
});

test("@所有人：每个目标各 1 条；同一事件重复路由不翻倍", async () => {
	const msg = rooms.postUserMessage(room.id, "@所有人 各自看一下");
	const first = turnsFor(msg.id);
	assert.deepEqual(first.map((t) => t.agent_id).sort(), ["qd-a", "qd-b", "qd-mgr"], "每个成员各一条");
	assert.equal(new Set(first.map((t) => t.round_id)).size, 1, "同一来源属于同一轮");
	const before = totalTurns();
	rooms.routeUserMessage(room.id, msg.id);
	rooms.routeUserMessage(room.id, msg.id);
	assert.equal(totalTurns(), before, "重复同一事件不 double");
	await rooms.stop(room.id, false);
});

test("两条真正不同的消息（同文本）各自唤醒一次，不按文本去重", async () => {
	const mk = () => insertMessage({ agentId: "", roomId: room.id, conversationId: null, role: "user", content: "@甲 同样的话", meta: { mentions: ["qd-a"], all: false } });
	const m1 = mk();
	const m2 = mk();
	rooms.routeUserMessage(room.id, m1.id);
	await rooms.stop(room.id, false);
	rooms.routeUserMessage(room.id, m2.id);
	assert.equal(turnsFor(m1.id).length, 1);
	assert.equal(turnsFor(m2.id).length, 1);
	assert.equal(turnsFor(m1.id)[0].agent_id, "qd-a");
	assert.equal(turnsFor(m2.id)[0].agent_id, "qd-a");
	await rooms.stop(room.id, false);
});

test("服务重启：来源已有未取消回合，重复投递 0 个新回合", async () => {
	const msg = rooms.postUserMessage(room.id, "@乙 重启测试", { mentions: ["qd-b"] });
	const before = totalTurns();
	// 模拟启动时 bootstrapRooms：running/queued → interrupted（仍是未取消回合）
	db.prepare("UPDATE room_turns SET status = 'interrupted' WHERE room_id = ? AND status IN ('running','queued')").run(room.id);
	rooms.routeUserMessage(room.id, msg.id);
	assert.equal(totalTurns(), before, "重启后同一来源不重开回合");
	await rooms.stop(room.id, false);
});

test("引用甲（普通成员）⇒ 只叫甲，管理者 0", async () => {
	const target = assistantMsg("qd-a", "甲说过的话");
	const msg = rooms.postUserMessage(room.id, "接着说", { replyToId: target.id });
	const ts = turnsFor(msg.id);
	assert.deepEqual(ts.map((t) => t.agent_id), ["qd-a"]);
	assert.equal(ts[0].reason, "mention");
	assert.ok(!ts.some((t) => t.agent_id === "qd-mgr"), "不叫管理者");
	await rooms.stop(room.id, false);
});

test("引用甲但 @乙 ⇒ 只叫乙（显式 @ 优先）", async () => {
	const target = assistantMsg("qd-a", "甲的另一条");
	const msg = rooms.postUserMessage(room.id, "@乙 你看", { replyToId: target.id, mentions: ["qd-b"] });
	const ts = turnsFor(msg.id);
	assert.deepEqual(ts.map((t) => t.agent_id), ["qd-b"]);
	await rooms.stop(room.id, false);
});

test("引用管理者自己的消息 ⇒ 只叫管理者，不自动扩派", async () => {
	const target = assistantMsg("qd-mgr", "管理者说过的话");
	const msg = rooms.postUserMessage(room.id, "补充", { replyToId: target.id });
	const ts = turnsFor(msg.id);
	assert.deepEqual(ts.map((t) => t.agent_id), ["qd-mgr"]);
	assert.ok(!ts.some((t) => t.agent_id !== "qd-mgr"), "不扩派给其它成员");
	await rooms.stop(room.id, false);
});

test("clientId 幂等仍然生效（不落第二条、不重复路由）", async () => {
	const a = rooms.postUserMessage(room.id, "带着 clientId", { clientId: "qd-cid", mentions: ["qd-a"] });
	const b = rooms.postUserMessage(room.id, "带着 clientId", { clientId: "qd-cid", mentions: ["qd-a"] });
	assert.equal(a.id, b.id);
	assert.equal(turnsFor(a.id).length, 1);
	await rooms.stop(room.id, false);
});

test("全部取消：普通重复事件不重唤，只有显式 retry 才重新唤醒（不承诺 exactly-once）", async () => {
	const msg = rooms.postUserMessage(room.id, "@甲 取消语义", { mentions: ["qd-a"] });
	// 先停下这一轮（中止当前、取消排队），再把这个来源的所有回合置为 cancelled
	await rooms.stop(room.id, false);
	db.prepare("UPDATE room_turns SET status = 'cancelled', finished_at = ? WHERE room_id = ? AND source_message_id = ?").run(now(), room.id, msg.id);
	const cancelled = turnsFor(msg.id);
	assert.ok(cancelled.length >= 1);
	assert.ok(cancelled.every((t) => t.status === "cancelled"));
	// 普通重复路由事件：不重新唤醒（避免取消后被误叫起来）
	rooms.routeUserMessage(room.id, msg.id);
	assert.equal(turnsFor(msg.id).length, cancelled.length, "普通重复事件不重新唤醒");
	// 显式 retry：允许重新入队
	rooms.routeUserMessage(room.id, msg.id, { retry: true });
	assert.ok(turnsFor(msg.id).length > cancelled.length, "显式 retry 才重新入队");
	await rooms.stop(room.id, false);
});
