import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 群聊协作（docs/design/group-collaboration.md）：纯逻辑 + 真实群调度。
 * 模型回合用可控的假 turn（不起模型、不付费）：每个成员的回复由测试按 agentId 指定，只读写临时数据目录。
 */
const { db, now } = await import("../src/db.ts");
const R = await import("../src/runtime.ts");
const rooms = await import("../src/rooms/index.ts");
const logic = await import("../src/rooms/logic.ts");
const W = await import("../src/work-items.ts");

const replies = new Map<string, (prompt: string) => string>();
const prompts: { agentId: string; prompt: string }[] = [];
const proto = Object.getPrototypeOf(R.runtime("cm", "conv_probe")) as Record<string, unknown>;
proto.turn = async function (this: { id: string; conversationId: string }, prompt: string) {
	prompts.push({ agentId: this.id, prompt });
	if (W.execOf(this.conversationId)) return new Promise(() => {}); // 任务会话：这里不关心，挂着
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

const mkAgent = (id: string, name: string) => db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run(id, name, "A", "#111", now());
mkAgent("cm", "总管");
mkAgent("ca", "小甲");
mkAgent("cb", "小乙");

// ---------------------------------------------------------------- 纯逻辑

test("看板分组：等你决定 > 卡住 > 进行中；暂停 / 取消 = 已停止", () => {
	const esc = { kind: "stall" as const, level: "manager" as const, at: 1, note: "x" };
	assert.equal(W.boardGroupOf({ status: "active", needsUser: false, escalation: null }), "doing");
	assert.equal(W.boardGroupOf({ status: "review", needsUser: false, escalation: null }), "doing");
	assert.equal(W.boardGroupOf({ status: "active", needsUser: false, escalation: esc }), "stuck");
	assert.equal(W.boardGroupOf({ status: "blocked", needsUser: false, escalation: null }), "stuck");
	assert.equal(W.boardGroupOf({ status: "blocked", needsUser: true, escalation: esc }), "decision");
	assert.equal(W.boardGroupOf({ status: "done", needsUser: true, escalation: null }), "done");
	assert.equal(W.boardGroupOf({ status: "paused", needsUser: false, escalation: null }), "stopped");
	assert.equal(W.boardGroupOf({ status: "cancelled", needsUser: false, escalation: null }), "stopped");
});

test("指纹：忽略数字 / 路径 / 编号 / 标点；太短的泛泛说法不算", () => {
	assert.equal(W.fingerprint("连接 api 超时（第 3 次） /tmp/a.log wi_abc1"), W.fingerprint("连接 api 超时，第 7 次！ /var/b.log wi_zz9"));
	assert.notEqual(W.fingerprint("连接 api 超时"), W.fingerprint("磁盘空间不足"));
	assert.equal(W.fingerprint("失败"), "");
	assert.equal(W.repeatLevel([], "abcd"), null);
	assert.equal(W.repeatLevel(["abcd"], "abcd"), "manager");
	assert.equal(W.repeatLevel(["abcd", "x", "abcd"], "abcd"), "user");
	assert.equal(W.repeatLevel(["abcd"], ""), null);
});

test("卡住检测：超时先管理者，管理者介入后仍没动静再用户；有新动静重新计时", () => {
	const base = { status: "active", needsUser: false, stallMs: 100 };
	assert.equal(W.stallStep({ ...base, lastActivityAt: 0, escalation: null, now: 50 }), null);
	assert.equal(W.stallStep({ ...base, lastActivityAt: 0, escalation: null, now: 100 }), "manager");
	const esc = { kind: "stall" as const, level: "manager" as const, at: 100, note: "" };
	assert.equal(W.stallStep({ ...base, lastActivityAt: 0, escalation: esc, now: 150 }), null, "刚叫过管理者，等它处理");
	assert.equal(W.stallStep({ ...base, lastActivityAt: 0, escalation: esc, now: 200 }), "user");
	assert.equal(W.stallStep({ ...base, lastActivityAt: 180, escalation: esc, now: 200 }), null, "管理者之后有动静：重新计时");
	assert.equal(W.stallStep({ ...base, lastActivityAt: 0, escalation: { ...esc, level: "user" }, now: 999 }), null, "已经问过用户不重复");
	assert.equal(W.stallStep({ ...base, status: "paused", lastActivityAt: 0, escalation: null, now: 999 }), null);
	assert.equal(W.stallStep({ ...base, needsUser: true, lastActivityAt: 0, escalation: null, now: 999 }), null);
});

test("成员互相 @：只在自主推进中生效；@ 管理者改为唤醒管理者；不 @ 自己", () => {
	const members = [{ id: "cm", name: "总管" }, { id: "ca", name: "小甲" }, { id: "cb", name: "小乙" }];
	const off = logic.planPeerTurns({ fromAgentId: "ca", text: "@小乙 帮我看下", members, managerId: "cm", autonomous: false });
	assert.deepEqual(off, { turns: [], wakeManager: false });
	const on = logic.planPeerTurns({ fromAgentId: "ca", text: "@小乙 帮我看下 @小甲 @总管", members, managerId: "cm", autonomous: true });
	assert.deepEqual(on.turns.map((t) => [t.agentId, t.reason, t.from]), [["cb", "peer", "ca"]]);
	assert.equal(on.wakeManager, true);
	assert.deepEqual(logic.planPeerTurns({ fromAgentId: "cm", text: "@小乙", members, managerId: "cm", autonomous: true }).turns, [], "管理者的 @ 走派活规则");
});

test("只聊不干活：到阈值先管理者，两倍阈值再用户；有进展清零", () => {
	let s = 0;
	const levels: (string | null)[] = [];
	for (let i = 0; i < 6; i++) {
		const r = logic.chatterStep(s, { progressed: false, threshold: 3 });
		s = r.streak;
		levels.push(r.level);
	}
	assert.deepEqual(levels, [null, null, "manager", null, null, "user"]);
	assert.deepEqual(logic.chatterStep(5, { progressed: true, threshold: 3 }), { streak: 0, level: null });
});

test("看板检查 / 成员互相 @ 不占每轮上限", () => {
	const caps = logic.normalizeCaps({ maxTurns: 1, perAgent: 1 });
	const full = { turns: 5, perAgent: { cm: 5 }, tokens: 0 };
	assert.ok(logic.capCheck({ agentId: "cm", reason: "manager", depth: 0 }, full, caps));
	assert.equal(logic.capCheck({ agentId: "cm", reason: "check", depth: 0 }, full, caps), null);
	assert.equal(logic.capCheck({ agentId: "ca", reason: "peer", depth: 0 }, full, caps), null);
});

// ---------------------------------------------------------------- 真实群调度

test("开启自主推进：群里有说明、roomJson 带目标、管理者被唤醒读看板；结束后回到普通模式", async () => {
	const room = rooms.createRoom({ name: "自主群", memberIds: ["cm", "ca", "cb"], managerId: "cm" });
	assert.throws(() => rooms.setAutonomy(room.id, { goal: "做报告" }), /完成标准/);
	rooms.setAutonomy(room.id, { goal: "做季度报告", doneCriteria: "三节齐全、每个结论有来源" });
	assert.deepEqual(
		{ goal: rooms.roomJson(rooms.getRoom(room.id)!).autonomy?.goal, done: rooms.roomJson(rooms.getRoom(room.id)!).autonomy?.doneCriteria },
		{ goal: "做季度报告", done: "三节齐全、每个结论有来源" },
	);
	await until(() => turnsOf(room.id, "check").some((t) => t.status === "done"), "管理者被唤醒");
	const p = prompts.filter((x) => x.agentId === "cm").pop()!.prompt;
	assert.match(p, /任务看板有变化/);
	assert.match(p, /自主推进目标：做季度报告/);
	assert.match(p, /任务看板：还没有长期任务/);
	assert.ok(db.prepare("SELECT 1 FROM messages WHERE room_id = ? AND content LIKE '已开启自主推进%'").get(room.id));
	assert.equal(rooms.endAutonomy(room.id), true);
	assert.equal(rooms.roomJson(rooms.getRoom(room.id)!).autonomy, null);
	await rooms.deleteRoom(room.id);
});

test("自主推进中成员 @ 别的成员：被 @ 的醒来回复；普通模式下不触发", async () => {
	const room = rooms.createRoom({ name: "互相@群", memberIds: ["cm", "ca", "cb"], managerId: "cm" });
	replies.set("ca", () => "我做完第一节了，@小乙 你帮我核一下数据");
	replies.set("cb", () => "好的，数据没问题");
	rooms.postUserMessage(room.id, "@小甲 写第一节", { mentions: ["ca"] });
	await until(() => idle(room.id) && turnsOf(room.id).length >= 1, "普通模式回合");
	assert.equal(turnsOf(room.id, "peer").length, 0, "普通模式成员 @ 不叫醒别人");
	rooms.setAutonomy(room.id, { goal: "写报告", doneCriteria: "三节齐全" });
	await until(() => idle(room.id), "唤醒结束");
	rooms.postUserMessage(room.id, "@小甲 再写第二节", { mentions: ["ca"] });
	await until(() => turnsOf(room.id, "peer").some((t) => t.agent_id === "cb" && t.status === "done"), "小乙被叫醒");
	const p = prompts.filter((x) => x.agentId === "cb").pop()!.prompt;
	assert.match(p, /小甲 在群里 @ 了你/);
	replies.clear();
	await until(() => idle(room.id), "安静下来");
	await rooms.deleteRoom(room.id);
});

test("只聊不干活：成员来回 @ 没进展 → 先叫管理者，再提醒用户并暂停互相叫醒；用户发话后恢复", async () => {
	process.env.PIA_ROOM_CHATTER = "2";
	const room = rooms.createRoom({ name: "空聊群", memberIds: ["cm", "ca", "cb"], managerId: "cm" });
	rooms.setAutonomy(room.id, { goal: "写报告", doneCriteria: "三节齐全" });
	await until(() => idle(room.id), "唤醒结束");
	replies.set("ca", () => "@小乙 你觉得呢");
	replies.set("cb", () => "@小甲 我觉得都行");
	rooms.postUserMessage(room.id, "@小甲 开始吧", { mentions: ["ca"] });
	await until(() => !!db.prepare("SELECT 1 FROM messages WHERE room_id = ? AND meta LIKE '%room-chatter%'").get(room.id), "提醒用户", 5000);
	await until(() => idle(room.id), "暂停互相叫醒后安静下来", 5000);
	const peers = turnsOf(room.id, "peer").length;
	assert.equal(peers, 4, "两倍阈值后不再互相叫醒");
	assert.ok(prompts.some((x) => x.agentId === "cm" && /只聊不干活/.test(x.prompt)), "先叫过管理者");
	replies.clear();
	delete process.env.PIA_ROOM_CHATTER;
	await rooms.deleteRoom(room.id);
});

test("唤醒管理者：群已停止不唤醒；未轮到的唤醒合并成一次；定时检查只找有未完成任务的群", async () => {
	const room = rooms.createRoom({ name: "唤醒群", memberIds: ["cm", "ca"], managerId: "cm" });
	W.createWorkItem({ roomId: room.id, title: "待做", requirement: "写", doneCriteria: "有结果", ownerAgentId: "ca", start: false }, { kind: "user" });
	db.prepare("UPDATE work_items SET status = 'active' WHERE room_id = ?").run(room.id);
	await rooms.stop(room.id, false);
	assert.equal(rooms.wakeManager(room.id, "停了也想叫"), false);
	db.prepare("UPDATE rooms SET paused = NULL WHERE id = ?").run(room.id);
	// 管理者正在说话时连续两次唤醒：只排一个 check
	replies.set("cm", () => "收到");
	rooms.postUserMessage(room.id, "看看进度");
	rooms.wakeManager(room.id, "原因一");
	rooms.wakeManager(room.id, "原因二");
	await until(() => idle(room.id), "跑完");
	const checks = turnsOf(room.id, "check");
	assert.equal(checks.length, 1, "合并成一次");
	const p = prompts.filter((x) => x.agentId === "cm").pop()!.prompt;
	assert.match(p, /原因一[\s\S]*原因二/);
	const empty = rooms.createRoom({ name: "没任务的群", memberIds: ["cm"], managerId: "cm" });
	const n = rooms.runRoomChecks(now() + 10 * 60 * 60_000, 60_000);
	assert.equal(n, 1, "只有有未完成任务的群被定时检查");
	await until(() => idle(room.id), "定时检查跑完");
	assert.equal(turnsOf(empty.id, "check").length, 0);
	replies.clear();
	await rooms.deleteRoom(room.id);
	await rooms.deleteRoom(empty.id);
});

test("room_goal：管理者提议目标 + 完成标准，发确认卡片；成员没有这个能力", async () => {
	const room = rooms.createRoom({ name: "目标群", memberIds: ["cm", "ca"], managerId: "cm" });
	const { roomTools } = await import("../src/rooms/tools.ts");
	const toolsOf = (agentId: string) => {
		const defs = new Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }>();
		roomTools(room.id, agentId)({ registerTool: (d: unknown) => defs.set((d as { name: string }).name, d as never) });
		return defs;
	};
	rooms.memberConversation(room.id, "cm");
	assert.match((await toolsOf("ca").get("room_goal")!.execute("t", { goal: "x", doneCriteria: "y" })).content[0].text, /只有管理者/);
	assert.match((await toolsOf("cm").get("room_goal")!.execute("t", { goal: "做报告", doneCriteria: "" })).content[0].text, /都要写清楚/);
	assert.match((await toolsOf("cm").get("room_goal")!.execute("t", { goal: "做报告", doneCriteria: "三节齐全" })).content[0].text, /确认卡片/);
	const card = db.prepare("SELECT meta, room_id FROM messages WHERE room_id = ? AND role = 'card' ORDER BY rowid DESC LIMIT 1").get(room.id) as { meta: string; room_id: string };
	assert.equal(JSON.parse(card.meta).kind, "room-goal");
	assert.equal(JSON.parse(card.meta).status, "pending");
	assert.equal(rooms.getAutonomy(room.id), null, "确认前不开启");
	await rooms.deleteRoom(room.id);
});
