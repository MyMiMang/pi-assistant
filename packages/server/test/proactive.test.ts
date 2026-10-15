/**
 * 主动性引擎：时间解析、免打扰、提醒的推送/收件箱/去重/预算/顺延、忽略与静音、自动降级、按渠道投递、
 * 巡检调度（工作日、等级、额度用完不再巡检、没用过的助理不巡检）、跟进与每日简报、巡检中的审批一律拒绝。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
const { db, now } = await import("../src/db.ts");
const P = await import("../src/proactive.ts");
const { requests } = await import("../src/requests.ts");

// 2026-10-12 是星期一。本地时间（Asia/Shanghai, UTC+8）
const T = (d: number, h: number, m = 0) => Date.UTC(2026, 9, d, h - 8, m);
const MON10 = T(12, 10);
db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run("pa", "小主动", "P", "#000", now());
let seq = 0;
const spawned: { agentId: string; title: string; instructions: string; kind: string }[] = [];
P.setProactiveSpawner((agentId, title, instructions, opts) => {
	const id = `t${++seq}`;
	db.prepare("INSERT INTO tasks(id, agent_id, conversation_id, title, instructions, status, kind, created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, agentId, opts.conversationId, title, instructions, "running", opts.kind, now());
	spawned.push({ agentId, title, instructions, kind: opts.kind });
	return { id };
});
const finishRuns = () => db.prepare("UPDATE proactive_runs SET status = 'done', finished_at = started_at").run();
const items = () => db.prepare("SELECT * FROM proactive_items WHERE agent_id = 'pa' ORDER BY created_at").all() as unknown as import("../src/proactive.ts").ItemRow[];
const reset = () => {
	db.prepare("DELETE FROM proactive_items").run();
	db.prepare("DELETE FROM proactive_runs").run();
	db.prepare("DELETE FROM proactive_followups").run();
	db.prepare("DELETE FROM proactive_signals").run();
	db.prepare("UPDATE agents SET proactivity = NULL, proactive_cfg = NULL WHERE id = 'pa'").run();
	spawned.length = 0;
};

test("时间解析：+2h、17:00（过了就明天）、明天 9:00、ISO 按用户时区；太近 / 太远报错", () => {
	assert.equal(P.parseWhen("+2h", MON10), MON10 + 2 * 3600_000);
	assert.equal(P.parseWhen("17:00", MON10), T(12, 17));
	assert.equal(P.parseWhen("09:00", MON10), T(13, 9));
	assert.equal(P.parseWhen("明天 9:00", MON10), T(13, 9));
	assert.equal(P.parseWhen("2026-10-15 08:30", MON10), T(15, 8, 30));
	assert.throws(() => P.parseWhen("+1m", MON10), /5 分钟/);
	assert.throws(() => P.parseWhen("+40d", MON10), /30 天/);
	assert.throws(() => P.parseWhen("找个时间", MON10), /看不懂/);
});

test("免打扰跨午夜；结束时间", () => {
	const q = { start: "22:00", end: "08:00" };
	assert.equal(P.inQuiet(T(12, 23), q), true);
	assert.equal(P.inQuiet(T(13, 7, 59), q), true);
	assert.equal(P.inQuiet(T(13, 8), q), false);
	assert.equal(P.quietEnd(T(12, 23), q), T(13, 8));
});

test("提醒：够重要 → 推送进当前对话；同一件事去重；不够重要 → 只进收件箱；默认等级 low 只推重要度 3", () => {
	reset();
	assert.equal(P.defaultLevel(), "low");
	const r = P.surface("pa", { kind: "reminder", title: "下午 3 点牙医", body: "你上周说今天下午 3 点看牙医，记得 2 点半出发。", importance: 3 }, MON10);
	assert.equal(r.status, "delivered");
	const msg = db.prepare("SELECT content, meta FROM messages WHERE agent_id = 'pa' AND json_extract(meta, '$.proactive.id') = ?").get(r.id!) as { content: string };
	assert.match(msg.content, /牙医/);
	assert.equal(P.surface("pa", { kind: "reminder", title: "下午3点 牙医！", body: "x", importance: 3 }, MON10 + 60_000).status, "rejected", "标题归一化后去重");
	const low = P.surface("pa", { kind: "other", title: "随便说说", body: "x", importance: 2 }, MON10);
	assert.equal(low.status, "inbox");
	assert.match(low.reason!, /不够重要/);
});

test("每日预算：用完后只进收件箱；简报不占额度", () => {
	reset();
	P.saveProactive("pa", { level: "normal" }); // 4 条
	for (let i = 0; i < 4; i++) assert.equal(P.surface("pa", { kind: "other", title: `事情${i}`, body: "b", importance: 2 }, MON10 + i).status, "delivered");
	const over = P.surface("pa", { kind: "other", title: "第五件", body: "b", importance: 3 }, MON10 + 10);
	assert.equal(over.status, "inbox");
	assert.match(over.reason!, /上限/);
	assert.equal(P.surface("pa", { kind: "brief", title: "今日简报", body: "b", importance: 2 }, MON10 + 20).status, "delivered");
	assert.equal(P.deliveredToday("pa", MON10), 4);
});

test("免打扰：先放着，结束后由调度器推送", () => {
	reset();
	P.saveProactive("pa", { level: "normal" });
	const r = P.surface("pa", { kind: "email", title: "老板的新邮件", body: "b", importance: 3 }, T(12, 23));
	assert.equal(r.status, "held");
	P.tickProactive(T(13, 7));
	assert.equal(items()[0].status, "held");
	P.tickProactive(T(13, 8, 1));
	assert.equal(items()[0].status, "delivered");
});

test("忽略：被忽略的事永不再提；忽略并静音这一类 → 14 天内不再提；连续忽略 ≥3 次自动降级", () => {
	reset();
	P.saveProactive("pa", { level: "high" });
	const a = P.surface("pa", { kind: "suggest_routine", title: "要不要每天早上汇总新闻", body: "b", importance: 2, dedupeKey: "routine:news" }, MON10);
	P.actOnItem(a.id!, "dismiss");
	assert.equal(P.surface("pa", { kind: "suggest_routine", title: "换个说法", body: "b", importance: 2, dedupeKey: "routine:news" }, MON10 + 5 * 86400_000).status, "rejected");
	const b = P.surface("pa", { kind: "suggest_skill", title: "做成技能？", body: "b", importance: 2 }, MON10);
	P.actOnItem(b.id!, "dismiss", { mute: true });
	assert.match(P.surface("pa", { kind: "suggest_skill", title: "另一个技能", body: "b", importance: 3 }, MON10 + 86400_000).reason!, /暂时不想/);
	const c = P.surface("pa", { kind: "other", title: "第三件", body: "b", importance: 2 }, MON10);
	P.actOnItem(c.id!, "dismiss");
	const j = P.proactiveJson("pa");
	assert.equal(j.throttled, true);
	assert.equal(j.effectiveLevel, "normal");
});

test("投递：先写进 App 对话（最近在微信里聊得更近 → 那个渠道对话）再镜像；只用 App 时只记在 App", () => {
	reset();
	P.saveProactive("pa", { level: "high" });
	db.prepare("INSERT INTO conversations(id, agent_id, title, created_at, updated_at) VALUES('cwx','pa','微信',?,?)").run(now(), now());
	db.prepare("INSERT INTO channels(id, kind, name, agent_id, enabled, config, created_at) VALUES('chx','wechat_clawbot','微信','pa',1,'{}',?)").run(now());
	db.prepare("INSERT INTO channel_peers(channel_id, peer_id, allowed, conversation_id, ctx, last_at) VALUES('chx','u@im.wechat',1,'cwx','{}',?)").run(MON10 - 3600_000);
	const r = P.surface("pa", { kind: "reminder", title: "该出发了", body: "b", importance: 3 }, MON10);
	assert.equal(items().find((i) => i.id === r.id)!.delivered_via, "app,channel:chx");
	assert.ok(db.prepare("SELECT 1 FROM messages WHERE conversation_id = 'cwx' AND json_extract(meta, '$.proactive.id') = ?").get(r.id!));
	P.saveProactive("pa", { cfg: { deliver: "app" } });
	const r2 = P.surface("pa", { kind: "reminder", title: "另一件事", body: "b", importance: 3 }, MON10);
	assert.equal(items().find((i) => i.id === r2.id)!.delivered_via, "app");
	assert.ok(db.prepare("SELECT 1 FROM messages WHERE json_extract(meta, '$.proactive.id') = ? AND json_extract(meta, '$.noMirror') = 1").get(r2.id!));
	db.prepare("DELETE FROM channel_peers WHERE channel_id = 'chx'").run();
	db.prepare("DELETE FROM channels WHERE id = 'chx'").run();
});

test("巡检调度：没用过的助理不巡检；工作日按间隔巡检；周末（只工作日）不巡检；关闭不巡检；额度用完不再巡检", () => {
	reset();
	P.saveProactive("pa", { level: "normal" });
	db.prepare("DELETE FROM messages WHERE agent_id = 'pa' AND role = 'user'").run();
	assert.deepEqual(P.tickProactive(MON10), []);
	db.prepare("INSERT INTO messages(id, agent_id, conversation_id, role, content, status, created_at, updated_at) VALUES('mu1','pa','cwx','user','我周五要交季度报告','done',?,?)").run(MON10 - 3600_000, MON10 - 3600_000);
	assert.deepEqual(P.tickProactive(MON10), ["pa:heartbeat"]);
	assert.equal(spawned[0].kind, "heartbeat");
	assert.match(spawned[0].instructions, /季度报告/, "情况里带上用户最近说过的话");
	assert.match(spawned[0].instructions, /宁缺毋滥/);
	assert.deepEqual(P.tickProactive(MON10 + 60_000), [], "上一次还在运行");
	finishRuns();
	assert.deepEqual(P.tickProactive(MON10 + 30 * 60_000), [], "没到兜底间隔");
	assert.deepEqual(P.tickProactive(MON10 + 2 * 3600_000 + 60_000), [], "2 小时不再空巡（变化驱动，兜底最低 4 小时）");
	assert.deepEqual(P.tickProactive(MON10 + 4 * 3600_000 + 60_000), ["pa:heartbeat"], "到低频兜底间隔才巡检");
	finishRuns();
	assert.deepEqual(P.tickProactive(T(17, 11)), [], "星期六");
	P.saveProactive("pa", { cfg: { weekdaysOnly: false } });
	assert.deepEqual(P.tickProactive(T(17, 11)), ["pa:heartbeat"]);
	finishRuns();
	P.saveProactive("pa", { level: "off" });
	assert.deepEqual(P.tickProactive(T(17, 15)), []);
	P.saveProactive("pa", { level: "low", cfg: { weekdaysOnly: true } });
	for (let i = 0; i < 2; i++) P.surface("pa", { kind: "other", title: `今日${i}`, body: "b", importance: 3 }, T(19, 9) + i);
	assert.deepEqual(P.tickProactive(T(19, 15)), [], "今天额度用完");
});

test("跟进：到点唤醒并带上备注与当时的对话；免打扰顺延；每日简报每天一次", () => {
	reset();
	P.saveProactive("pa", { level: "low", cfg: { dailyBrief: "08:30" } });
	const f = P.scheduleFollowup("pa", "cwx", T(12, 23), "看看季度报告的数据导出好了没有");
	assert.deepEqual(P.tickProactive(T(12, 23, 5)), [], "免打扰时段，顺延");
	assert.deepEqual(P.tickProactive(T(13, 8, 1)), ["pa:followup"]);
	assert.match(spawned.at(-1)!.instructions, /数据导出好了没有/);
	assert.match(spawned.at(-1)!.instructions, /季度报告/);
	assert.equal(P.listFollowups("pa").find((x) => x.id === f.id), undefined);
	finishRuns();
	assert.deepEqual(P.tickProactive(T(13, 8, 31)), ["pa:brief"]);
	finishRuns();
	assert.deepEqual(P.tickProactive(T(13, 9)), [], "简报一天一次（低等级 4 小时巡检也还没到）");
	assert.throws(() => P.saveProactive("pa", { cfg: { dailyBrief: "25:00" } }), /HH:MM/);
});

test("主动 ≠ 自主：巡检任务里的审批一律拒绝、不弹卡片；也不能提问", async () => {
	db.prepare("INSERT INTO tasks(id, agent_id, title, instructions, status, kind, created_at) VALUES('hb1','pa','巡检','x','running','heartbeat',?)").run(now());
	const before = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'card'").get() as { n: number }).n;
	const r = await requests.approval("pa", "hb1", "email_send", {}, "给客户发邮件", "high");
	assert.equal(r.approved, false);
	assert.match(r.note!, /主动巡检/);
	assert.match(r.note!, /proactive_advance/, "心跳不给额外权限，要推进就通过相关对话的主会话（正常权限路径）");
	const q = await requests.question("pa", "hb1", "要不要？", ["要", "不要"], false);
	assert.match(q.answer!, /不能向用户提问/);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'card'").get() as { n: number }).n, before);
	assert.equal(P.isHeartbeatTask("hb1"), true);
});

test("收件箱列表：按助理 / 全部；忽略和已处理的不在默认列表里", () => {
	reset();
	P.saveProactive("pa", { level: "high" });
	const a = P.surface("pa", { kind: "other", title: "甲", body: "b", importance: 3 });
	P.surface("pa", { kind: "other", title: "乙", body: "b", importance: 1 });
	P.actOnItem(a.id!, "done");
	assert.deepEqual(P.listItems({ agentId: "pa" }).map((i) => i.title), ["乙"]);
	assert.equal(P.listItems().length, 1);
	assert.equal(P.listItems({ agentId: "pa", all: true }).length, 2);
	assert.equal(P.unseenCount(), 1);
});

test("隐藏的巡检对话不出现在对话列表里", async () => {
	const { listConversations } = await import("../src/conversations.ts");
	const id = P.hiddenConversation("pa");
	assert.equal(P.hiddenConversation("pa"), id);
	assert.ok(!listConversations("pa").some((c) => c.id === id));
});

// ---------------------------------------------------------------- 变化驱动 / 相关对话 / 主动推进
test("变化驱动：无信号不空巡；有信号才唤醒一次并只带差量，标记已处理、窗口内不重复", () => {
	reset();
	P.saveProactive("pa", { level: "normal" });
	db.prepare("DELETE FROM messages WHERE agent_id = 'pa'").run();
	// 没有用户消息、没有任务、没有信号 → 即使过了很久也不唤醒（零模型）
	assert.deepEqual(P.tickProactive(MON10 + 24 * 3600_000), []);
	// 有用户消息（可能未闭环）→ 低频兜底仍会覆盖，避免为了省 token 砍掉主动性
	db.prepare("INSERT INTO messages(id, agent_id, conversation_id, role, content, status, created_at, updated_at) VALUES('msig','pa','cwx','user','周五要交季度报告','done',?,?)").run(MON10 - 3600_000, MON10 - 3600_000);
	assert.deepEqual(P.tickProactive(MON10), ["pa:heartbeat"]);
	finishRuns();
	// 变化信号：即使没到兜底间隔也即时唤醒，且只带差量（不是整份快照）
	assert.equal(P.recordSignal("pa", { kind: "task_failed", conversationId: "cwx", title: "后台任务失败：导出报表", detail: "磁盘满了", importance: 3, dedupeKey: "task:t-x:failed" }), true);
	assert.equal(P.recordSignal("pa", { kind: "task_failed", title: "又一次", importance: 3, dedupeKey: "task:t-x:failed" }), false, "同一 key 窗口内不重复产生");
	assert.deepEqual(P.tickProactive(MON10 + P.SIGNAL_MIN_GAP_MS), ["pa:signal"]);
	const s = spawned.at(-1)!;
	assert.equal(s.kind, "heartbeat");
	assert.match(s.instructions, /需要关注的信号/);
	assert.match(s.instructions, /磁盘满了/);
	assert.match(s.instructions, /不是完整快照/);
	assert.equal(P.listSignals("pa", "pending").length, 0, "信号已标记已处理");
	finishRuns();
	// 已处理的信号不会再唤醒
	assert.deepEqual(P.tickProactive(MON10 + P.SIGNAL_MIN_GAP_MS + 60_000), []);
});

test("bus 信号：后台任务失败记信号；正常完成 / 心跳任务 / 子代理事件不记（避免与 notify 双唤醒）", async () => {
	reset();
	const { bus } = await import("../src/bus.ts");
	db.prepare("INSERT INTO tasks(id, agent_id, conversation_id, title, instructions, status, created_at, kind) VALUES('t-bus','pa','cwx','导出','x','running',?,NULL)").run(now());
	bus.emit({ type: "task.updated", task: { id: "t-bus", agent_id: "pa", conversation_id: "cwx", title: "导出", status: "failed", error: "磁盘满了", kind: null } as never });
	assert.equal(P.listSignals("pa").length, 1);
	assert.match(P.listSignals("pa")[0].title, /失败/);
	bus.emit({ type: "task.updated", task: { id: "t-bus2", agent_id: "pa", conversation_id: "cwx", title: "统计", status: "done", kind: null } as never });
	assert.equal(P.listSignals("pa").length, 1, "正常完成不产生信号（已有 notify + 下一轮注入）");
	bus.emit({ type: "task.updated", task: { id: "t-hb", agent_id: "pa", conversation_id: "cwx", title: "主动巡检", status: "failed", kind: "heartbeat" } as never });
	assert.equal(P.listSignals("pa").length, 1, "心跳任务本身不产生信号");
	bus.emit({ type: "subagent.updated", subagent: { id: "sa-x", agent_id: "pa", conversation_id: "cwx", task: "整理报价", status: "failed", error_reason: "模型报错" } as never });
	assert.equal(P.listSignals("pa").length, 1, "子代理终态已有 notify 唤醒，不重复记信号");
});

test("相关对话绑定：surface 指定对话必须属于这个助理；不属于则拒绝，不会投到别的对话", () => {
	reset();
	P.saveProactive("pa", { level: "high" });
	db.prepare("INSERT OR REPLACE INTO conversations(id, agent_id, title, created_at, updated_at) VALUES('c-other','other','别的',?,?)").run(now(), now());
	const bad = P.surface("pa", { kind: "reminder", title: "走错门", body: "x", importance: 3, conversationId: "c-other" }, MON10);
	assert.equal(bad.status, "rejected");
	assert.match(bad.reason!, /不属于/);
	db.prepare("INSERT OR REPLACE INTO conversations(id, agent_id, title, created_at, updated_at) VALUES('c-mine','pa','我的',?,?)").run(now(), now());
	const r = P.surface("pa", { kind: "reminder", title: "回到正题", body: "b", importance: 3, conversationId: "c-mine" }, MON10);
	assert.equal(r.status, "delivered");
	assert.ok(db.prepare("SELECT 1 FROM messages WHERE conversation_id='c-mine' AND json_extract(meta,'$.proactive.id')=?").get(r.id!));
});

test("主动推进：空闲→在相关对话开始；忙时排队、同一件事去重合并、队满回收件箱、drain 逐个送出", async () => {
	reset();
	P.saveProactive("pa", { level: "high" });
	db.prepare("INSERT OR REPLACE INTO conversations(id, agent_id, title, created_at, updated_at) VALUES('c-adv','pa','推进',?,?)").run(now(), now());
	let busy = false;
	const sent: string[] = [];
	P.setAdvanceHooks({ busy: () => busy, send: async (_a, _c, text) => { sent.push(text); return "started"; } });
	try {
		const a = await P.advanceConversation("pa", { conversationId: "c-adv", kind: "followup", title: "跟进报告", body: "帮用户把报告导出发过去", importance: 3, dedupeKey: "adv:1" });
		assert.equal(a.status, "started");
		assert.equal(sent.length, 1);
		assert.match(sent[0], /主动推进/);
		// 同一件事在窗口内去重：不会重复推进
		const dup = await P.advanceConversation("pa", { conversationId: "c-adv", kind: "followup", title: "跟进报告", body: "x", importance: 3, dedupeKey: "adv:1" });
		assert.equal(dup.status, "rejected");
		assert.equal(sent.length, 1, "同一件事不重复插回合");
		// 忙：不同的事排队
		busy = true;
		const q = await P.advanceConversation("pa", { conversationId: "c-adv", kind: "reminder", title: "第二件", body: "b2", importance: 3, dedupeKey: "adv:2" });
		assert.equal(q.status, "queued");
		assert.equal(sent.length, 1, "忙时不直接插回合");
		// 队满：再塞 3 件，只放得下 2 件（上限 3），多余的回收件箱
		const results = [];
		for (let i = 3; i <= 5; i++) results.push((await P.advanceConversation("pa", { conversationId: "c-adv", kind: "other", title: `第${i}件`, body: "b", importance: 3, dedupeKey: `adv:${i}` })).status);
		assert.deepEqual(results, ["queued", "queued", "inbox"], "排队上限 3，超出放进收件箱");
		// 空闲后 drain 逐个送出
		busy = false;
		P.drainAdvances("pa", "c-adv");
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(sent.length, 2);
		P.drainAdvances("pa", "c-adv");
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(sent.length, 3);
		P.drainAdvances("pa", "c-adv");
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(sent.length, 4);
	} finally {
		P.setAdvanceHooks(null);
	}
});
