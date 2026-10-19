/**
 * runtime.ts 拆分（纯重构）的结构测试：门面对外导出不变、各子模块在 600 行内、
 * 子模块之间的循环引用只在调用时才用（先 import 任意子模块也不会因加载顺序报错）。
 * 临时数据目录（setup.ts），不跑模型。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const DIR = join(import.meta.dirname, "../src/agent-runtime");

test("先单独加载子模块（循环引用不在模块顶层求值）", async () => {
	const ext = await import("../src/agent-runtime/extensions.ts");
	assert.equal(typeof ext.extensionsFor, "function");
	const bg = await import("../src/agent-runtime/background-tasks.ts");
	assert.equal(typeof bg.tasks.spawn, "function");
	const ar = await import("../src/agent-runtime/agent-runtime.ts");
	assert.ok(ar.runtimes instanceof Map);
});

test("门面导出与拆分前一致，且与子模块是同一个对象", async () => {
	const rt = await import("../src/runtime.ts");
	const expected = ["agentBusy", "bindSession", "bootstrap", "describeRoutine", "disposeConversationRuntime", "disposeRuntime", "getAgent", "getTask", "initHostAccessWatch", "listAgents", "runtime", "setRoomHooks", "tasks"];
	assert.deepEqual(Object.keys(rt).sort(), expected);
	const ar = await import("../src/agent-runtime/agent-runtime.ts");
	const bg = await import("../src/agent-runtime/background-tasks.ts");
	assert.equal(rt.runtime, ar.runtime);
	assert.equal(rt.tasks, bg.tasks);
	// 门面创建的运行时与子模块共享同一张表（状态没有被复制成两份）
	const r = rt.runtime("split-test-agent", "split-test-conv");
	assert.equal(ar.runtimes.get("split-test-conv"), r);
	await rt.disposeConversationRuntime("split-test-conv");
	assert.equal(ar.runtimes.has("split-test-conv"), false);
	assert.equal(rt.describeRoutine({ trigger: "webhook" }), "收到 Webhook 请求时执行");
});

test("每个子模块都在 600 行以内", () => {
	for (const f of readdirSync(DIR)) {
		const n = readFileSync(join(DIR, f), "utf8").split("\n").length;
		assert.ok(n <= 600, `${f}: ${n} 行`);
	}
});
