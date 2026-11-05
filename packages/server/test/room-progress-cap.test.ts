import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 群聊按「有没有新进展」决定停不停（决策 0029）：纯逻辑 + 真实群调度。
 * 模型回合用可控的假 turn（不起模型、不付费），只读写临时数据目录；成员「发文件」直接往群里插一条带附件的消息（等同 deliver_file 的落库结果）。
 */
const { db, now, uid } = await import("../src/db.ts");
const R = await import("../src/runtime.ts");
const rooms = await import("../src/rooms/index.ts");
const logic = await import("../src/rooms/logic.ts");
const { insertMessage } = await import("../src/messages.ts");
const { fileInfo } = await import("../src/files.ts");

const replies = new Map<string, (prompt: string) => string>();
const prompts: { agentId: string; prompt: string }[] = [];
const proto = Object.getPrototypeOf(R.runtime("pm", "conv_probe")) as Record<string, unknown>;
proto.turn = async function (this: { id: string }, prompt: string) {
	prompts.push({ agentId: this.id, prompt });
	return { ok: true, aborted: false, text: replies.get(this.id)?.(prompt) ?? "", tokens: 0 };
};
proto.abort = async () => {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, what: string, ms = 3000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (fn()) return;
		await sleep(10);
	}
	throw new Error(`${what}超时`);
};
const turnsOf = (roomId: string, reason?: string) => db.prepare(`SELECT agent_id, reason, status FROM room_turns WHERE room_id = ? ${reason ? "AND reason = ?" : ""} ORDER BY created_at, rowid`).all(...([roomId, ...(reason ? [reason] : [])] as never[])) as { agent_id: string; reason: string; status: string }[];
const idle = (roomId: string) => !rooms.stateOf(roomId).running;
const settled = async (roomId: string) => {
	await until(() => idle(roomId), "群安静下来");
	await sleep(50);
	await until(() => idle(roomId), "群安静下来");
};
const sysOf = (roomId: string, kind: string) => db.prepare("SELECT content FROM messages WHERE room_id = ? AND meta LIKE ?").all(roomId, `%"kind":"${kind}"%`) as { content: string }[];

const mkAgent = (id: string, name: string) => db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run(id, name, "A", "#111", now());
mkAgent("pm", "总管");
mkAgent("pa", "小甲");
mkAgent("pb", "小乙");

