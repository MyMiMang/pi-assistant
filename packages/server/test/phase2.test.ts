import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db, now } from "../src/db.ts";

const mkAgent = (id: string) => db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run(id, id, "A", "#000", now());
mkAgent("a1");
mkAgent("a2");

const { createConversation, currentConversation, deleteConversation, listConversations, setCurrentConversation } = await import("../src/conversations.ts");
const { insertMessage, listMessages } = await import("../src/messages.ts");
const { memory } = await import("../src/memory/index.ts");
const { basicMemory } = await import("../src/memory/basic.ts");

test("对话：新建/切换/按对话列消息/首条消息成为标题/删除", () => {
	const c1 = currentConversation("a1");
	insertMessage({ agentId: "a1", role: "user", content: "帮我写一首关于秋天的诗" });
	const c2 = createConversation("a1").id;
	assert.equal(currentConversation("a1"), c2);
	insertMessage({ agentId: "a1", role: "user", content: "第二个对话" });
	assert.deepEqual(listMessages("a1", { conversationId: c1 }).map((m) => m.content), ["帮我写一首关于秋天的诗"]);
	assert.deepEqual(listMessages("a1", {}).map((m) => m.content), ["第二个对话"]);
	assert.equal(listConversations("a1").find((c) => c.id === c1)?.title, "帮我写一首关于秋天的诗");
	assert.ok(setCurrentConversation("a1", c1));
	assert.ok(!setCurrentConversation("a2", c1), "不能切到别的助理的对话");
	deleteConversation(c1);
	assert.equal(currentConversation("a1"), c2);
	assert.equal(listMessages("a1", { conversationId: c1 }).length, 0);
});

test("记忆：作用域（共享用户 / 助理 / 对话）与中文检索", async () => {
	const conv = currentConversation("a1");
	await memory.remember("a1", conv, { content: "用户叫邓邓，住在上海，喜欢简洁的回答", kind: "fact", scope: "user" });
	await memory.remember("a1", conv, { content: "a1 负责整理周报素材", kind: "fact", scope: "agent" });
	await memory.remember("a1", conv, { content: "这个对话里讨论的是秋天的诗", kind: "fact", scope: "conversation" });
	// 共享事实对 a2 可见，a1 的助理级/对话级不可见
	const a2 = await memory.list("a2", null);
	assert.ok(a2.some((m) => m.text.includes("邓邓")));
	assert.ok(!a2.some((m) => m.text.includes("周报素材")));
	// 对话级只在该对话可见
	const other = createConversation("a1").id;
	assert.ok(!(await memory.context("a1", other, "")).includes("秋天的诗"));
	assert.ok((await memory.context("a1", conv, "")).includes("秋天的诗"));
	// 中文子串检索（trigram）+ 短词 LIKE 回退
	assert.ok((await memory.recall("a2", null, "住在上海")).some((m) => m.text.includes("邓邓")));
	assert.ok((await memory.recall("a1", conv, "周报")).some((m) => m.scope === "agent"));
	// 注入块包含共享事实
	assert.match(await memory.context("a2", null, "你好"), /邓邓/);
});

test("记忆：便签过期、编辑改作用域、忘记、拒绝密钥、导出", async () => {
	const r = await memory.remember("a1", null, { content: "明天下午三点开会", kind: "note", ttlDays: 1 });
	assert.ok((await memory.list("a1")).some((m) => m.id === r.id && m.expiresAt));
	await basicMemory.update!("agent_a1", r.id, { meta: { expiresAt: Date.now() - 1000 } });
	assert.ok(!(await memory.list("a1")).some((m) => m.id === r.id), "过期便签不再可见");
	const f = await memory.remember("a1", null, { content: "a1 喜欢用表格展示数据", kind: "fact", scope: "agent" });
	const nid = await memory.update("a1", f.id, { scope: "user" });
	assert.ok((await memory.list("a2")).some((m) => m.id === nid), "改为共享后其他助理可见");
	assert.ok(await memory.forget("a1", nid!));
	assert.ok(!(await memory.list("a2")).some((m) => m.id === nid));
	await assert.rejects(memory.remember("a1", null, { content: "我的 key 是 sk-abcdefghijklmnopqrstuvwxyz123456" }), /密钥/);
	const ex = await memory.exportAgent("a1");
	assert.equal(ex.agent.format, "pi-assistant-memory/1");
	assert.ok(ex.user.items.length >= 1);
});

