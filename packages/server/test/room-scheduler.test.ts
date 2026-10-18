import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

/** 群调度：用户插话 / 停止 / 继续 / 上限暂停。真实 rooms 调度 + Mock 模型，只用临时数据目录。 */
const { db, now } = await import("../src/db.ts");
const rooms = await import("../src/rooms/index.ts");

const mkAgent = (id: string, name: string) =>
	db.prepare("INSERT INTO agents(id, name, avatar, color, model_provider, model_id, created_at) VALUES(?,?,?,?,?,?,?)").run(id, name, "A", "#111", "mock", "echo", now());
mkAgent("sm", "总管");
mkAgent("sa", "阿甲");
mkAgent("sb", "阿乙");

const wait = async (fn: () => boolean, ms = 15000, what = "条件") => {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (fn()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`${what}超时`);
};
const turns = (roomId: string) => db.prepare("SELECT agent_id, status FROM room_turns WHERE room_id = ? ORDER BY created_at, rowid").all(roomId) as { agent_id: string; status: string }[];
const paused = (roomId: string) => {
	const p = (db.prepare("SELECT paused FROM rooms WHERE id = ?").get(roomId) as { paused: string | null }).paused;
	return p ? (JSON.parse(p) as { reason?: string; stopped?: boolean; pending?: unknown[] }) : null;
};
const idle = (roomId: string) => !rooms.stateOf(roomId).running && !turns(roomId).some((t) => t.status === "queued" || t.status === "running");

test("说话中用户发“停”：整个群停下，回合取消，持久停止", async () => {
	const room = rooms.createRoom({ name: "停止群", memberIds: ["sm", "sa"], managerId: "sm" });
	rooms.postUserMessage(room.id, "@阿甲 慢慢做这件事", { mentions: ["sa"] });
	await wait(() => rooms.stateOf(room.id).current?.agentId === "sa", 15000, "阿甲开始发言");
	rooms.postUserMessage(room.id, "停");
	await wait(() => idle(room.id), 15000, "群停下");
	assert.ok(turns(room.id).every((t) => t.status !== "running" && t.status !== "queued"));
	assert.equal(paused(room.id)?.stopped, true, "停止写成持久事实");
});

test("停止后“继续”：重新安排回合并清掉暂停", async () => {
	const room = rooms.createRoom({ name: "继续群", memberIds: ["sm", "sa"], managerId: "sm" });
	rooms.postUserMessage(room.id, "@阿甲 慢慢做", { mentions: ["sa"] });
	await wait(() => rooms.stateOf(room.id).current?.agentId === "sa");
	await rooms.stop(room.id);
	await wait(() => idle(room.id));
	const before = turns(room.id).length;
	assert.equal(rooms.continueRoom(room.id), true);
	assert.equal(paused(room.id), null, "继续清掉暂停");
	await wait(() => turns(room.id).length > before, 5000, "继续后有新回合");
	await rooms.stop(room.id, false);
	await wait(() => idle(room.id));
});

test("说话中用户插话给正在说的人：不另起新回合（交给当前回合）", async () => {
	const room = rooms.createRoom({ name: "插话群", memberIds: ["sm", "sa"], managerId: "sm" });
	rooms.postUserMessage(room.id, "@阿甲 慢慢做", { mentions: ["sa"] });
	await wait(() => rooms.stateOf(room.id).current?.agentId === "sa");
	const n = turns(room.id).length;
	rooms.postUserMessage(room.id, "@阿甲 顺便加一点", { mentions: ["sa"] });
	assert.equal(turns(room.id).length, n, "插话不新建回合");
	assert.equal(rooms.stateOf(room.id).current?.agentId, "sa", "当前回合仍是阿甲");
	await rooms.stop(room.id, false);
	await wait(() => idle(room.id));
});

test("上限暂停：本轮总次数到上限后暂停并保留待发言", async () => {
	const room = rooms.createRoom({ name: "上限群", memberIds: ["sm", "sa", "sb"], managerId: "sm", caps: { maxTurns: 1 } });
	rooms.postUserMessage(room.id, "@阿甲 @阿乙 各说一句", { mentions: ["sa", "sb"] });
	await wait(() => !!paused(room.id), 15000, "上限暂停");
	const p = paused(room.id)!;
	assert.match(p.reason ?? "", /1 次/);
	assert.ok((p.pending ?? []).length >= 1, "没说的成员留在待发言里");
	await wait(() => idle(room.id));
});
