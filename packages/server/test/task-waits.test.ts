/**
 * 任务等待（DESIGN §25）：持久等待、事件快速通道、兜底检查、去重、重启恢复、取消、
 * 手动刷新、结构化增量唤醒——核心验收点是「等待期间不调用模型，只有状态变化才唤醒一次」。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
const { db, now } = await import("../src/db.ts");
// 模拟上一版已存在的等待表：新索引只能在补齐投递列后创建。
db.exec(`CREATE TABLE task_waits (
 id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, conversation_id TEXT,
 target_kind TEXT NOT NULL, target_ref TEXT, reason TEXT NOT NULL, status TEXT NOT NULL,
 check_interval_ms INTEGER NOT NULL, next_check_at INTEGER, due_at INTEGER,
 last_checked_at INTEGER, check_count INTEGER NOT NULL DEFAULT 0,
 last_state TEXT, last_error TEXT, fired_reason TEXT, outcome TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)`);
const W = await import("../src/task-waits.ts");
const { bus } = await import("../src/bus.ts");
const { createConversation } = await import("../src/conversations.ts");
await import("../src/subagents.ts"); // 建 subagents 表

db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES('tw-a','等','W','#000',?)").run(now());
const conv = createConversation("tw-a").id;

/** 记录每次真实唤醒（生产环境这里会变成一次模型调用）。 */
const wakes: { id: string; prompt: string; outcome: unknown }[] = [];
W.setWaitWaker((w) => { wakes.push({ id: w.wait.id, prompt: w.prompt, outcome: w.outcome }); });

