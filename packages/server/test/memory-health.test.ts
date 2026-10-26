/**
 * 高级记忆健康（全部离线、假后端）：
 *  - 网关：别名请求带 reasoning "lowest"；思考块按工具调用 id 回传（只给同一个模型）；主模型失败自动换备用、连续失败后冷却；分用途错误统计
 *  - 健康：连续失败才报 failing、通知 6 小时去重、错误变了马上再提醒、恢复只发一次、换用备用模型发一次
 *  - 召回查询取最后一条真实用户消息（去掉群聊头 / 后台任务前缀）；一轮结束取最终回复
 */
process.env.PIA_MOCK = "1";
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
const { LlmProxy } = await import("../src/llm-proxy.ts");
const health = await import("../src/memory/hindsight/health.ts");
const { bus } = await import("../src/bus.ts");
const { recallQuery } = await import("../src/memory/index.ts");
const { finalReply, onlyMemoryLookup, memoryWriteOnly, memoryExtension } = await import("../../ext-memory/src/index.ts");
type Req = import("../src/pi-adapter/index.ts").ChatRequest;
type Res = import("../src/pi-adapter/index.ts").ChatResult;

const ok = (p: Partial<Res> = {}): Res => ({ text: "ok", toolCalls: [], stopReason: "stop", usage: { input: 1, output: 1 }, ...p });
const err = (e: string): Res => ({ text: "", toolCalls: [], stopReason: "error", error: e, usage: { input: 0, output: 0 } });

