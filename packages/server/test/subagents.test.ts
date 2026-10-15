import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Subagent, SubagentEvent } from "../src/subagents.ts";
process.env.PIA_MOCK = "1";
const { db, getSetting, setSetting } = await import("../src/db.ts");
const { initModels } = await import("../src/models.ts");
await initModels();
const s = await import("../src/subagents.ts");
const { createConversation } = await import("../src/conversations.ts");
const { listMessages, insertMessage } = await import("../src/messages.ts");
const { recordUsage, usageSummary } = await import("../src/usage/index.ts");
db.prepare("INSERT INTO agents(id, name, avatar, color, persona, created_at) VALUES(?,?,'🔧','#888','',?)").run("sub-test", "测试", Date.now());
const conv = createConversation("sub-test").id;
const model = { provider: "mock", id: "echo" };
const tick = () => new Promise((r) => setTimeout(r, 20));
const status = (id: string) => s.getSubagent(id)!.status;
const events = (id: string) => db.prepare("SELECT * FROM subagent_events WHERE subagent_id = ?").all(id);
const spawn = () => s.spawnSubagent("sub-test", conv, model, { task: "写代码" });
/** 设置全局设置（含并发上限）；不传 maxConcurrent 时保留当前上限（不重置）。 */
const setSettings = (maxConcurrent?: number) => s.saveSubagentSettings({ maxMinutes: 60, ...(maxConcurrent === undefined ? {} : { maxConcurrent }) });
const cleanup = () => s.stopAgentSubagents("sub-test");

// 可控 driver：run 一直挂着，直到显式完成（completeNext）或停止；记录启动过的 id、续聊输入与插话。
let started: string[] = [];
let inputs: { text: string; messageId?: string }[] = [];
let steers: { text: string; messageId?: string }[] = [];
let resolvers: ((v: string) => void)[] = [];
function manualDriver(notify: (r: Subagent, e: SubagentEvent) => Promise<void> = async () => {}) {
	started = []; inputs = []; steers = []; resolvers = [];
	s.setSubagentDriver({
		run: (r, connect, input) => {
			started.push(r.id);
			if (input) inputs.push(input);
			return new Promise<string>((resolve) => { resolvers.push(resolve); connect(async () => resolve("停止"), async (text, messageId) => { steers.push({ text, messageId }); }); });
		},
		notify,
	});
}
const completeNext = () => { resolvers.shift()?.("结果"); };

test("模型选择：默认跟随主会话、候选池内自动挑并给出 fallback 顺序、显式限制在池内、旧形状兼容", () => {
	// 默认（没设候选池）→ 跟随主会话当前模型，不做自动挑选
	assert.equal(s.chooseSubagentModel("sub-test", model, "写代码").model.id, "echo");
	assert.equal(s.chooseSubagentModel("sub-test", model, "写代码").reason, "跟随主会话模型");
	// 设了候选池 → 池内按能力挑，pool 的第一项就是实际用的，后面是 fallback 顺序
	s.saveAgentSubagentPool("sub-test", { pool: [{ provider: "mock", id: "echo-think" }] });
	const single = s.chooseSubagentModel("sub-test", model, "推理");
	assert.equal(single.model.id, "echo-think");
	assert.deepEqual(single.pool, [{ provider: "mock", id: "echo-think" }]);
	// 显式指定必须在池内（池外模型明确拒绝，不偷偷切换）
	assert.throws(() => s.chooseSubagentModel("sub-test", model, "", [], model), /候选池/);
	s.saveAgentSubagentPool("sub-test", { pool: [{ provider: "mock", id: "echo" }, { provider: "mock", id: "echo-think" }] });
	const two = s.chooseSubagentModel("sub-test", model, "写代码");
	assert.equal(two.pool.length, 2);
	assert.equal(two.pool[0].id, two.model.id);
	assert.equal(new Set(two.pool.map((m) => m.id)).size, 2);
	// 旧单模型形状读成单项池（迁移兼容）
	s.saveAgentSubagentChoice("sub-test", { mode: "fixed", model: { provider: "mock", id: "echo-think" } });
	assert.deepEqual(s.agentSubagentPool("sub-test"), [{ provider: "mock", id: "echo-think" }]);
	s.saveAgentSubagentChoice("sub-test", { mode: "follow" });
	assert.deepEqual(s.agentSubagentPool("sub-test"), []);
	setSettings(10);
});

