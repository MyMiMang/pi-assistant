import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

/** 群里约的跟进到点：在群里叫醒成员发言（不派后台巡检帮手）；群已停止只留说明；成员离开退回后台巡检；单聊不变。临时数据 + Mock 模型。 */
process.env.PIA_MOCK = "1";
const { db, now } = await import("../src/db.ts");
const { initModels } = await import("../src/models.ts");
await initModels(memoryCredentialStore()); // 只用内存凭据 + Mock 模型
const rooms = await import("../src/rooms/index.ts");
const P = await import("../src/proactive.ts");
await import("../src/subagents.ts");
const { memberConversation } = await import("../src/rooms/store.ts");
const { REASON_LINE } = await import("../src/rooms/turn-prompt.ts");
const { capCheck, planAfter } = await import("../src/rooms/logic.ts");

const T = (d: number, h: number, m = 0) => Date.UTC(2026, 9, d, h - 8, m); // 2026-10-12 周一 10:00 本地，非免打扰
const NOW = T(12, 10);
for (const [id, name] of [["fm", "总管"], ["fa", "阿甲"]]) db.prepare("INSERT INTO agents(id, name, avatar, color, model_provider, model_id, created_at) VALUES(?,?,?,?,?,?,?)").run(id, name, "A", "#111", "mock", "echo", now());
const spawned: string[] = [];
let seq = 0;
P.setProactiveSpawner((agentId, title, _ins, opts) => {
	const id = `ft${++seq}`;
	db.prepare("INSERT INTO subagents(id, agent_id, conversation_id, task, context, model_provider, model_id, model_reason, status, last_activity_at, created_at, kind, title) VALUES(?,?,?,'x','','mock','echo','','running',?,?,?,?)").run(id, agentId, opts.conversationId, now(), now(), opts.kind, title);
	spawned.push(`${agentId}:${title}`);
	return { id };
});
const wait = async (fn: () => boolean, ms = 15000, what = "条件") => {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (fn()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`${what}超时`);
};
const idle = (roomId: string) => !rooms.stateOf(roomId).running;
const sysMsgs = (roomId: string) => (db.prepare("SELECT content FROM messages WHERE room_id = ? AND role = 'system' ORDER BY rowid").all(roomId) as { content: string }[]).map((m) => m.content);
const turnsOf = (roomId: string) => db.prepare("SELECT agent_id, reason, task, status FROM room_turns WHERE room_id = ?").all(roomId) as { agent_id: string; reason: string; task: string | null; status: string }[];
const reset = () => {
	db.prepare("DELETE FROM proactive_followups").run();
	db.prepare("DELETE FROM proactive_runs").run();
	spawned.length = 0;
};

test("群里约的跟进到点：群里叫醒成员发言 + 可见提示，不派后台巡检", async () => {
	reset();
	const room = rooms.createRoom({ name: "跟进群", memberIds: ["fm", "fa"], managerId: "fm" });
	const conv = memberConversation(room.id, "fa");
	P.scheduleFollowup("fa", conv, NOW - 1000, "看看报告导出好了没有");
	assert.deepEqual(P.tickProactive(NOW), ["fa:followup"]);
	assert.deepEqual(spawned, [], "没有派 heartbeat 帮手");
	assert.ok(sysMsgs(room.id).some((c) => /⏰ 阿甲 约好的跟进到点了：看看报告导出好了没有/.test(c)), "群里有可见提示");
	await wait(() => turnsOf(room.id).some((t) => t.agent_id === "fa" && t.status !== "queued" && t.status !== "running"), 15000, "成员在群里发言");
	assert.equal(turnsOf(room.id)[0].reason, "timer");
	assert.equal(turnsOf(room.id)[0].task, "看看报告导出好了没有");
	assert.ok(db.prepare("SELECT 1 FROM messages WHERE room_id = ? AND agent_id = 'fa' AND role = 'assistant'").get(room.id), "Mock 模型下群里出现该成员的发言");
	await wait(() => idle(room.id));
	assert.equal(turnsOf(room.id).filter((t) => t.agent_id === "fm").length, 0, "不触发管理者收尾");
});

