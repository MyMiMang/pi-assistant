import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

test("成员互相 @：只在自主推进中生效；@ 管理者改为唤醒管理者；不 @ 自己", () => {
	const members = [{ id: "cm", name: "总管" }, { id: "ca", name: "小甲" }, { id: "cb", name: "小乙" }];
	const off = logic.planPeerTurns({ fromAgentId: "ca", text: "@小乙 帮我看下", members, managerId: "cm", autonomous: false });
	assert.deepEqual(off, { turns: [], wakeManager: false });
	const on = logic.planPeerTurns({ fromAgentId: "ca", text: "@小乙 帮我看下 @小甲 @总管", members, managerId: "cm", autonomous: true });
	assert.deepEqual(on.turns.map((t) => [t.agentId, t.reason, t.from]), [["cb", "peer", "ca"]]);
	assert.equal(on.wakeManager, true);
	assert.deepEqual(logic.planPeerTurns({ fromAgentId: "cm", text: "@小乙", members, managerId: "cm", autonomous: true }).turns, [], "管理者的 @ 走派活规则");
});

test("看板检查 / 成员互相 @ 不占每轮上限", () => {
	const caps = logic.normalizeCaps({ maxTurns: 1, perAgent: 1 });
	const full = { turns: 5, perAgent: { cm: 5 } };
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

// ---------------------------------------------------------------- 暂停不挡唤醒 / 自主推进接着推进

const roomDone = (roomId: string, reason: string, n: number) => turnsOf(roomId, reason).filter((t) => t.status === "done").length >= n;
const idleHints = (roomId: string) => (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE room_id = ? AND meta LIKE '%room-idle%'").get(roomId) as { n: number }).n;

test("本轮已暂停时唤醒管理者照常进行，暂停时存下的待发言不会放出来；用户停止的群才不唤醒", async () => {
	const room = rooms.createRoom({ name: "暂停唤醒群", memberIds: ["cm", "ca"], managerId: "cm" });
	const pending = [{ agentId: "ca", reason: "assign", depth: 1, task: "写第二节" }];
	db.prepare("UPDATE rooms SET paused = ? WHERE id = ?").run(JSON.stringify({ pending, reason: "这一轮已经发言 8 次" }), room.id);
	replies.set("cm", () => "看过了");
	assert.equal(rooms.wakeManager(room.id, "成员提交了结果"), true, "到上限的暂停不挡唤醒");
	await until(() => roomDone(room.id, "check", 1) && idle(room.id), "暂停中的 check 回合");
	assert.equal(turnsOf(room.id).filter((t) => t.agent_id === "ca").length, 0, "存下的待发言不自动放出来");
	const p = JSON.parse((db.prepare("SELECT paused FROM rooms WHERE id = ?").get(room.id) as { paused: string }).paused) as { pending: unknown[] };
	assert.equal(p.pending.length, 1, "暂停和待发言仍在，等用户点继续");
	await rooms.stop(room.id, false);
	assert.equal(rooms.wakeManager(room.id, "停了不叫"), false, "用户停止过的群不唤醒");
	replies.clear();
	await rooms.deleteRoom(room.id);
});

test("自主推进兜底：管理者回合结束手上没活 → 再叫醒一次；两次之间看板没进展就不再叫，只提示用户；有进展 / 用户发话后恢复", async () => {
	const room = rooms.createRoom({ name: "兜底群", memberIds: ["cm", "ca"], managerId: "cm" });
	replies.set("cm", () => "目标还差第二节");
	rooms.setAutonomy(room.id, { goal: "写报告", doneCriteria: "三节齐全" });
	await until(() => roomDone(room.id, "check", 1) && idle(room.id) && idleHints(room.id) === 1, "开启时的唤醒后提示用户（没有第二次兜底）");
	assert.equal(turnsOf(room.id, "check").length, 1, "开启时那次唤醒算第一次兜底");
	const first = prompts.filter((x) => x.agentId === "cm").pop()!.prompt;
	assert.match(first, /群开着自主推进[\s\S]*work_create[\s\S]*room_goal_done/, "唤醒文案要求接着规划下一步 / 达成就结束");
	// 有进展（任务状态变了）：下一次管理者回合结束可以再兜底一次
	const wi = W.createWorkItem({ roomId: room.id, title: "第一节", requirement: "写", doneCriteria: "有结果", ownerAgentId: "ca", start: false }, { kind: "user" }).item.id;
	db.prepare("UPDATE work_items SET status = 'done' WHERE id = ?").run(wi);
	rooms.wakeManager(room.id, "成员提交了");
	await until(() => roomDone(room.id, "check", 3) && idle(room.id) && idleHints(room.id) === 2, "有进展 → 兜底再叫醒一次，之后无进展 → 再提示");
	assert.ok(prompts.some((x) => x.agentId === "cm" && x.prompt.includes("目标还没完成，手上没有在做的任务")), "兜底唤醒原因写清楚");
	// 有进行中的任务：不兜底
	const doing = W.createWorkItem({ roomId: room.id, title: "第二节", requirement: "写", doneCriteria: "有结果", ownerAgentId: "ca", start: false }, { kind: "user" }).item.id;
	db.prepare("UPDATE work_items SET status = 'active' WHERE id = ?").run(doing);
	rooms.wakeManager(room.id, "看看");
	await until(() => roomDone(room.id, "check", 4) && idle(room.id), "只有这次手动唤醒");
	assert.equal(turnsOf(room.id, "check").length, 4, "手上有在做的任务不兜底");
	// 用户发话重置：任务都了结后又能兜底
	db.prepare("UPDATE work_items SET status = 'cancelled' WHERE id = ?").run(doing);
	rooms.postUserMessage(room.id, "继续推进");
	await until(() => roomDone(room.id, "check", 5) && idle(room.id), "用户发话后兜底恢复");
	// 管理者宣布目标达成后不再兜底
	assert.equal(rooms.endAutonomy(room.id, { achieved: "三节都写完了" }), true);
	rooms.wakeManager(room.id, "收尾");
	await until(() => roomDone(room.id, "check", 6) && idle(room.id), "达成后的最后一次唤醒");
	assert.equal(turnsOf(room.id, "check").length, 6, "结束自主推进后不兜底");
	assert.ok(db.prepare("SELECT 1 FROM messages WHERE room_id = ? AND content LIKE '目标已达成%三节都写完了%'").get(room.id));
	replies.clear();
	await rooms.deleteRoom(room.id);
});

test("定时检查：开着自主推进的群没有未完成任务也纳入", async () => {
	const room = rooms.createRoom({ name: "定时自主群", memberIds: ["cm"], managerId: "cm" });
	replies.set("cm", () => "收到");
	rooms.setAutonomy(room.id, { goal: "写报告", doneCriteria: "三节齐全" });
	await until(() => roomDone(room.id, "check", 1) && idle(room.id) && idleHints(room.id) === 1, "开启时的唤醒，没进展 → 提示过用户");
	rooms.runRoomChecks(now() + 10 * 60 * 60_000, 60_000);
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(turnsOf(room.id, "check").length, 1, "提示过用户、看板没动：定时检查不再叫醒空转");
	// 看板有变化（比如用户在看板上建了任务又完成）：定时检查照常叫醒
	const wi = W.createWorkItem({ roomId: room.id, title: "第一节", requirement: "写", doneCriteria: "有结果", ownerAgentId: "cm", start: false }, { kind: "user" }).item.id;
	db.prepare("UPDATE work_items SET status = 'done' WHERE id = ?").run(wi);
	assert.ok(rooms.runRoomChecks(now() + 20 * 60 * 60_000, 60_000) >= 1);
	await until(() => roomDone(room.id, "check", 2) && idle(room.id), "定时检查跑完");
	assert.ok(prompts.some((x) => x.agentId === "cm" && /定时检查：目标还没完成/.test(x.prompt)), "定时检查的唤醒原因写清目标还没完成");
	await until(() => idle(room.id), "之后的兜底（看板有了新进展）也跑完");
	rooms.endAutonomy(room.id);
	replies.clear();
	await rooms.deleteRoom(room.id);
});

test("idleWakeStep：只有自主推进开着、手上没活、队列空才兜底；同一个看板指纹不再叫醒，只提示一次", () => {
	const base = { autonomous: true, inFlight: false, queued: false, lastSig: null, sig: "a", hinted: false };
	assert.equal(logic.idleWakeStep(base), "wake");
	assert.equal(logic.idleWakeStep({ ...base, autonomous: false }), "none");
	assert.equal(logic.idleWakeStep({ ...base, inFlight: true }), "none");
	assert.equal(logic.idleWakeStep({ ...base, queued: true }), "none");
	assert.equal(logic.idleWakeStep({ ...base, lastSig: "b" }), "wake", "有新进展");
	assert.equal(logic.idleWakeStep({ ...base, lastSig: "a" }), "hint", "没有新进展：提示用户");
	assert.equal(logic.idleWakeStep({ ...base, lastSig: "a", hinted: true }), "none", "提示过不再重复");
});

test("room_goal_done：只有管理者在自主推进中能宣布目标达成，结束自主推进并把总结发到群里", async () => {
	const room = rooms.createRoom({ name: "达成群", memberIds: ["cm", "ca"], managerId: "cm" });
	const { roomTools } = await import("../src/rooms/tools.ts");
	const toolsOf = (agentId: string) => {
		const defs = new Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }>();
		roomTools(room.id, agentId)({ registerTool: (d: unknown) => defs.set((d as { name: string }).name, d as never) });
		return defs;
	};
	const done = (agentId: string, summary: string) => toolsOf(agentId).get("room_goal_done")!.execute("t", { summary }).then((r) => r.content[0].text);
	assert.match(await done("ca", "完成了"), /只有管理者/);
	assert.match(await done("cm", "完成了"), /没有开着自主推进/);
	rooms.setAutonomy(room.id, { goal: "写报告", doneCriteria: "三节齐全" });
	assert.match(await done("cm", " "), /结果总结/);
	assert.equal(rooms.getAutonomy(room.id)?.goal, "写报告");
	assert.match(await done("cm", "三节都写完了，在 report.md"), /已结束自主推进/);
	assert.equal(rooms.getAutonomy(room.id), null);
	assert.ok(db.prepare("SELECT 1 FROM messages WHERE room_id = ? AND content LIKE '目标已达成%三节都写完了，在 report.md%'").get(room.id));
	await until(() => idle(room.id), "开启时的唤醒结束");
	await rooms.deleteRoom(room.id);
});

// ---------------------------------------------------------------- room_assign 的附件真的交给负责人

test("room_assign 附件：按文件名（也接受路径、同名取最新）找到并放进负责人工作区，任务文字带路径；找不到就不派出", async () => {
	const { saveRoomUpload, workspaceOf } = await import("../src/files.ts");
	const { insertMessage } = await import("../src/messages.ts");
	const { findRoomFile } = await import("../src/rooms/tools.ts");
	const { roomTools } = await import("../src/rooms/tools.ts");
	const room = rooms.createRoom({ name: "附件群", memberIds: ["cm", "ca", "cb"], managerId: "cm" });
	const put = (name: string, body: string) => {
		const f = saveRoomUpload(room.id, name, Buffer.from(body));
		insertMessage({ agentId: "", roomId: room.id, conversationId: null, role: "user", content: `发了 ${name}`, meta: { attachments: [{ fileId: f.id, name: f.name }] } });
		return f;
	};
	const old = put("脚本.md", "旧版");
	db.prepare("UPDATE files SET created_at = created_at - 1000 WHERE id = ?").run(old.id);
	const fresh = put("脚本.md", "新版");
	put("分镜.md", "分镜内容");
	const files = rooms.roomFiles(room.id);
	assert.equal(findRoomFile(files, "脚本.md")?.id, fresh.id, "同名取最新");
	assert.equal(findRoomFile(files, "deliverables/分镜.md")?.name, "分镜.md", "只给了路径：取最后一段");
	assert.equal(findRoomFile(files, `room-files/x/${fresh.id.slice(-6)}-脚本.md`)?.id, fresh.id, "工作区里的带前缀名也认");
	assert.equal(findRoomFile(files, "不存在.md"), undefined);

	const toolsOf = (agentId: string) => {
		const defs = new Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }>();
		roomTools(room.id, agentId)({ registerTool: (d: unknown) => defs.set((d as { name: string }).name, d as never) });
		return defs;
	};
	// 长期任务那条路：负责人的任务会话拿得到文件
	const wi = W.createWorkItem({ roomId: room.id, title: "写分镜", requirement: "按脚本写分镜", doneCriteria: "有分镜表", ownerAgentId: "cb", start: false }, { kind: "user" }).item.id;
	let result: Promise<{ content: { text: string }[] }> | null = null;
	replies.set("cm", () => {
		result = toolsOf("cm").get("room_assign")!.execute("t", {
			assignments: [
				{ agent: "小甲", task: "改脚本", files: ["脚本.md"] },
				{ agent: "小乙", task: "写分镜", files: ["分镜.md"], workItemId: wi },
				{ agent: "小乙", task: "再写一份", files: ["分镜.md", "漏掉的.md"], workItemId: wi },
			],
		});
		return "分好了";
	});
	rooms.postUserMessage(room.id, "开工");
	await until(() => result !== null, "管理者调用 room_assign");
	const text = (await result!).content[0].text;
	assert.match(text, /这些没有派出[\s\S]*小乙：找不到附件 漏掉的\.md（群里没有这个文件，先让产出者把文件发到群里）/);
	assert.match(text, /已分配给：小甲、小乙/);
	await until(() => turnsOf(room.id, "assign").some((t) => t.agent_id === "ca" && t.status === "done") && idle(room.id), "小甲的普通派活跑完");
	const assignPrompt = prompts.filter((x) => x.agentId === "ca").pop()!.prompt;
	const rel = assignPrompt.match(/相关附件（已放进你的工作区）：(room-files\/\S+?-脚本\.md)/)?.[1];
	assert.ok(rel, "任务文字里写了工作区路径");
	assert.equal(readFileSync(join(workspaceOf("ca"), rel!), "utf8"), "新版", "放进去的是最新的同名文件");
	// 长期任务：派出的那一条文件已在负责人工作区，没派出的（找不到附件）那条没有建新 run
	const runs = db.prepare("SELECT task FROM work_item_runs WHERE work_item_id = ?").all(wi) as { task: string }[];
	assert.ok(runs.length >= 1 && runs.every((r) => !r.task.includes("再写一份")), "找不到附件的那条没有派出");
	const relB = runs[0].task.match(/相关附件（已放进你的工作区）：(room-files\/\S+?-分镜\.md)/)?.[1];
	assert.ok(relB, "长期任务的任务文字也带路径");
	assert.equal(readFileSync(join(workspaceOf("cb"), relB!), "utf8"), "分镜内容");
	replies.clear();
	await W.cancelWorkItem({ workItemId: wi, actor: { kind: "user" } }).catch(() => {});
	await rooms.deleteRoom(room.id);
});
