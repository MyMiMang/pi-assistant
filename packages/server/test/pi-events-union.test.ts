/**
 * Pi 1.2.0 的 before_agent_start 事件 union 适配测试。
 *
 * 1.2.0 起该事件按 messageType 分成两支：user 才有 prompt，custom（扩展用 triggerTurn 触发的
 * 唤醒回合）只有 message。这里用真实的 1.2.0 事件形状直接驱动两个 handler，验证：
 *  - ext-memory：用户回合拿原话召回；唤醒回合不读 undefined、记忆块照常注入（不被整块丢掉）
 *  - ext-skills：唤醒回合不会把上一轮用户原话再报一次给技能建议
 *
 * 不碰真实 Pi 会话 / 数据目录：只调用扩展注册的 handler，host 是内存假实现。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
const { memoryExtension } = await import("@pi-assistant/ext-memory");
const { skillsExtension } = await import("@pi-assistant/ext-skills");

/** 收集扩展注册的 handler，够用即可 */
function fakePi() {
	const handlers: Record<string, (e: never) => unknown> = {};
	return {
		handlers,
		on: (n: string, f: never) => ((handlers[n] = f), () => {}),
		registerTool: () => {},
		registerMcpServer: () => {},
	};
}

test("before_agent_start：用户回合用 prompt 召回，唤醒回合（custom）不读 undefined 也仍注入记忆块", async () => {
	const queries: string[] = [];
	const pi = fakePi();
	memoryExtension({
		context: async (prompt: string) => (queries.push(prompt), "## 关于用户与长期事实\n- [m1] (user/fact) 用户叫灯灯大王"),
		remember: async () => ({ id: "m1" }),
		recall: async () => [],
		forget: async () => true,
	} as never)(pi as never);
	const run = pi.handlers.before_agent_start as (e: unknown) => Promise<{ systemPrompt?: string } | undefined>;

	// user：真实 1.2.0 形状（有 prompt）
	const u = await run({ type: "before_agent_start", messageType: "user", prompt: "今天吃什么", systemPrompt: "基础提示" });
	assert.deepEqual(queries, ["今天吃什么"]);
	assert.match(u?.systemPrompt ?? "", /^基础提示[\s\S]*<memory>[\s\S]*灯灯大王/, "用户回合：记忆块接在系统提示后");

	// custom：真实 1.2.0 形状（没有 prompt 字段，只有 message）
	const c = await run({ type: "before_agent_start", messageType: "custom", message: { customType: "proactive", content: "该喝水了" }, systemPrompt: "基础提示" });
	assert.equal(queries.at(-1), "", "custom 回合传空 query（不能读 undefined）");
	assert.match(c?.systemPrompt ?? "", /<memory>[\s\S]*灯灯大王/, "唤醒回合仍注入 bootContext / 已记事实，不整块丢记忆");
});

test("技能观察：唤醒回合的 custom 事件不会顶替或继承用户原话", async () => {
	const seen: { userText: string }[] = [];
	const pi = fakePi();
	skillsExtension({
		list: () => [],
		get: () => undefined,
		search: () => [],
		dupThreshold: 0.8,
		save: () => ({ name: "x", path: "", version: 1 }),
		remove: () => true,
		confirmCreate: async () => false,
		confirmUpdate: async () => false,
		confirm: async () => false,
		observe: (t: { userText: string }) => seen.push(t),
	} as never)(pi as never);
	const start = pi.handlers.before_agent_start as (e: unknown) => void;
	const end = pi.handlers.agent_end as (e: unknown) => void;

	start({ type: "before_agent_start", messageType: "user", prompt: "把周报的写法做成技能", systemPrompt: "" });
	end({ type: "agent_end", messages: [] });
	assert.deepEqual(seen.map((s) => s.userText), ["把周报的写法做成技能"]);

	// 唤醒回合：custom 没有 prompt，既不能报成用户原话，也不能把上一轮原话再报一次
	start({ type: "before_agent_start", messageType: "custom", message: { customType: "task_result", content: "后台任务完成" }, systemPrompt: "" });
	end({ type: "agent_end", messages: [] });
	assert.equal(seen.length, 1, "custom 回合不产生技能建议（没有用户原话）");
});