test("群已停止：不发言，只插可见说明", async () => {
	reset();
	const room = rooms.createRoom({ name: "停止跟进群", memberIds: ["fm", "fa"], managerId: "fm" });
	const conv = memberConversation(room.id, "fa");
	db.prepare("UPDATE rooms SET paused = ? WHERE id = ?").run(JSON.stringify({ pending: [], reason: "群聊已停止", stopped: true }), room.id);
	P.scheduleFollowup("fa", conv, NOW - 1000, "帮我看日志");
	assert.deepEqual(P.tickProactive(NOW), ["fa:followup"]);
	assert.deepEqual(spawned, []);
	assert.equal(turnsOf(room.id).length, 0, "没有排回合");
	assert.ok(sysMsgs(room.id).some((c) => /帮我看日志（群已停止，没有自动执行；需要的话 @ 阿甲）/.test(c)));
});

test("成员已离开群：退回原来的后台巡检", () => {
	reset();
	const room = rooms.createRoom({ name: "离开群", memberIds: ["fm", "fa"], managerId: "fm" });
	const conv = memberConversation(room.id, "fa");
	db.prepare("UPDATE room_members SET left_at = ? WHERE room_id = ? AND agent_id = 'fa'").run(now(), room.id);
	P.scheduleFollowup("fa", conv, NOW - 1000, "离开后的跟进");
	assert.deepEqual(P.tickProactive(NOW), ["fa:followup"]);
	assert.equal(spawned.length, 1, "派了后台巡检帮手");
	assert.equal(turnsOf(room.id).length, 0);
});

test("单聊会话里约的跟进：行为不变（后台巡检）", () => {
	reset();
	P.scheduleFollowup("fa", "c-single-chat", NOW - 1000, "单聊跟进");
	assert.deepEqual(P.tickProactive(NOW), ["fa:followup"]);
	assert.equal(spawned.length, 1);
});

test("timer 回合：有提示行、占普通单人发言次数、不触发管理者收尾", () => {
	const t = { agentId: "fa", reason: "timer" as const, task: "查日志", depth: 0 };
	assert.match(REASON_LINE(t, "总管", 2), /约好的跟进.*查日志/s);
	const caps = { maxTurns: 6, perAgent: 1, maxDepth: 2, followup: true } as never;
	assert.ok(capCheck(t, { turns: 0, perAgent: { fa: 1 } }, caps), "和普通发言一样受每人次数限制");
	assert.deepEqual(planAfter(t, { managerId: "fm", activeIds: ["fm", "fa"], assignments: [], caps, batchDone: true, anyWorkerRan: true }), []);
});

test("免打扰时段（默认 22:00–08:00）：群里约的照常到点执行，单聊的仍顺延", async () => {
	reset();
	const NIGHT = T(12, 23, 30);
	const room = rooms.createRoom({ name: "夜里跟进群", memberIds: ["fm", "fa"], managerId: "fm" });
	P.scheduleFollowup("fa", "c-single-night", NIGHT - 2000, "单聊夜里的跟进");
	P.scheduleFollowup("fa", memberConversation(room.id, "fa"), NIGHT - 1000, "群里夜里的跟进");
	assert.deepEqual(P.tickProactive(NIGHT), ["fa:followup"]);
	assert.deepEqual(spawned, [], "单聊的没有在免打扰时段派后台巡检");
	assert.ok(sysMsgs(room.id).some((c) => /群里夜里的跟进/.test(c)), "群里的跳过了排在前面的单聊跟进，到点执行");
	assert.equal((db.prepare("SELECT status FROM proactive_followups WHERE note = '单聊夜里的跟进'").get() as { status: string }).status, "pending");
	await wait(() => idle(room.id));
});