test("子代理思考强度：每助理默认跟随/指定、单个覆盖优先、按实际模型 clamp、spawn 参数校验", async () => {
	// 默认跟随主会话
	assert.deepEqual(s.agentSubagentThinking("sub-test"), { mode: "follow" });
	// 助理默认固定档位
	assert.deepEqual(s.saveAgentSubagentThinking("sub-test", { mode: "fixed", level: "high" }), { mode: "fixed", level: "high" });
	assert.deepEqual(s.agentSubagentThinking("sub-test"), { mode: "fixed", level: "high" });
	assert.throws(() => s.saveAgentSubagentThinking("sub-test", { mode: "fixed", level: "bogus" }), /思考强度/);
	// 固定档位生效；单个子代理覆盖优先于助理默认
	assert.equal(s.resolveSubagentThinking("sub-test", { provider: "mock", id: "echo-think" }, "low"), "high");
	assert.equal(s.resolveSubagentThinking("sub-test", { provider: "mock", id: "echo-think" }, "low", "minimal"), "minimal");
	// 跟随时继承主会话当前档位
	s.saveAgentSubagentThinking("sub-test", { mode: "follow" });
	assert.equal(s.resolveSubagentThinking("sub-test", { provider: "mock", id: "echo-think" }, "low"), "low");
	// 不支持推理的模型一律 clamp 成 off（不会出现 xhigh/max）；推理模型按支持的档位收敛
	assert.equal(s.resolveSubagentThinking("sub-test", { provider: "mock", id: "echo" }, "xhigh"), "off");
	assert.equal(s.resolveSubagentThinking("sub-test", { provider: "mock", id: "echo-think" }, "xhigh"), "high");
	// spawn 的 thinking 参数：合法落库，非法直接拒绝
	manualDriver();
	s.saveAgentSubagentPool("sub-test", { pool: [] });
	assert.throws(() => s.spawnSubagent("sub-test", conv, model, { task: "x", thinking: "bogus" }), /思考强度/);
	const withThinking = s.spawnSubagent("sub-test", conv, model, { task: "带强度", thinking: "low" });
	assert.equal(s.getSubagent(withThinking.id)!.thinking, "low");
	const follow = s.spawnSubagent("sub-test", conv, model, { task: "不传强度" });
	assert.equal(s.getSubagent(follow.id)!.thinking, null);
	await cleanup();
});

test("运行中改子代理思考：落库覆盖并即时 apply（走 driver 的 apply，不动主会话）", async () => {
	const applied: { model: { provider: string; id: string }; thinking: string }[] = [];
	s.setSubagentDriver({
		run: (_r, connect) => new Promise<string>((resolve) => { connect(async () => resolve("停止"), async () => {}, async (m, thinking) => { applied.push({ model: m as { provider: string; id: string }, thinking }); }); }),
		notify: async () => {},
	});
	s.saveAgentSubagentPool("sub-test", { pool: [] });
	const r = s.spawnSubagent("sub-test", conv, { provider: "mock", id: "echo-think" }, { task: "思考任务" });
	await tick();
	assert.equal(s.getSubagent(r.id)!.thinking, null);
	// 设为固定档位 → 落库
	assert.equal(s.setSubagentThinkingOverride(r.id, "high").thinking, "high");
	assert.throws(() => s.setSubagentThinkingOverride(r.id, "bogus"), /思考强度/);
	// 运行中立即切换
	assert.equal(await s.applyLiveSubagentThinking(r.id, "high"), true);
	assert.deepEqual(applied.at(-1), { model: { provider: "mock", id: "echo-think" }, thinking: "high" });
	// 清回跟随（null）后不再 apply 覆盖，但仍可即时切换助理默认解析值
	assert.equal(s.setSubagentThinkingOverride(r.id, null).thinking, null);
	await s.stopSubagent(r.id);
	await cleanup();
});