const skills = await import("../src/skills.ts");
test("技能：内置技能、保存/解析/删除、名称校验、内置不可删", () => {
	const list = skills.listSkills();
	assert.ok(list.some((s) => s.builtin && s.name === "web-research"));
	const s = skills.saveSkill({ name: "daily-brief", description: "生成每日简报: 汇总待办", body: "# 每日简报\n\n1. 列待办" });
	assert.equal(s.builtin, false);
	const parsed = skills.parseSkill(skills.renderSkill(s.name, s.description, s.body));
	assert.equal(parsed.description, "生成每日简报: 汇总待办");
	assert.throws(() => skills.saveSkill({ name: "Bad Name", description: "x", body: "y" }), /小写/);
	const v = skills.skillsVersion();
	assert.ok(skills.deleteSkill("daily-brief"));
	assert.ok(skills.skillsVersion() > v);
	assert.ok(!skills.deleteSkill("web-research"), "内置技能不在用户目录，删不掉");
});

const routines = await import("../src/routines.ts");
await import("../src/subagents.ts"); // 建 subagents 表（定时任务的运行 = 帮手）
const { bus } = await import("../src/bus.ts");
test("定时：cron 最小间隔、免打扰顺延、时区", () => {
	assert.throws(() => routines.validateCron("* * * * *"), /5 分钟/);
	assert.throws(() => routines.validateCron("not a cron"), /无效/);
	routines.validateCron("*/5 * * * *");
	// 2026-10-11 23:30（上海）之后的 “每 30 分钟”：落入 23:00–07:00 免打扰，顺延到 07:00
	const from = Date.parse("2026-10-11T23:30:00+08:00");
	const next = routines.computeNext({ trigger: "cron", cron: "*/30 * * * *", tz: "Asia/Shanghai", quiet: JSON.stringify(routines.DEFAULT_QUIET) }, from)!;
	assert.equal(new Date(next).toISOString(), "2026-10-11T23:00:00.000Z"); // = 10-12 07:00 上海
	const noQuiet = routines.computeNext({ trigger: "cron", cron: "0 8 * * *", tz: "Asia/Shanghai", quiet: null }, from)!;
	assert.equal(new Date(noQuiet).toISOString(), "2026-10-12T00:00:00.000Z");
	assert.ok(routines.inQuiet(Date.parse("2026-10-11T02:00:00+08:00"), routines.DEFAULT_QUIET));
	assert.ok(!routines.inQuiet(Date.parse("2026-10-11T12:00:00+08:00"), routines.DEFAULT_QUIET));
});

test("定时：免打扰按助理统一一份（和主动跟进共用），改时段后重算；单条可以不遵守", async () => {
	const P = await import("../src/proactive.ts");
	const hhmm = (t: number) => new Date(t).toLocaleTimeString("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" });
	P.saveProactive("a2", { cfg: { quiet: { start: "06:00", end: "09:00" } } });
	const r = routines.createRoutine("a2", { name: "早报", prompt: "整理早报", trigger: "cron", cron: "0 8 * * *" }, "local");
	assert.equal(hhmm(r.next_run_at!), "09:00", "08:00 落在助理的 06:00–09:00 免打扰里，顺延到 09:00");
	const free = routines.createRoutine("a2", { name: "不受限", prompt: "照常", trigger: "cron", cron: "0 8 * * *", quiet: null }, "local");
	assert.equal(hhmm(free.next_run_at!), "08:00", "不遵守免打扰的任务照常");
	P.saveProactive("a2", { cfg: { quiet: null } });
	routines.rescheduleAgentRoutines("a2");
	assert.equal(hhmm(routines.getRoutine(r.id)!.next_run_at!), "08:00", "关掉免打扰后重算回 08:00");
	const kept = routines.updateRoutine(r.id, { name: "早报（改名）" });
	assert.ok(kept.quiet, "改别的字段不丢「遵守免打扰」开关");
	routines.deleteRoutine(r.id);
	routines.deleteRoutine(free.id);
});