/** 成员把一个文件发进群（files 表一行 + 群里一条带附件的消息，和 deliver_file 落库的样子一样） */
function postFile(roomId: string, agentId: string, name: string) {
	const conv = rooms.memberConversation(roomId, agentId);
	const row = { id: uid("f"), agent_id: agentId, name, mime: "text/plain", size: 1, stored_path: "/dev/null", workspace_path: name, direction: "out", created_at: now() };
	db.prepare("INSERT INTO files(id, agent_id, name, mime, size, stored_path, workspace_path, direction, created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(row.id, row.agent_id, row.name, row.mime, row.size, row.stored_path, row.workspace_path, row.direction, row.created_at);
	insertMessage({ agentId, conversationId: conv, role: "assistant", content: `${name} 做好了`, meta: { attachments: [fileInfo(row)] } });
}

// ---------------------------------------------------------------- 纯逻辑

test("progressSig：只看任务状态和群里文件数，不看派活回合数", () => {
	const items = [{ id: "wi_1", status: "active" }];
	const a = logic.progressSig({ items, files: 2 });
	assert.equal(a, logic.progressSig({ items: [{ id: "wi_1", status: "active" }], files: 2 }), "同样的产出同样的指纹");
	assert.notEqual(logic.progressSig({ items, files: 3 }), a, "群里多了一个文件算进展");
	assert.notEqual(logic.progressSig({ items: [{ id: "wi_1", status: "done" }], files: 2 }), a, "任务状态变了算进展");
	assert.equal((logic.progressSig as (o: object) => string)({ items, files: 2, plainAssignsDone: 9 }), a, "派活回合数不进指纹");
});

test("capOrProgress：没到上限照常；到上限有新进展接着推进；没进展（或还没记下起点）暂停", () => {
	assert.equal(logic.capOrProgress(null, "a", "b"), "ok");
	assert.equal(logic.capOrProgress("这一轮已经发言 8 次", "a", "b"), "continue");
	assert.equal(logic.capOrProgress("这一轮已经发言 8 次", "a", "a"), "pause");
	assert.equal(logic.capOrProgress("这一轮已经发言 8 次", null, "a"), "pause");
});

test("idleWakeStep：没有项目但用户上次发话以来成员交回过活也兜底；纯聊天不兜底", () => {
	const base = { projectActive: false, workSinceUser: true, inFlight: false, queued: false, lastSig: null, sig: "a", hinted: false };
	assert.equal(logic.idleWakeStep(base), "wake");
	assert.equal(logic.idleWakeStep({ ...base, workSinceUser: false }), "none", "没派过活（纯聊天）不叫醒");
	assert.equal(logic.idleWakeStep({ ...base, lastSig: "a" }), "hint", "两次之间没进展：只提示");
	assert.equal(logic.idleWakeStep({ ...base, lastSig: "a", hinted: true }), "none");
	assert.equal(logic.idleWakeStep({ ...base, waitingUser: true }), "none");
	assert.equal(logic.idleWakeStep({ ...base, queued: true }), "none");
});

// ---------------------------------------------------------------- 真实群调度：上限

test("到上限但这一轮有新进展（群里新发了文件）：不暂停，计数清零接着跑", async () => {
	const room = rooms.createRoom({ name: "有进展群", memberIds: ["pm", "pa", "pb"], managerId: "pm", caps: { maxTurns: 1 } });
	replies.set("pa", () => (postFile(room.id, "pa", "第一节.md"), "第一节写好了"));
	replies.set("pb", () => "第二节写好了");
	rooms.postUserMessage(room.id, "@小甲 @小乙 各写一节", { mentions: ["pa", "pb"] });
	await settled(room.id);
	assert.equal(sysOf(room.id, "room-paused").length, 0, "有进展不出「本轮已暂停」");
	assert.equal(rooms.getRoom(room.id)!.paused, null);
	assert.deepEqual(turnsOf(room.id).map((t) => [t.agent_id, t.status]), [["pa", "done"], ["pb", "done"]], "第二位照常发言");
	replies.clear();
	await rooms.deleteRoom(room.id);
});

test("到上限且这一轮没有新进展：照旧暂停，没说的留着等继续", async () => {
	const room = rooms.createRoom({ name: "没进展群", memberIds: ["pm", "pa", "pb"], managerId: "pm", caps: { maxTurns: 1 } });
	replies.set("pa", () => "我想想");
	rooms.postUserMessage(room.id, "@小甲 @小乙 各写一节", { mentions: ["pa", "pb"] });
	await settled(room.id);
	assert.equal(sysOf(room.id, "room-paused").length, 1);
	const p = JSON.parse(rooms.getRoom(room.id)!.paused!) as { reason: string; pending: { agentId: string }[] };
	assert.match(p.reason, /1 次/);
	assert.deepEqual(p.pending.map((x) => x.agentId), ["pb"]);
	replies.clear();
	await rooms.deleteRoom(room.id);
});

// ---------------------------------------------------------------- 真实群调度：没有项目也接着推进

test("没有项目：成员交回成果后叫醒管理者安排下一步；两次之间没进展只提示一次（不提项目）；用户发话后重新计算", async () => {
	const room = rooms.createRoom({ name: "接着推进群", memberIds: ["pm", "pa"], managerId: "pm" });
	let round = 0;
	replies.set("pm", (p) => {
		if (p.includes(logic.WORK_IDLE_WAKE)) return ++round === 1 ? "@小甲 接着写第二节" : "都做完了：两节都写好了";
		if (/成员都已结束/.test(p)) return "收到";
		return "@小甲 写第一节";
	});
	replies.set("pa", () => (postFile(room.id, "pa", `第${turnsOf(room.id, "assign").length}节.md`), "写好了"));
	rooms.postUserMessage(room.id, "写一份两节的报告");
	await settled(room.id);
	const checks = turnsOf(room.id, "check");
	assert.equal(checks.length, 2, "第一次叫醒派了活、交回了新文件 → 有进展再叫一次；第二次没进展就停");
	assert.equal(turnsOf(room.id, "assign").filter((t) => t.status === "done").length, 2, "叫醒后派的活照常做了");
	const hints = sysOf(room.id, "room-idle");
	assert.equal(hints.length, 1, "没进展只提示一次");
	assert.ok(!hints[0].content.includes("项目"), "没有项目时提示不提项目");
	assert.match(hints[0].content, /没有新的成果/);
	assert.ok(prompts.some((x) => x.agentId === "pm" && x.prompt.includes(logic.WORK_IDLE_WAKE)), "叫醒原因用非项目的文案");
	assert.ok(!prompts.some((x) => x.agentId === "pm" && x.prompt.includes(logic.PROJECT_IDLE_WAKE)), "不说项目还没完成");
	// 用户发话：重新计算，成员再交活后又能叫醒
	round = 1;
	rooms.postUserMessage(room.id, "再补一节");
	await settled(room.id);
	assert.equal(turnsOf(room.id, "check").length, 3, "用户发话后兜底恢复");
	replies.clear();
	await rooms.deleteRoom(room.id);
});

test("没有项目：纯聊天（管理者自己答、没派活）不叫醒；本轮已暂停时也不自己叫醒", async () => {
	const room = rooms.createRoom({ name: "聊天群", memberIds: ["pm", "pa"], managerId: "pm" });
	replies.set("pm", () => "你好呀");
	rooms.postUserMessage(room.id, "你好");
	await settled(room.id);
	assert.equal(turnsOf(room.id, "check").length, 0, "没派过活不兜底");
	assert.equal(sysOf(room.id, "room-idle").length, 0);
	// 派过活但群停在「本轮已暂停」：等用户回复继续，不自己叫醒
	replies.set("pm", (p) => (/成员都已结束/.test(p) ? "收到" : "@小甲 写一节"));
	replies.set("pa", () => "写好了");
	db.prepare("UPDATE rooms SET paused = ? WHERE id = ?").run(JSON.stringify({ pending: [], reason: "这一轮已经发言 8 次" }), room.id);
	rooms.wakeManager(room.id, "看看");
	await settled(room.id);
	assert.equal(turnsOf(room.id, "check").length, 1, "只有手动这一次，暂停中不兜底");
	replies.clear();
	await rooms.deleteRoom(room.id);
});