test("并发上限：满额第 4 个排队，唯一终态、通知失败后重投，历史步骤不混入主会话且用量归属助理", async () => {
	setSettings(3);
	let attempts = 0;
	manualDriver(async () => { if (++attempts === 1) throw new Error("暂时投递失败"); });
	const rows = [spawn(), spawn(), spawn()];
	const queued = spawn();
	assert.equal(queued.status, "queued");
	assert.equal(queued.queuedAhead, 0);
	await tick();
	assert.deepEqual(started, rows.map((r) => r.id));
	assert.equal(s.finishSubagent(rows[0].id, "done", "", "结果"), true);
	assert.equal(s.finishSubagent(rows[0].id, "failed", "迟到的错误"), false);
	await tick();
	// 释放一个名额后，排队的第 4 个自动开始，不需要用户再派
	assert.equal(status(queued.id), "running");
	assert.equal(started.filter((id) => id === queued.id).length, 1);
	assert.equal(events(rows[0].id).length, 1);
	await s.deliverSubagentEvents(); await tick();
	assert.ok((events(rows[0].id)[0] as { delivered_at: number }).delivered_at);
	const hidden = insertMessage({ agentId: "sub-test", conversationId: conv, subagentId: rows[0].id, role: "assistant", content: "后台步骤" });
	assert.ok(!listMessages("sub-test", { conversationId: conv }).some((m) => m.id === hidden.id));
	recordUsage({ agentId: "sub-test", conversationId: conv, subagentId: rows[0].id, provider: "mock", model: "echo", input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
	assert.equal(usageSummary({ agentId: "sub-test" }).totals.calls, 1);
	assert.equal((db.prepare("SELECT subagent_id FROM usage_calls WHERE agent_id = 'sub-test'").get() as { subagent_id: string }).subagent_id, rows[0].id);
	await cleanup();
});

test("并发上限默认 10：第 11 个排队，完成后按 FIFO 自动派发且不重复", async () => {
	// 清掉已存设置 = 全新安装：没有 maxConcurrent 时读出来就是默认 10
	db.prepare("DELETE FROM settings WHERE key = 'subagentModels'").run();
	assert.equal(s.subagentSettings().maxConcurrent, 10);
	manualDriver();
	const rows = Array.from({ length: 12 }, () => spawn());
	await tick();
	assert.equal(started.length, 10);
	assert.deepEqual(rows.slice(10).map((r) => r.status), ["queued", "queued"]);
	assert.equal(rows[10].queuedAhead, 0);
	assert.equal(rows[11].queuedAhead, 1);
	// 再 pump 不会重复派发
	s.pumpSubagents("sub-test"); await tick();
	assert.equal(started.length, 10);
	// 完成第 1 个 → 队列第一个自动开始
	s.finishSubagent(rows[0].id, "done", "", "ok"); await tick();
	assert.equal(status(rows[10].id), "running");
	assert.equal(started.filter((id) => id === rows[10].id).length, 1);
	assert.equal(started.length, 11);
	s.pumpSubagents("sub-test"); await tick();
	assert.equal(started.length, 11);
	await cleanup();
});

test("改变上限：调高立即派发排队，调低不打断正在跑的；非法值被拒", async () => {
	setSettings(2);
	manualDriver();
	const a = spawn(), b = spawn(), c = spawn(), d = spawn();
	await tick();
	assert.equal(started.length, 2);
	assert.equal(status(c.id), "queued");
	// 调低到 1：不杀正在跑的，也不派发排队
	setSettings(1); await tick();
	assert.equal(status(a.id), "running");
	assert.equal(status(b.id), "running");
	assert.equal(started.length, 2);
	// 调高到 4：立即补上空位
	setSettings(4); await tick();
	assert.equal(status(c.id), "running");
	assert.equal(status(d.id), "running");
	assert.equal(started.length, 4);
	// 非法边界
	assert.throws(() => setSettings(0), /并发上限/);
	assert.throws(() => setSettings(1.5), /并发上限/);
	assert.throws(() => s.saveSubagentSettings({ maxMinutes: 60, maxConcurrent: 101 }), /并发上限/);
	assert.equal(s.subagentSettings().maxConcurrent, 4);
	await cleanup();
});

test("只改最长运行时间（不传 maxConcurrent）不会重置并发上限", () => {
	setSettings(3);
	// 只改一项的界面 / 旧客户端不带 maxConcurrent
	s.saveSubagentSettings({ maxMinutes: 30 });
	assert.equal(s.subagentSettings().maxConcurrent, 3);
	assert.equal(s.subagentSettings().maxMinutes, 30);
	s.saveSubagentSettings({ maxMinutes: 60 });
	assert.equal(s.subagentSettings().maxConcurrent, 3);
	// 显式传才改：非法值仍被拒
	assert.throws(() => s.saveSubagentSettings({ maxMinutes: 60, maxConcurrent: 0 }), /并发上限/);
	assert.equal(s.subagentSettings().maxConcurrent, 3);
	setSettings(10);
});

test("停止排队的子代理：不执行、也不偷偷续跑", async () => {
	setSettings(1);
	manualDriver();
	const a = spawn(), b = spawn();
	await tick();
	assert.equal(status(b.id), "queued");
	assert.equal(await s.stopSubagent(b.id), true);
	assert.equal(status(b.id), "stopped");
	assert.ok(!started.includes(b.id));
	// 释放名额后，已停的排队任务不会被重新拉起
	s.finishSubagent(a.id, "done", "", "ok"); await tick();
	assert.equal(status(b.id), "stopped");
	assert.ok(!started.includes(b.id));
	await cleanup();
});

test("重启恢复：中断任务保留并从断点续跑（带续跑提示），取消/停止不恢复，重复调用幂等", async () => {
	setSettings(2);
	manualDriver();
	const rows = [spawn(), spawn(), spawn(), spawn()];
	await tick();
	// 模拟两个已经跑过一段、落了 session 的任务
	db.prepare("UPDATE subagents SET session_file = 'sess-1' WHERE id = ?").run(rows[0].id);
	db.prepare("UPDATE subagents SET session_file = 'sess-2' WHERE id = ?").run(rows[1].id);
	assert.deepEqual(started, [rows[0].id, rows[1].id]);
	// 一个排队的被用户停掉，重启不应该把它拉起来
	await s.stopSubagent(rows[3].id);
	assert.equal(status(rows[3].id), "stopped");
	s.recoverSubagents(); await tick();
	// 中断的两个重新排队并按容量自动续跑，原来排队的仍排队
	assert.equal(status(rows[0].id), "running");
	assert.equal(status(rows[1].id), "running");
	assert.equal(status(rows[2].id), "queued");
	assert.equal(status(rows[3].id), "stopped");
	// 续跑带的是「先检查进度」的提示，不是从头重做原任务
	const resumeInputs = inputs.filter((x) => x.text.includes("服务刚刚重启"));
	assert.equal(resumeInputs.length, 2);
	assert.ok(!resumeInputs[0].text.includes("写代码"));
	assert.match(resumeInputs[0].text, /核实|状态不明/);
	// 重复调用幂等：不会把已在续跑的任务再次入队
	const before = started.length;
	s.recoverSubagents(); await tick();
	assert.equal(started.length, before);
	await cleanup();
});

test("重启恢复：没有落库 session 的中断任务标 lost（不从头重跑），已完成的工具结果保留", async () => {
	setSettings(1);
	manualDriver();
	const r = spawn();
	await tick();
	const tool = insertMessage({ agentId: "sub-test", conversationId: conv, subagentId: r.id, role: "tool", content: "命令输出", meta: { toolName: "bash" } });
	assert.equal(s.getSubagent(r.id)!.session_file, null);
	s.recoverSubagents(); await tick();
	assert.equal(status(r.id), "lost");
	assert.match(s.getSubagent(r.id)!.error_reason ?? "", /核验/);
	// 不会从头重跑（只执行过最开始那一次）
	assert.equal(started.filter((id) => id === r.id).length, 1);
	// 已完成的工具结果不丢
	assert.ok(db.prepare("SELECT 1 FROM messages WHERE id = ?").get(tool.id));
	await cleanup();
});

test("批量停止：暂停派发，排队的任务不会被短暂启动", async () => {
	setSettings(1);
	manualDriver();
	const a = spawn(), b = spawn(), c = spawn(); // a 运行，b/c 排队
	await tick();
	assert.deepEqual(started, [a.id]);
	await s.stopAgentSubagents("sub-test");
	// 排队的 b、c 一次都没被启动过
	assert.ok(!started.includes(b.id));
	assert.ok(!started.includes(c.id));
	assert.equal(status(a.id), "stopped");
	assert.equal(status(b.id), "stopped");
	assert.equal(status(c.id), "stopped");
	await cleanup();
});

test("排队不丢任务信息：instruction、parent、conversation、模型都保留", async () => {
	setSettings(1);
	manualDriver();
	spawn(); // 占满唯一名额
	const b = s.spawnSubagent("sub-test", conv, model, { task: "排队任务", context: "必要上下文", parentMessageId: "pm-1" });
	assert.equal(b.status, "queued");
	const row = s.getSubagent(b.id)!;
	assert.equal(row.task, "排队任务");
	assert.equal(row.context, "必要上下文");
	assert.equal(row.parent_message_id, "pm-1");
	assert.equal(row.conversation_id, conv);
	assert.equal(row.agent_id, "sub-test");
	assert.equal(row.model_provider, "mock");
	assert.equal(row.model_id, "echo");
	assert.equal(row.status, "queued");
	// 排队任务也有聊天卡片和任务消息，不会丢
	assert.ok(db.prepare("SELECT 1 FROM messages WHERE json_extract(meta, '$.subagentId') = ?").get(b.id));
	assert.ok(db.prepare("SELECT 1 FROM messages WHERE subagent_id = ? AND role = 'user'").get(b.id));
	await cleanup();
});

test("满额时子窗口续聊也排队，释放后带原文继续", async () => {
	setSettings(1);
	manualDriver();
	const done = spawn();
	await tick();
	completeNext(); await tick();
	assert.equal(status(done.id), "done");
	const busy = spawn(); // 占满唯一名额
	await tick();
	assert.equal(status(busy.id), "running");
	const m = await s.sendSubagentMessage(done.id, "接着做");
	assert.equal(status(done.id), "queued");
	assert.equal(s.getSubagent(done.id)!.pending_input, JSON.stringify({ text: "接着做", messageId: m.id }));
	await assert.rejects(s.sendSubagentMessage(done.id, "再来一条"), /排队/);
	// 释放名额 → 续聊自动开始，且带原文
	s.finishSubagent(busy.id, "done", "", "ok"); await tick();
	assert.equal(status(done.id), "running");
	assert.deepEqual(inputs.at(-1), { text: "接着做", messageId: m.id });
	await cleanup();
});

test("执行抛错必进 failed，重复结束不再发事件", async () => {
	setSettings(10);
	s.setSubagentDriver({ run: async () => { throw new Error("模型接口失败"); }, notify: async () => {} });
	const r = spawn(); await tick();
	assert.equal(status(r.id), "failed");
	assert.match(s.getSubagent(r.id)!.error_reason!, /模型接口失败/);
	assert.equal(events(r.id).length, 1);
	await cleanup();
});

test("看门狗：长工具豁免、停滞、恢复、最长时间超时", async () => {
	setSettings(10);
	manualDriver();
	const r = spawn(); await tick();
	s.subagentActivity(r.id, 600_000);
	await s.checkSubagents(Date.now() + 181_000);
	assert.equal(status(r.id), "running");
	s.subagentActivity(r.id, 0);
	await s.checkSubagents(Date.now() + 181_000);
	assert.equal(status(r.id), "stalled");
	s.subagentActivity(r.id);
	assert.equal(status(r.id), "running");
	await s.checkSubagents(r.created_at + 60 * 60_000);
	assert.equal(status(r.id), "timeout");
	assert.deepEqual(events(r.id).map((e) => (e as { kind: string }).kind), ["stalled", "resumed", "timeout"]);
	await cleanup();
});

test("子窗口直聊：运行中插话、只停止自己、完成后续聊、空消息", async () => {
	setSettings(10);
	manualDriver();
	const r = spawn(), other = spawn();
	await tick();
	const m = await s.sendSubagentMessage(r.id, "子窗口补充");
	assert.deepEqual(steers, [{ text: "子窗口补充", messageId: m.id }]);
	assert.equal(m.subagent_id, r.id);
	assert.ok(!listMessages("sub-test", { conversationId: conv }).some((x) => x.id === m.id));
	await assert.rejects(s.sendSubagentMessage(r.id, "  "), /请输入/);
	await s.sendSubagentMessage(r.id, "停"); await tick();
	assert.equal(status(r.id), "stopped");
	assert.equal(status(other.id), "running");
	await s.stopSubagent(other.id); await tick();
	db.prepare("UPDATE subagents SET session_file = 'saved-child-session', created_at = 0 WHERE id = ?").run(r.id);
	let resumed: Subagent | undefined;
	let resumeInput: { text: string; messageId?: string } | undefined;
	s.setSubagentDriver({ run: async (row, _connect, input) => { resumed = row; resumeInput = input; return "续聊完成"; }, notify: async () => {} });
	const follow = await s.sendSubagentMessage(r.id, "接着做"); await tick();
	assert.equal(resumed?.session_file, "saved-child-session");
	assert.deepEqual(resumeInput, { text: "接着做", messageId: follow.id });
	assert.ok(s.getSubagent(r.id)!.run_started_at! > 0);
	assert.equal(status(r.id), "done");
	assert.deepEqual(events(r.id).map((e) => (e as { kind: string }).kind), ["stopped", "done"]);
	await cleanup();
});

test("池内 fallback 决策：可恢复故障才换、只换未试过的、用尽/单项停下、工具失败不换", () => {
	const pool = [{ provider: "mock", id: "a" }, { provider: "mock", id: "b" }, { provider: "mock", id: "c" }];
	// 限流 / 服务不可用 / 模型不存在 / 鉴权不通：换下一个未试过的
	assert.deepEqual(s.planFallback(pool, ["mock/a"], "429 Too Many Requests"), { provider: "mock", id: "b" });
	assert.deepEqual(s.planFallback(pool, ["mock/a", "mock/b"], "model not found"), { provider: "mock", id: "c" });
	assert.deepEqual(s.planFallback(pool, ["mock/a"], "503 Service Unavailable"), { provider: "mock", id: "b" });
	assert.deepEqual(s.planFallback(pool, ["mock/a"], "401 Unauthorized: invalid api key"), { provider: "mock", id: "b" });
	// 用尽候选 → null（不无限重试）
	assert.equal(s.planFallback(pool, ["mock/a", "mock/b", "mock/c"], "service unavailable"), null);
	// 单项池失败 → null（明确停下，不池外切换）
	assert.equal(s.planFallback([{ provider: "mock", id: "a" }], ["mock/a"], "503"), null);
	// 工具 / 命令失败、权限拒绝、未知错误都不是模型故障 → 不换模型
	assert.equal(s.planFallback(pool, [], "命令执行失败：ENOENT"), null);
	assert.equal(s.planFallback(pool, [], "用户拒绝了这次审批"), null);
	assert.equal(s.planFallback(pool, [], "模型返回了奇怪的输出"), null);
	// 空错误 / 没错误 → 不换
	assert.equal(s.planFallback(pool, [], undefined), null);
});

// runtime 初始化阶段失败的候选也必须算“已试过”。否则 A 初始化失败换到 B、B 请求又失败时，
// planFallback 可能把从未真正请求过的 A 再挑回来，违反“每个候选最多一次”。
test("池内 fallback：初始化失败的候选不再被请求阶段绕回（每候选最多一次）", () => {
	const pool = [{ provider: "mock", id: "a" }, { provider: "mock", id: "b" }, { provider: "mock", id: "c" }];
	// 初始化阶段：A 失败（可恢复）→ tried 记入 A；会话建在 B 上
	const tried = new Set<string>(["mock/a"]);
	tried.add("mock/b");
	// B 请求也失败：下一个应是 C，绝不能回到 A
	assert.deepEqual(s.planFallback(pool, tried, "429 Too Many Requests"), { provider: "mock", id: "c" });
	assert.notDeepEqual(s.planFallback(pool, tried, "429 Too Many Requests"), { provider: "mock", id: "a" });
	// 候选用尽 → 停下，不绕回任何已试候选
	assert.equal(s.planFallback(pool, ["mock/a", "mock/b", "mock/c"], "service unavailable"), null);
});

test("迁移旧设置：全局模型指定废弃、全局允许清单迁给无显式配置的助理、显式配置保留且幂等", () => {
	// 旧全局配置 + 旧单模型助理 + 旧跟随助理 + 新格式助理 + 一个没有显式配置的助理
	setSetting("subagentModels", { mode: "auto", allowed: [{ provider: "mock", id: "echo-think" }], maxMinutes: 42, maxConcurrent: 7 });
	setSetting("subagentModel:legacy-fixed", { mode: "fixed", model: { provider: "mock", id: "echo" } });
	setSetting("subagentModel:legacy-follow", { mode: "follow" });
	setSetting("subagentModel:new-pool", { pool: [{ provider: "mock", id: "echo" }] });
	db.prepare("INSERT OR REPLACE INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run("legacy-plain", "旧助理", "🤖", "#888", Date.now());
	s.migrateSubagentModelSettings();
	// 全局只留并发 / 超时，模型指定字段废弃
	const g = getSetting<Record<string, unknown>>("subagentModels", {});
	assert.deepEqual(Object.keys(g).sort(), ["maxConcurrent", "maxMinutes"]);
	assert.equal(g.maxMinutes, 42);
	assert.equal(g.maxConcurrent, 7);
	// 旧单模型 → 单项池；旧跟随 → 空池；新格式不动
	assert.deepEqual(s.agentSubagentPool("legacy-fixed"), [{ provider: "mock", id: "echo" }]);
	assert.deepEqual(s.agentSubagentPool("legacy-follow"), []);
	assert.deepEqual(s.agentSubagentPool("new-pool"), [{ provider: "mock", id: "echo" }]);
	// 没有显式配置的助理继承旧的全局允许清单（用户已选清单不丢）
	assert.deepEqual(s.agentSubagentPool("legacy-plain"), [{ provider: "mock", id: "echo-think" }]);
	// 幂等：再跑一次结果不变
	s.migrateSubagentModelSettings();
	assert.deepEqual(s.agentSubagentPool("legacy-plain"), [{ provider: "mock", id: "echo-think" }]);
	assert.deepEqual(Object.keys(getSetting<Record<string, unknown>>("subagentModels", {})).sort(), ["maxConcurrent", "maxMinutes"]);
	db.prepare("DELETE FROM agents WHERE id = 'legacy-plain'").run();
	setSettings(10);
});

test("切换模型记录：同一任务换模型只更新同一行，并写一条用户可见的系统消息", () => {
	setSettings(10);
	manualDriver();
	const r = spawn();
	// 换到池内另一个模型：行内 model_provider/model_id 更新，不产生新子代理、不重复卡片
	s.switchSubagentModel(r.id, { provider: "mock", id: "echo-think" }, "触发限流：429");
	const row = s.getSubagent(r.id)!;
	assert.equal(row.model_id, "echo-think");
	assert.equal(row.model_reason, "触发限流：429");
	assert.equal(s.listSubagents("sub-test", conv).filter((x) => x.id === r.id).length, 1);
	const msgs = db.prepare("SELECT content FROM messages WHERE subagent_id = ?").all(r.id) as { content: string }[];
	assert.ok(msgs.some((m) => m.content.includes("已切换到候选池内")), "切换原因对用户可见");
	assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE json_extract(meta, '$.subagentId') = ?").get(r.id)?.n, 1, "卡片只有一张");
	void s.stopSubagent(r.id);
	void cleanup();
});
