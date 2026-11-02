import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

/**
 * 让助理真的主动做事（决策 0025）：巡检看得见群、群成员也算巡检对象、proactive_advance 能在群里推进、
 * 三种模式（自动 / 试运行 / 关）、规则研判校验、判断记录。临时数据 + Mock 模型 + 内存凭据，不碰生产数据。
 */
process.env.PIA_MOCK = "1";
const { db, now, uid } = await import("../src/db.ts");
const { initModels } = await import("../src/models.ts");
await initModels(memoryCredentialStore());
const rooms = await import("../src/rooms/index.ts");
const P = await import("../src/proactive.ts");
const A = await import("../src/proactive-advance.ts");
const J = await import("../src/proactive-judge.ts");
const L = await import("../src/proactive-log.ts");
const R = await import("../src/proactive-rules.ts");
const { ROOM_LIMITS } = await import("../src/proactive-room.ts");
await import("../src/subagents.ts");
const { memberConversation } = await import("../src/rooms/store.ts");
const { createConversation } = await import("../src/conversations.ts");

const T = (d: number, h: number, m = 0) => Date.UTC(2026, 9, d, h - 8, m);
const NOW = T(12, 10); // 周一 10:00（Asia/Shanghai），非免打扰
for (const [id, name] of [["gm", "总管"], ["ga", "阿甲"], ["gz", "老手"]]) db.prepare("INSERT INTO agents(id, name, avatar, color, model_provider, model_id, created_at) VALUES(?,?,?,?,?,?,?)").run(id, name, "A", "#111", "mock", "echo", now());
const spawned: { agentId: string; instructions: string }[] = [];
let seq = 0;
P.setProactiveSpawner((agentId, title, instructions, opts) => {
	const id = `gt${++seq}`;
	db.prepare("INSERT INTO subagents(id, agent_id, conversation_id, task, context, model_provider, model_id, model_reason, status, last_activity_at, created_at, kind, title) VALUES(?,?,?,'x','','mock','echo','','running',?,?,?,?)").run(id, agentId, opts.conversationId, now(), now(), opts.kind, title);
	spawned.push({ agentId, instructions });
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
const userSay = (roomId: string, text: string, at = NOW - 3600_000) => db.prepare("INSERT INTO messages(id, agent_id, conversation_id, room_id, role, content, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(uid("m"), "", null, roomId, "user", text, "done", at, at);
const mkRoom = (name: string) => rooms.createRoom({ name, memberIds: ["gm", "ga"], managerId: "gm" });
const reset = () => {
	for (const t of ["proactive_followups", "proactive_runs", "proactive_items", "proactive_judgments", "proactive_advances", "proactive_signals"]) db.prepare(`DELETE FROM ${t}`).run();
	spawned.length = 0;
	P.saveProactive("gm", { level: "off" }); // 只看 ga；管理者不参与巡检
	P.saveProactive("gz", { level: "off" });
	P.saveProactive("ga", { level: "normal", cfg: { quiet: null, weekdaysOnly: false, autonomy: "auto", rules: [] } });
};
const RULE = { id: "r1", text: "报告类任务卡住超过半天，可以直接重跑一次", enabled: true };
const advIn = (roomId: string, extra: Record<string, unknown> = {}) => ({ roomId, kind: "followup", title: "把周报导出", body: "周报导出卡住了，重跑一次", importance: 3, dedupeKey: uid("k"), explicit: true, evidence: "用户说：周五前把周报导出", ruleAssessments: [], ...extra }) as Parameters<typeof J.advanceForHeartbeat>[1];

test("规则研判校验（纯逻辑）：缺研判 / 未知 id / 重复 id / 没写理由 / 缺依据拒；放行判断", () => {
	const rules = R.normalizeRules([{ text: "A 规则" }, { id: "r2", text: "B 规则", enabled: false }]);
	assert.equal(rules.length, 2);
	assert.match(rules[0].id, /^r_/);
	assert.throws(() => R.normalizeRules([{ id: "x", text: "a" }, { id: "x", text: "b" }]), /重复/);
	assert.throws(() => R.normalizeRules(Array.from({ length: 21 }, (_, i) => ({ text: `r${i}` }))), /最多/);
	const id = rules[0].id;
	assert.match((R.judgeRules(rules, { explicit: true, evidence: "原话", ruleAssessments: [] }) as { error: string }).error, /缺少对这些规则的研判/);
	assert.match((R.judgeRules(rules, { ruleAssessments: [{ ruleId: "nope", matched: true, reason: "xx" }] }) as { error: string }).error, /不存在/);
	assert.match((R.judgeRules(rules, { ruleAssessments: [{ ruleId: "r2", matched: true, reason: "xx" }] }) as { error: string }).error, /已停用/);
	assert.match((R.judgeRules(rules, { ruleAssessments: [{ ruleId: id, matched: false, reason: "无关" }, { ruleId: id, matched: false, reason: "又写" }] }) as { error: string }).error, /不止一条/);
	assert.match((R.judgeRules(rules, { ruleAssessments: [{ ruleId: id, matched: false, reason: "" }] }) as { error: string }).error, /缺少理由/);
	assert.match((R.judgeRules(rules, { explicit: true, evidence: "", ruleAssessments: [{ ruleId: id, matched: false, reason: "没对上" }] }) as { error: string }).error, /原话/);
	const none = R.judgeRules(rules, { ruleAssessments: [{ ruleId: id, matched: false, reason: "没对上" }] });
	assert.ok(none.ok && R.gate(none) === "to_reminder", "不是明确交代、没对上规则 → 转提醒");
	const hit = R.judgeRules(rules, { evidence: "报告卡了 13 小时", ruleAssessments: [{ ruleId: id, matched: true, reason: "报告类、超半天" }] });
	assert.ok(hit.ok && R.gate(hit) === "go" && hit.matched[0] === id);
});

test("巡检看得见群：situation 带「你在的群」（用户最近的话、项目 / 任务、群里约的跟进），内容有界截断", () => {
	reset();
	const room = mkRoom("导演群");
	userSay(room.id, "周五前要把周报导出来");
	for (let i = 0; i < 30; i++) userSay(room.id, `${"很长的一句话".repeat(60)}${i}`, NOW - 1800_000 + i);
	db.prepare("INSERT INTO room_projects(id, room_id, title, status, plan, created_by, created_at, updated_at) VALUES('pj1',?,'发布周报','active','{}','u',?,?)").run(room.id, NOW, NOW);
	db.prepare("INSERT INTO work_items(id, scope_kind, room_id, title, owner_agent_id, status, blocker, created_by, created_at, updated_at) VALUES('w1','room',?,'导出周报','ga','blocked','接口超时','u',?,?)").run(room.id, NOW - 20 * 3600_000, NOW - 20 * 3600_000);
	P.scheduleFollowup("ga", memberConversation(room.id, "ga"), NOW + 3600_000, "晚点看周报导出");
	const text = P.situation("ga", "heartbeat", undefined, NOW);
	assert.match(text, /## 你在的群/);
	assert.ok(text.includes(`[room:${room.id}] 群「导演群」`));
	assert.match(text, /进行中的项目：发布周报/);
	assert.match(text, /任务 导出周报 · blocked（卡住：接口超时，你负责）/);
	assert.match(text, /你在这个群约的跟进.*晚点看周报导出/);
	const block = text.split(`[room:${room.id}]`)[1].split("\n## ")[0];
	assert.ok(block.length <= ROOM_LIMITS.perRoomChars + 5, `一个群不超过 ${ROOM_LIMITS.perRoomChars} 字：${block.length}`);
	assert.ok((block.match(/- 用户 /g) ?? []).length <= ROOM_LIMITS.userMsgs, "每个群只给少量最近的用户消息");
	assert.ok(!text.includes("别的群的秘密"));
});

test("群成员也算巡检对象：没有单聊、只有群里的用户消息，也会被巡检；没有用户消息的群不会", () => {
	reset();
	db.prepare("DELETE FROM messages WHERE role = 'user'").run();
	const quiet = mkRoom("空群");
	assert.deepEqual(P.tickProactive(NOW), [], "群里没人说过话：不巡检");
	userSay(quiet.id, "帮我盯一下发布");
	assert.deepEqual(P.tickProactive(NOW), ["ga:heartbeat"]);
	assert.ok(spawned.some((s) => s.agentId === "ga" && /你在的群/.test(s.instructions)));
});

test("proactive_advance 指定群：群里先有可见小提示，再叫醒该成员发言（回合原因 proactive）；不触发管理者收尾", async () => {
	reset();
	const room = mkRoom("推进群");
	const r = await J.advanceForHeartbeat("ga", advIn(room.id));
	assert.equal(r.status, "started");
	assert.ok(sysMsgs(room.id).some((c) => /🧭 阿甲 主动来推进：把周报导出/.test(c)));
	await wait(() => turnsOf(room.id).some((t) => t.status !== "queued" && t.status !== "running"), 15000, "成员在群里发言");
	const t0 = turnsOf(room.id)[0];
	assert.equal(t0.reason, "proactive");
	assert.match(t0.task ?? "", /要做的事：把周报导出/);
	assert.ok(db.prepare("SELECT 1 FROM messages WHERE room_id = ? AND agent_id = 'ga' AND role = 'assistant'").get(room.id));
	await wait(() => idle(room.id));
	assert.equal(turnsOf(room.id).filter((t) => t.agent_id === "gm").length, 0);
	assert.equal(A.listAdvances({ agentId: "ga", status: "done" }).length, 1, "占自发推进次数");
	const j = L.listJudgments("ga")[0];
	assert.equal(j.outcome, "started");
	assert.match(j.basis, /用户明确交代过/);
	assert.equal(j.room_id, room.id);
});

test("群已停止：只记一条，不推进；不在群里的成员 / 同时填两个目标被拒", async () => {
	reset();
	const room = mkRoom("停止群");
	db.prepare("UPDATE rooms SET paused = ? WHERE id = ?").run(JSON.stringify({ pending: [], reason: "群聊已停止", stopped: true }), room.id);
	const r = await J.advanceForHeartbeat("ga", advIn(room.id));
	assert.equal(r.status, "inbox");
	assert.match(r.reason ?? "", /群已停止/);
	assert.equal(turnsOf(room.id).length, 0);
	assert.ok(sysMsgs(room.id).some((c) => /群已停止，没有自动推进/.test(c)));
	assert.equal(A.listAdvances({ agentId: "ga", status: "failed" }).length, 1);
	assert.equal((await J.advanceForHeartbeat("gz", advIn(room.id))).status, "rejected");
	assert.equal((await J.advanceForHeartbeat("ga", advIn(room.id, { conversationId: "c-x" }))).status, "rejected");
});

test("规则研判接入：缺研判拒；未命中规则的非明确交代事项转成提醒；命中规则才放行", async () => {
	reset();
	const room = mkRoom("规则群");
	P.saveProactive("ga", { cfg: { rules: [RULE] } });
	const miss = await J.advanceForHeartbeat("ga", advIn(room.id));
	assert.equal(miss.status, "rejected");
	assert.match(miss.reason ?? "", /缺少对这些规则的研判/);
	const ev = { explicit: false, evidence: "", title: "整理下载目录", dedupeKey: "tidy" };
	const toRem = await J.advanceForHeartbeat("ga", advIn(room.id, { ...ev, ruleAssessments: [{ ruleId: "r1", matched: false, reason: "和报告无关" }] }));
	assert.equal(toRem.status, "inbox");
	assert.match(toRem.reason ?? "", /转成提醒/);
	assert.equal(turnsOf(room.id).length, 0, "没有去做");
	assert.ok((db.prepare("SELECT title FROM proactive_items WHERE agent_id = 'ga'").all() as { title: string }[]).some((i) => i.title === "整理下载目录"), "提醒进收件箱");
	assert.equal(L.listJudgments("ga")[0].outcome, "to_reminder");
	const ok = await J.advanceForHeartbeat("ga", advIn(room.id, { explicit: false, evidence: "周报任务卡了 13 小时", dedupeKey: "rerun", ruleAssessments: [{ ruleId: "r1", matched: true, reason: "报告类任务卡住超半天" }] }));
	assert.equal(ok.status, "started");
	assert.match(L.listJudgments("ga")[0].basis, /规则「报告类任务卡住超过半天/);
	await wait(() => idle(room.id));
});

test("没写规则也敢做：已有事情里能帮上的一步（helpful）直接做，但必须写依据", async () => {
	reset();
	const room = mkRoom("帮忙群");
	const noEv = await J.advanceForHeartbeat("ga", advIn(room.id, { explicit: false, helpful: true, evidence: "", dedupeKey: "h0" }));
	assert.equal(noEv.status, "rejected");
	assert.match(noEv.reason ?? "", /evidence/);
	const ok = await J.advanceForHeartbeat("ga", advIn(room.id, { explicit: false, helpful: true, evidence: "周报导出任务卡了 13 小时", dedupeKey: "h1" }));
	assert.equal(ok.status, "started");
	assert.match(L.listJudgments("ga")[0].basis, /已有事情里能帮上/);
	await wait(() => idle(room.id));
});

test("单聊也走同一入口：conversationId 推进（自动模式），记判断；主动等级 off 的助理不受影响（仍拒绝）", async () => {
	reset();
	const conv = createConversation("ga").id;
	const sent: string[] = [];
	A.setAdvanceHooks({ busy: () => false, send: async (_a, _c, text) => (sent.push(text), "started") });
	try {
		const r = await J.advanceForHeartbeat("ga", { conversationId: conv, kind: "followup", title: "导出报告", body: "导出", importance: 3, explicit: true, evidence: "用户：导出报告", ruleAssessments: [], dedupeKey: "e1" });
		assert.equal(r.status, "started");
		assert.match(sent[0], /依据：用户明确交代过；原话：用户：导出报告/);
		P.saveProactive("ga", { level: "off" });
		const off = await J.advanceForHeartbeat("ga", { conversationId: conv, kind: "followup", title: "另一件", body: "x", importance: 3, explicit: true, evidence: "用户说的", ruleAssessments: [], dedupeKey: "e2" });
		assert.equal(off.status, "rejected");
		assert.equal(sent.length, 1);
		assert.deepEqual(P.tickProactive(NOW), [], "主动等级 off：照旧不巡检");
	} finally {
		A.setAdvanceHooks(null);
	}
});

test("模式「关」：不推进，提示里让它只提醒；模式存进主动设置，默认自动", async () => {
	reset();
	assert.equal(P.proactiveJson("gz").cfg.autonomy, "auto", "没存过的助理默认自动");
	const room = mkRoom("关闭群");
	P.saveProactive("ga", { cfg: { autonomy: "off" } });
	const r = await J.advanceForHeartbeat("ga", advIn(room.id));
	assert.equal(r.status, "rejected");
	assert.match(r.reason ?? "", /关闭了这个助理的主动做事/);
	assert.equal(turnsOf(room.id).length, 0);
	assert.match(P.situation("ga", "heartbeat", undefined, NOW), /不要调用 proactive_advance/);
	assert.throws(() => P.saveProactive("ga", { cfg: { autonomy: "yolo" as never } }), /auto \/ trial \/ off/);
	assert.throws(() => P.saveProactive("ga", { cfg: { rules: [{ id: "a", text: "x", enabled: true }, { id: "a", text: "y", enabled: true }] } }), /重复/);
});

test("试运行：不真做，记成「本来会做」卡片；就这么做 → 真做一次；这类以后别做 → 记成否定并带进之后的提示", async () => {
	reset();
	const room = mkRoom("试运行群");
	P.saveProactive("ga", { cfg: { autonomy: "trial" } });
	assert.match(P.situation("ga", "heartbeat", undefined, NOW), /当前是试运行/);
	const r = await J.advanceForHeartbeat("ga", advIn(room.id, { title: "把周报导出", dedupeKey: "t1" }));
	assert.equal(r.status, "inbox");
	assert.match(r.reason ?? "", /试运行/);
	assert.equal(turnsOf(room.id).length, 0, "没有真做");
	const card = L.judgmentOfItem(r.id!)!;
	assert.equal(card.outcome, "trial");
	assert.ok(L.trialItemIds("ga").has(r.id!));
	assert.match(P.listItems({ agentId: "ga" }).find((i) => i.id === r.id)?.reason ?? "", /本来会做/);
	// 就这么做
	const go = await J.confirmTrial(r.id!);
	assert.equal(go.status, "started");
	assert.equal(L.judgmentOfItem(r.id!)!.outcome, "confirmed");
	assert.equal(P.listItems({ agentId: "ga" }).filter((i) => i.id === r.id).length, 0, "原卡片已处理");
	await wait(() => turnsOf(room.id).some((t) => t.reason === "proactive" && t.status !== "queued" && t.status !== "running"));
	await wait(() => idle(room.id));
	await assert.rejects(J.confirmTrial(r.id!), /不是等你决定/);
	// 这类以后别做
	const r2 = await J.advanceForHeartbeat("ga", advIn(room.id, { title: "整理群文件", dedupeKey: "t2" }));
	J.vetoTrial(r2.id!);
	assert.equal(L.judgmentOfItem(r2.id!)!.outcome, "vetoed");
	assert.deepEqual(L.avoidedList("ga"), ["整理群文件（followup）"]);
	assert.match(P.situation("ga", "heartbeat", undefined, NOW), /用户否掉过的做法[\s\S]*整理群文件/);
	assert.equal(turnsOf(room.id).length, 1, "只有点了「就这么做」的那一次真做");
});

test("判断记录可从主动设置读到（做了什么 / 依据 / 结果）", async () => {
	reset();
	const room = mkRoom("记录群");
	await J.advanceForHeartbeat("ga", advIn(room.id, { title: "记录一下", dedupeKey: "log1" }));
	const j = P.proactiveJson("ga").judgments;
	assert.equal(j.length, 1);
	assert.equal(j[0].title, "记录一下");
	assert.equal(j[0].outcome, "started");
	assert.match(j[0].basis, /原话/);
	await wait(() => idle(room.id));
});