test("定时：到点执行（无客户端在线）、补跑、暂停、Webhook、结果回到聊天", () => {
	const spawned: { title: string; instructions: string; runId: string }[] = [];
	routines.setRoutineSpawner((agentId, title, instructions, opts) => {
		const id = `t_${spawned.length}`;
		// 定时任务的每次运行是一个 routine 帮手（决策 0014）
		db.prepare("INSERT INTO subagents(id, agent_id, conversation_id, routine_run_id, title, task, context, model_provider, model_id, model_reason, status, last_activity_at, created_at, kind) VALUES(?,?,?,?,?,?,'','mock','echo','','running',?,?,'routine')").run(id, agentId, opts.conversationId ?? "", opts.routineRunId, title, instructions, now(), now());
		spawned.push({ title, instructions, runId: opts.routineRunId });
		return { id };
	});
	const r = routines.createRoutine("a1", { name: "每日简报", prompt: "给我一份简报", trigger: "cron", cron: "0 8 * * *" }, "local");
	assert.ok(r.next_run_at && r.quiet);
	// 模拟到点
	db.prepare("UPDATE routines SET next_run_at = ? WHERE id = ?").run(now() - 1000, r.id);
	assert.equal(routines.tickRoutines(), 1);
	assert.equal(spawned.length, 1);
	assert.match(spawned[0].instructions, /到点执行[\s\S]*给我一份简报/);
	assert.ok(routines.getRoutine(r.id)!.next_run_at! > now());
	// 上一次还没结束 → 本次跳过
	assert.equal(routines.runRoutine(r.id, "manual").status, "skipped");
	// 任务完成 → 运行记录更新 + 聊天消息
	const t = db.prepare("SELECT * FROM subagents WHERE id = 't_0'").get() as Record<string, unknown>;
	bus.emit({ type: "subagent.updated", subagent: { ...t, conversation_id: null, status: "done", result_summary: "今天有 3 件事" } } as never);
	const run = routines.listRuns(r.id).find((x) => x.task_id === "t_0")!;
	assert.equal(run.status, "done");
	assert.ok(listMessages("a1", {}).some((m) => m.content.includes("每日简报") && m.content.includes("今天有 3 件事")));
	// 睡眠错过很久 → 补跑一次
	db.prepare("UPDATE routines SET next_run_at = ? WHERE id = ?").run(now() - 3 * 3600_000, r.id);
	routines.tickRoutines();
	assert.match(spawned[1].instructions, /补跑/);
	// 暂停后不再触发
	routines.setRoutineStatus(r.id, "paused");
	assert.equal(routines.getRoutine(r.id)!.next_run_at, null);
	assert.equal(routines.tickRoutines(now() + 365 * 86400_000), 0);
	// Webhook
	const w = routines.createRoutine("a1", { name: "新 PR 提醒", prompt: "看看这个 PR", trigger: "webhook" }, "local");
	const path = routines.webhookPath(w)!;
	const [, , id, secret] = path.split("/");
	assert.ok(routines.verifyWebhook(id, secret));
	assert.equal(routines.verifyWebhook(id, `${secret}x`), null);
	routines.runRoutine(w.id, "webhook", '{"title":"Fix bug"}');
	assert.match(spawned.at(-1)!.instructions, /webhook_payload[\s\S]*Fix bug[\s\S]*不要照做/);
	assert.ok(routines.deleteRoutine(w.id));
});