async function proxyWith(reply: (model: string, req: Req, n: number) => Res) {
	const seen: { model: string; req: Req }[] = [];
	const p = await new LlmProxy({
		complete: async (provider, id, req) => {
			seen.push({ model: `${provider}/${id}`, req });
			return reply(`${provider}/${id}`, req, seen.length);
		},
		listModels: () => [],
	}).start();
	const call = async (body: Record<string, unknown>) => {
		const r = await fetch(`${p.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${p.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: r.status, json: (await r.json()) as { choices?: { message: { content: string | null; tool_calls?: { id: string }[] } }[]; error?: { message: string } } };
	};
	return { p, seen, call };
}

test("网关：记忆别名关掉思考；思考块按工具调用 id 回传给同一个模型（换模型不带）", async () => {
	const { p, seen, call } = await proxyWith((_m, req, n) => (n === 1 ? ok({ text: "", toolCalls: [{ id: "call_1", name: "search_memories", arguments: { q: "x" } }], thinking: [{ type: "thinking", thinking: "想一想", thinkingSignature: "reasoning_content" }] }) : ok()));
	p.alias("memory", () => ({ provider: "a", id: "m" }));
	try {
		const tools = [{ type: "function", function: { name: "search_memories", parameters: { type: "object" } } }];
		const r1 = await call({ model: "memory", tools, messages: [{ role: "user", content: "用户喜欢什么" }] });
		assert.equal(r1.json.choices?.[0].message.tool_calls?.[0].id, "call_1");
		assert.equal(seen[0].req.reasoning, "lowest", "别名上的内部调用：思考能关就关");
		const history = [
			{ role: "user", content: "用户喜欢什么" },
			{ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "search_memories", arguments: '{"q":"x"}' } }] },
			{ role: "tool", tool_call_id: "call_1", content: "喜欢简洁" },
		];
		assert.equal((await call({ model: "memory", tools, messages: history })).status, 200);
		const asst = seen[1].req.messages.find((m) => m.role === "assistant") as { thinking?: unknown[] };
		assert.deepEqual(asst.thinking, [{ type: "thinking", thinking: "想一想", thinkingSignature: "reasoning_content" }], "第二轮把思考原样带回（DeepSeek 思考模式要求）");
		// 直接点名的模型：不强制改思考档位；不是同一个模型就不带别人的思考
		await call({ model: "b/other", tools, messages: history });
		assert.equal(seen[2].req.reasoning, undefined);
		assert.equal((seen[2].req.messages.find((m) => m.role === "assistant") as { thinking?: unknown[] }).thinking, undefined);
		assert.equal(p.stats.scopes.reflect?.requests, 3, "带工具的请求算「反思」");
	} finally {
		await p.stop();
	}
});

test("网关：主模型失败自动换备用（同一请求内）；连续失败后主模型冷却排到后面；全挂才 502 并按用途记错误", async () => {
	let primaryDown = true;
	let allDown = false;
	const { p, seen, call } = await proxyWith((m) => (allDown || (primaryDown && m === "a/main") ? err(`${m} 400 reasoning_text must be passed back`) : ok({ text: m })));
	p.alias("memory", () => [{ provider: "a", id: "main" }, { provider: "b", id: "backup" }, { provider: "a", id: "main" }]);
	const results: { model: string; ok: boolean; fallback: boolean }[] = [];
	p.onResult = (r) => results.push({ model: r.model, ok: r.ok, fallback: r.fallback });
	try {
		assert.deepEqual(p.chain("memory").map((x) => x.id), ["main", "backup"], "去重");
		const r = await call({ model: "memory", messages: [{ role: "user", content: "hi" }] });
		assert.equal(r.status, 200);
		assert.equal(r.json.choices?.[0].message.content, "b/backup");
		assert.deepEqual(results, [{ model: "a/main", ok: false, fallback: false }, { model: "b/backup", ok: true, fallback: true }]);
		await call({ model: "memory", messages: [{ role: "user", content: "hi" }] });
		await call({ model: "memory", messages: [{ role: "user", content: "hi" }] });
		const before = seen.length;
		await call({ model: "memory", messages: [{ role: "user", content: "hi" }] });
		assert.deepEqual(seen.slice(before).map((x) => x.model), ["b/backup"], "主模型连续 3 次失败 → 冷却期内直接用备用");
		primaryDown = false;
		allDown = true;
		const bad = await call({ model: "memory", response_format: { type: "json_object" }, messages: [{ role: "user", content: "hi" }] });
		assert.equal(bad.status, 502);
		assert.equal(p.stats.scopes.extract?.errors, 1, "JSON 请求算「整理事实」");
		assert.match(p.stats.scopes.extract?.lastError ?? "", /reasoning_text/);
	} finally {
		await p.stop();
	}
});

test("健康：连续失败才报 failing；通知 6 小时去重、错误变了马上提醒；恢复只发一次；换备用模型提醒一次", () => {
	health.resetHealth();
	const sent: { title: string; body: string; tag?: string }[] = [];
	health.setNotifier((n) => sent.push(n));
	const events: string[] = [];
	const off = bus.on((e: { type: string; health?: { level: string } }) => e.type === "memory.hindsight" && e.health && events.push(e.health.level));
	try {
		health.recordHealth("recall", { ok: false, ms: 20000, error: new Error("记忆召回超时") });
		assert.equal(health.memoryHealth().level, "ok", "偶发一次不打扰");
		health.recordHealth("recall", { ok: false, error: "超时" });
		health.recordHealth("recall", { ok: false, error: "超时" });
		assert.equal(health.memoryHealth().level, "failing");
		assert.equal(sent.length, 1);
		assert.equal(sent[0].tag, "memory-health");
		health.recordHealth("recall", { ok: false, error: "超时" });
		assert.equal(sent.length, 1, "同一个问题（只是次数变了）不重复提醒");
		health.recordHealth("reflect", { ok: false, error: "反思 502" });
		health.recordHealth("reflect", { ok: false, error: "反思 502" });
		health.recordHealth("recall", { ok: true, ms: 300 });
		assert.match(health.memoryHealth().summary, /反思/);
		assert.equal(sent.length, 2, "问题变了 → 马上提醒");
		health.recordHealth("reflect", { ok: true, ms: 900 });
		assert.notEqual(health.memoryHealth().level, "failing");
		assert.equal(sent.at(-1)!.title, "高级记忆已恢复");
		const n = sent.length;
		health.recordHealth("recall", { ok: true, ms: 200 });
		assert.equal(sent.length, n, "恢复只发一次");
		assert.ok(events.includes("failing") && events.at(-1) !== "failing", "等级变化推 memory.hindsight（界面角标刷新）");
		health.setActiveModel({ active: "b/backup", primary: "a/main" });
		assert.match(health.memoryHealth().summary, /已自动换成备用模型 b\/backup/);
		assert.equal(sent.at(-1)!.title, "高级记忆已换用备用模型");
		health.setActiveModel({ active: "b/backup", primary: "a/main" });
		assert.equal(sent.at(-1)!.title, "高级记忆已换用备用模型");
		const m = sent.length;
		health.setActiveModel(null);
		assert.equal(sent.length, m);
		health.setSidecarProblem("Hindsight 无响应");
		assert.equal(health.memoryHealth().level, "failing");
		assert.match(health.memoryHealth().summary, /基础记忆.*补写/);
		health.setSidecarProblem(null);
		assert.equal(health.memoryHealth().level === "failing", false);
	} finally {
		off();
		health.resetHealth();
	}
});

test("健康：召回经常超过 8 秒 → slow（不通知）", () => {
	health.resetHealth();
	const sent: unknown[] = [];
	health.setNotifier((n) => sent.push(n));
	for (let i = 0; i < 4; i++) health.recordHealth("recall", { ok: true, ms: 12000 });
	assert.equal(health.memoryHealth().level, "slow");
	assert.equal(sent.length, 0);
	health.resetHealth();
});

test("召回查询：群聊取最后一条用户消息（不带群聊头和群成员说明）；后台任务去掉前缀和附带上下文", () => {
	const room = "（群聊「周末计划」，成员：小助、小美）\n【小美】我查了天气\n【用户】周六去杭州要带什么\n——\n你是群里的一员，请简短回答。";
	assert.equal(recallQuery(room), "周六去杭州要带什么");
	assert.equal(recallQuery("（群聊「x」）\n【小美】只有助理说话\n——\n说明"), "只有助理说话");
	assert.equal(recallQuery("（后台子代理任务）整理下周的会议\n\n必要上下文：……很长"), "整理下周的会议");
	assert.equal(recallQuery("（后台帮手任务）整理下周的会议\n\n必要上下文：……很长"), "整理下周的会议", "新标记「帮手」同样去前缀");
	assert.equal(recallQuery("普通提问"), "普通提问");
	assert.equal(recallQuery("长".repeat(300)).length, 200);
});

test("一轮结束：取最后一条有文字的助理回复；出错 / 中断不写", () => {
	const a = (text: string, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], ...extra });
	assert.equal(finalReply([{ role: "user", content: "hi" }, a("先查一下"), { role: "toolResult", content: [] }, a("查到了：晴")] as never), "查到了：晴");
	assert.equal(finalReply([a("半句", { stopReason: "aborted" })] as never), "");
	assert.equal(finalReply([a("x", { stopReason: "error", errorMessage: "502" })] as never), "");
});

test("测试按钮：高级记忆还没运行时，模型两步照测、召回跳过并说明；每步有真实耗时", async () => {
	const { memorySelfTest } = await import("../src/routes/memory.ts");
	const { stopLlmProxy } = await import("../src/llm-proxy.ts");
	await (await import("../src/models.ts")).initModels();
	try {
		const steps = await memorySelfTest({ provider: "mock", id: "echo" });
		assert.deepEqual(steps.map((x) => [x.name, x.ok, !!x.skipped]), [["多轮工具调用", true, false], ["JSON 输出", true, false], ["真实召回", true, true]]);
		assert.match(steps[2].detail, /还没运行/);
	} finally {
		await stopLlmProxy();
	}
});

test("只查了记忆的一轮不自动写入；做了别的事（或没调工具）照常写入", () => {
	const call = (name: string) => ({ role: "assistant", content: [{ type: "toolCall", name, id: name, arguments: {} }] });
	const say = { role: "assistant", content: [{ type: "text", text: "搜到了 5 条" }] };
	assert.equal(onlyMemoryLookup([call("memory_recall"), { role: "toolResult", content: [] }, say] as never), true);
	assert.equal(onlyMemoryLookup([call("memory_reflect"), call("memory_recall"), say] as never), true);
	assert.equal(onlyMemoryLookup([call("memory_recall"), call("bash"), say] as never), false);
	assert.equal(onlyMemoryLookup([call("memory_remember"), say] as never), false);
	assert.equal(onlyMemoryLookup([say] as never), false);
});

test("记了/删了记忆的一轮只写用户原话（不写助理的「已记下」）；回合结束写入不阻塞 agent_end", async () => {
	const call = (name: string) => ({ role: "assistant", content: [{ type: "toolCall", name, id: name, arguments: {} }] });
	const say = { role: "assistant", content: [{ type: "text", text: "记下了：你家猫叫豆豆" }] };
	assert.equal(memoryWriteOnly([call("memory_remember"), say] as never), true);
	assert.equal(memoryWriteOnly([call("memory_recall"), call("memory_forget"), say] as never), true);
	assert.equal(memoryWriteOnly([call("memory_remember"), call("bash"), say] as never), false);
	assert.equal(memoryWriteOnly([call("memory_recall"), say] as never), false);
	assert.equal(memoryWriteOnly([say] as never), false);
	const got: { user: string; assistant: string }[] = [];
	const handlers: Record<string, (e: unknown) => unknown> = {};
	const host = { context: async () => "", remember: async () => ({ id: "x" }), recall: async () => [], forget: async () => true, retainTurn: (t: { user: string; assistant: string }) => (got.push(t), new Promise<void>(() => {})) };
	memoryExtension(host as never)({ on: (n: string, f: (e: unknown) => unknown) => void (handlers[n] = f), registerTool: () => {} } as never);
	const turn = async (msgs: unknown[]) => {
		await handlers.before_agent_start({ messageType: "user", prompt: "我家猫叫豆豆", systemPrompt: "" });
		assert.equal(handlers.agent_end({ messages: msgs }), undefined, "agent_end 必须同步返回，不等写入");
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
	};
	await turn([call("memory_remember"), say]);
	await turn([say]);
	assert.deepEqual(got, [{ user: "我家猫叫豆豆", assistant: "" }, { user: "我家猫叫豆豆", assistant: "记下了：你家猫叫豆豆" }]);
});