function makeTask(id: string, status: string, result: string | null = null, error: string | null = null) {
	db.prepare("INSERT OR REPLACE INTO tasks(id, agent_id, conversation_id, title, instructions, status, result, error, created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, "tw-a", conv, "标题", "指令", status, result, error, now());
}
function makeSubagent(id: string, status: string, summary: string | null = null, error: string | null = null) {
	db.prepare("INSERT OR REPLACE INTO subagents(id, agent_id, conversation_id, task, context, model_provider, model_id, model_reason, status, last_activity_at, result_summary, error_reason, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, "tw-a", conv, "子任务", "", "mock", "echo", "", status, now(), summary, error, now());
}
const reset = () => { db.prepare("DELETE FROM task_waits").run(); db.prepare("DELETE FROM tasks").run(); db.prepare("DELETE FROM subagents").run(); wakes.length = 0; W.resetWaitProviderRunner(); W.setWaitWaker((w) => { wakes.push({ id: w.wait.id, prompt: w.prompt, outcome: w.outcome }); }); };
/** 等微任务/定时器跑完，让 fireWait 的异步投递结果落库 */
const flush = () => new Promise((r) => setTimeout(r, 0));

test("旧等待表升级：先补投递列再创建索引", () => {
	const columns = db.prepare("PRAGMA table_info(task_waits)").all() as { name: string }[];
	assert.ok(columns.some((c) => c.name === "delivery_status"));
	assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='task_waits_delivery'").get());
});

test("登记校验：一次只等一件事；仓库格式；必须有目标或时间", () => {
	assert.throws(() => W.registerWait("tw-a", conv, { reason: "x", taskId: "a", subagentId: "b" }), /只等一件事/);
	assert.throws(() => W.registerWait("tw-a", conv, { reason: "x" }), /指定要等的东西/);
	assert.throws(() => W.registerWait("tw-a", conv, { reason: "x", githubRun: { repo: "not-a-repo" } }), /owner\/repo/);
	assert.throws(() => W.registerWait("tw-a", conv, { reason: "  " }), /在等什么/);
});

test("任务完成：事件只唤醒一次，重复事件去重；等待期间不唤醒", () => {
	reset();
	const w = W.registerWait("tw-a", conv, { taskId: "t1", reason: "等构建完成后把产物发给用户" });
	assert.equal(w.target_kind, "task");
	assert.equal(w.status, "waiting");
	assert.equal(wakes.length, 0, "登记本身不唤醒");
	makeTask("t1", "done", "构建成功，产物在 dist/");
	bus.emit({ type: "task.updated", task: { id: "t1", status: "done" } });
	assert.equal(wakes.length, 1);
	bus.emit({ type: "task.updated", task: { id: "t1", status: "done" } });
	bus.emit({ type: "task.updated", task: { id: "t1", status: "failed" } });
	assert.equal(wakes.length, 1, "同一等待只唤醒一次");
	assert.equal(W.getWait(w.id)!.status, "fired");
	const p = wakes[0].prompt;
	assert.match(p, /构建成功，产物在 dist\//);
	assert.match(p, /等构建完成后把产物发给用户/);
	assert.ok(p.length < 800, "唤醒词只带结构化增量，不重载历史");
});

test("子代理结束事件：完成 / 失败各唤醒一次", () => {
	reset();
	const a = W.registerWait("tw-a", conv, { subagentId: "sa1", reason: "等子代理整理报价表" });
	makeSubagent("sa1", "done", "报价表已整理");
	bus.emit({ type: "subagent.updated", subagent: { id: "sa1", status: "done" } });
	assert.equal(wakes.length, 1);
	assert.match(wakes[0].prompt, /报价表已整理/);
	assert.equal(W.getWait(a.id)!.status, "fired");
	const b = W.registerWait("tw-a", conv, { subagentId: "sa2", reason: "等诊断" });
	makeSubagent("sa2", "failed", null, "模型报错");
	bus.emit({ type: "subagent.updated", subagent: { id: "sa2", status: "failed" } });
	assert.equal(wakes.length, 2);
	assert.match(wakes[1].prompt, /模型报错/);
	assert.equal(W.getWait(b.id)!.status, "fired");
});

test("外部 provider：等待未变化只在程序里检查（不唤醒），状态变化才唤醒一次", async () => {
	reset();
	let calls = 0;
	W.setWaitProviderRunner(async () => (++calls >= 2 ? { state: "completed", conclusion: "success", url: "https://example/run/1" } : { state: "pending" }));
	const w = W.registerWait("tw-a", conv, { githubRun: { repo: "MyMiMang/pi-assistant", runId: 123 }, reason: "等 CI 通过后检查安装包", checkIntervalMs: 60_000 });
	const t0 = now();
	await W.tickWaits(t0 + 61_000);
	assert.equal(wakes.length, 0, "还 pending：不唤醒模型");
	const after1 = W.getWait(w.id)!;
	assert.equal(after1.status, "waiting");
	assert.ok(after1.last_checked_at, "最后检查时间已记录，可查询");
	assert.equal(after1.check_count, 1);
	await W.tickWaits(t0 + 122_000);
	assert.equal(wakes.length, 1, "completed 时唤醒一次");
	assert.match(wakes[0].prompt, /https:\/\/example\/run\/1/);
	await W.tickWaits(t0 + 200_000);
	assert.equal(wakes.length, 1, "已 fired 不再重复唤醒");
});

test("兜底：事件丢了，定时检查发现任务已结束也会唤醒一次", async () => {
	reset();
	makeTask("t2", "failed", null, "编译报错：缺少依赖");
	const w = W.registerWait("tw-a", conv, { taskId: "t2", reason: "等构建，失败就换依赖再试", checkIntervalMs: 60_000 });
	const t0 = now();
	await W.tickWaits(t0 + 30_000);
	assert.equal(wakes.length, 0, "间隔没到不检查不唤醒");
	await W.tickWaits(t0 + 61_000);
	assert.equal(wakes.length, 1);
	assert.match(wakes[0].prompt, /编译报错：缺少依赖/);
	assert.equal(W.getWait(w.id)!.status, "fired");
});

test("到期兜底：即使 provider 一直拿不到结果，到截止时间也唤醒（不会无限等）", async () => {
	reset();
	W.setWaitProviderRunner(async () => ({ state: "pending" }));
	const t0 = now();
	const w = W.registerWait("tw-a", conv, { githubRun: { repo: "a/b" }, dueAt: t0 + 120_000, checkIntervalMs: 60_000, reason: "等部署" });
	await W.tickWaits(t0 + 121_000);
	assert.equal(wakes.length, 1);
	assert.match(wakes[0].prompt, /等待超时/);
	assert.equal(W.getWait(w.id)!.status, "fired");
});

test("纯时间等待：到点唤醒一次", async () => {
	reset();
	const t0 = now();
	const w = W.registerWait("tw-a", conv, { dueAt: t0 + 60_000, reason: "10 分钟后再看看部署结果" });
	assert.equal(w.target_kind, "due");
	await W.tickWaits(t0 + 30_000);
	assert.equal(wakes.length, 0);
	await W.tickWaits(t0 + 60_001);
	assert.equal(wakes.length, 1);
	assert.equal(W.getWait(w.id)!.status, "fired");
});

test("重启恢复：持久化的等待在第一次 tick 就处理已到点 / 早已结束的目标", async () => {
	reset();
	makeTask("t3", "done", "早就跑完了");
	W.registerWait("tw-a", conv, { taskId: "t3", reason: "等它" });
	const past = now() - 10_000;
	W.registerWait("tw-a", conv, { dueAt: past - 1000, reason: "早就该到点了" });
	// 模拟重启：先重置检查时间，再跑第一次调度
	assert.equal(W.resumeWaits() >= 1, true);
	await W.tickWaits(now());
	assert.equal(wakes.length, 2);
	assert.ok(W.listWaits("tw-a", { status: "waiting" }).length === 0);
});

test("取消与停止：取消后的等待不再被事件或 tick 唤醒；停止会话连带取消", async () => {
	reset();
	const w1 = W.registerWait("tw-a", conv, { taskId: "t4", reason: "等构建" });
	assert.equal(W.cancelWait(w1.id), true);
	assert.equal(W.cancelWait(w1.id), false);
	makeTask("t4", "done", "x");
	bus.emit({ type: "task.updated", task: { id: "t4", status: "done" } });
	await W.tickWaits(now() + 10 * 60_000);
	assert.equal(wakes.length, 0, "已取消的等待不再唤醒");
	// 用户说“停”：这个会话的等待全部取消
	W.registerWait("tw-a", conv, { taskId: "t5", reason: "另一个" });
	assert.equal(W.cancelWaitsForConversation(conv), 1);
	assert.equal(W.listWaits("tw-a", { status: "waiting" }).length, 0);
});

test("手动刷新：用户查询立刻拿到最新状态并按需唤醒；重复刷新幂等", async () => {
	reset();
	W.setWaitProviderRunner(async () => ({ state: "completed", conclusion: "success", detail: "全部通过" }));
	const w = W.registerWait("tw-a", conv, { githubRun: { repo: "a/b", runId: 9 }, reason: "等发布 run" });
	const r = await W.refreshWait(w.id);
	assert.equal(r.fired, true);
	assert.equal(wakes.length, 1);
	assert.equal(W.getWait(w.id)!.status, "fired");
	const r2 = await W.refreshWait(w.id);
	assert.equal(r2.fired, false);
	assert.equal(wakes.length, 1);
	assert.match(String(r2.outcome?.detail), /全部通过/);
});

test("同一会话同一目标重复登记复用一条等待（避免重复唤醒）", () => {
	reset();
	const a = W.registerWait("tw-a", conv, { taskId: "t6", reason: "第一次" });
	const b = W.registerWait("tw-a", conv, { taskId: "t6", reason: "第二次" });
	assert.equal(a.id, b.id);
	assert.equal(W.listWaits("tw-a", { status: "waiting" }).length, 1);
	assert.equal(W.getWait(a.id)!.reason, "第二次");
});

test("任务被取消：连带取消等它的等待，不唤醒模型", async () => {
	reset();
	makeTask("t7", "running");
	const w = W.registerWait("tw-a", conv, { taskId: "t7", reason: "等这个后台任务，完成后汇总" });
	makeTask("t7", "cancelled");
	bus.emit({ type: "task.updated", task: { id: "t7", status: "cancelled" } });
	assert.equal(wakes.length, 0, "任务被取消不唤醒（连带取消等待）");
	assert.equal(W.getWait(w.id)!.status, "cancelled");
	// 取消后更晚的 tick 也不再唤醒
	await W.tickWaits(now() + 10 * 60_000);
	assert.equal(wakes.length, 0);
});

test("GitHub 限流 / 认证失败：给明确提示，不输出 token", async () => {
	reset();
	const orig = globalThis.fetch;
	try {
		globalThis.fetch = (async () => new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" } })) as unknown as typeof fetch;
		await assert.rejects(() => W.runGithubRun({ repo: "a/b" }), (e: Error) => /限流/.test(e.message) && !/Bearer|token=/i.test(e.message));
		globalThis.fetch = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
		await assert.rejects(() => W.runGithubRun({ repo: "a/b" }), /认证失败/);
	} finally {
		globalThis.fetch = orig;
	}
});

test("provider 检查出错：记录错误并继续等，不误唤醒", async () => {
	reset();
	W.setWaitProviderRunner(async () => { throw new Error("gh 未登录"); });
	const w = W.registerWait("tw-a", conv, { githubRun: { repo: "a/b" }, checkIntervalMs: 60_000, reason: "等 CI" });
	await W.tickWaits(now() + 61_000);
	assert.equal(wakes.length, 0);
	const row = W.getWait(w.id)!;
	assert.equal(row.status, "waiting");
	assert.match(row.last_error ?? "", /未登录/);
	assert.ok(row.last_checked_at);
});

// ---------------------------------------------------------------- 唤醒投递可靠性（fired 与 delivered 分离）
test("唤醒投递成功：标记 delivered，唤醒词带等待 id 幂等线索，不再重复", async () => {
	reset();
	const w = W.registerWait("tw-a", conv, { taskId: "td1", reason: "等构建" });
	makeTask("td1", "done", "产物好了");
	bus.emit({ type: "task.updated", task: { id: "td1", status: "done" } });
	assert.equal(wakes.length, 1);
	await flush();
	const row = W.getWait(w.id)!;
	assert.equal(row.status, "fired");
	assert.equal(row.delivery_status, "delivered");
	assert.equal(row.delivery_attempts, 1);
	assert.ok(row.delivered_at);
	assert.match(wakes[0].prompt, new RegExp(w.id), "唤醒词带等待 id，供重复送达时去重");
	// 再跑几轮 tick 不会重复投递
	await W.tickWaits(now() + 10 * 60_000);
	await flush();
	assert.equal(wakes.length, 1);
});

test("唤醒投递失败：有限重试并留痕，成功后不再重复，不把失败当已 fired", async () => {
	reset();
	let attempts = 0;
	W.setWaitWaker(() => { attempts++; if (attempts < 3) throw new Error("nudge 未送达"); });
	const w = W.registerWait("tw-a", conv, { taskId: "td2", reason: "等构建" });
	makeTask("td2", "done", "产物好了");
	bus.emit({ type: "task.updated", task: { id: "td2", status: "done" } });
	await flush();
	let row = W.getWait(w.id)!;
	assert.equal(row.status, "fired");
	assert.equal(row.delivery_status, "pending", "失败后仍是待投递，不是已送达");
	assert.equal(row.delivery_attempts, 1);
	assert.match(row.last_delivery_error ?? "", /未送达/);
	// 第 2 次仍失败
	db.prepare("UPDATE task_waits SET next_delivery_at = 0 WHERE id = ?").run(w.id);
	await W.tickWaits(now() + 1);
	await flush();
	row = W.getWait(w.id)!;
	assert.equal(row.delivery_attempts, 2);
	assert.equal(row.delivery_status, "pending");
	// 第 3 次成功
	db.prepare("UPDATE task_waits SET next_delivery_at = 0 WHERE id = ?").run(w.id);
	await W.tickWaits(now() + 2);
	await flush();
	row = W.getWait(w.id)!;
	assert.equal(row.delivery_status, "delivered");
	assert.equal(row.delivery_attempts, 3);
	assert.equal(attempts, 3);
	// 送达后不再重投
	await W.tickWaits(now() + 10 * 60_000);
	await flush();
	assert.equal(attempts, 3);
});

test("唤醒投递失败达上限：记为 failed，不再无限重试", async () => {
	reset();
	let attempts = 0;
	W.setWaitWaker(() => { attempts++; throw new Error("nudge 未送达"); });
	const w = W.registerWait("tw-a", conv, { taskId: "td3", reason: "等构建" });
	makeTask("td3", "done", "产物好了");
	bus.emit({ type: "task.updated", task: { id: "td3", status: "done" } });
	await flush();
	for (let i = 1; i < W.MAX_DELIVERY_ATTEMPTS; i++) {
		db.prepare("UPDATE task_waits SET next_delivery_at = 0 WHERE id = ?").run(w.id);
		await W.dispatchWake(w.id);
	}
	const row = W.getWait(w.id)!;
	assert.equal(row.delivery_attempts, W.MAX_DELIVERY_ATTEMPTS);
	assert.equal(row.delivery_status, "failed");
	assert.match(row.last_delivery_error ?? "", /未送达/);
	const before = attempts;
	db.prepare("UPDATE task_waits SET next_delivery_at = 0 WHERE id = ?").run(w.id);
	await W.dispatchWake(w.id);
	await W.tickWaits(now() + 10 * 60_000);
	await flush();
	assert.equal(attempts, before, "failed 后不再尝试投递");
});

test("重启恢复：已 fired 但未送达的唤醒在第一次 tick 补投一次", async () => {
	reset();
	const w = W.registerWait("tw-a", conv, { dueAt: now() + 600_000, reason: "等部署" });
	// 模拟上个进程：已判 fire、投递失败 / 崩溃前未送达
	db.prepare("UPDATE task_waits SET status='fired', fired_reason='已完成', outcome=?, delivery_status='pending', delivery_attempts=2, next_delivery_at=? WHERE id=?").run(JSON.stringify({ state: "completed", detail: "产物好了", at: now() }), now() + 999_999, w.id);
	let delivered = 0;
	let lastPrompt = "";
	W.setWaitWaker(( wk) => { delivered++; lastPrompt = wk.prompt; });
	assert.ok(W.resumeWaits() >= 1, "重启时重置补投时间");
	await W.tickWaits(now());
	await flush();
	assert.equal(delivered, 1, "重启后补投一次");
	assert.equal(W.getWait(w.id)!.delivery_status, "delivered");
	await W.tickWaits(now() + 10 * 60_000);
	await flush();
	assert.equal(delivered, 1, "补投成功后不再重复");
	assert.match(lastPrompt, /产物好了/);
});

test("取消与投递竞态：fired 后取消是 no-op，不会二次投递", async () => {
	reset();
	const w = W.registerWait("tw-a", conv, { taskId: "td4", reason: "等构建" });
	makeTask("td4", "done", "好了");
	bus.emit({ type: "task.updated", task: { id: "td4", status: "done" } });
	await flush();
	assert.equal(W.getWait(w.id)!.delivery_status, "delivered");
	assert.equal(W.cancelWait(w.id), false, "已 fired 的等待不能再取消");
	await W.tickWaits(now() + 10 * 60_000);
	await flush();
	assert.equal(wakes.length, 1, "不会二次投递");
});
