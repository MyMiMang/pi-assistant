import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "../src/pi-adapter/index.ts";
import { guardTools } from "../src/pi-adapter/tool-guard.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function setup(execute: ToolDefinition["execute"], opts: Parameters<typeof guardTools>[1] = {}) {
	let tool!: ToolDefinition;
	const pi = { marker: 42, ping() { return this.marker; }, registerTool(def: ToolDefinition) { tool = def; } };
	const factory: ExtensionFactory = (api) => {
		assert.equal((api as unknown as typeof pi).ping(), 42);
		api.registerTool({ name: "fake", label: "假工具", description: "测试", parameters: {} as never, execute });
	};
	await guardTools(factory, opts)(pi as unknown as ExtensionAPI);
	return tool;
}
const call = (tool: ToolDefinition, signal = new AbortController().signal) => tool.execute("id", {}, signal, undefined, {} as never);
const textOf = (value: Awaited<ReturnType<typeof call>>) => (value.content[0] as { text: string }).text;

test("停止不等待原工具，迟到的 rejection 被接住；已停止时不执行", async () => {
	let reject!: (error: Error) => void;
	let calls = 0;
	const tool = await setup(() => { calls++; return new Promise((_resolve, fail) => { reject = fail; }); });
	const controller = new AbortController();
	const pending = call(tool, controller.signal);
	controller.abort();
	assert.match(textOf(await pending), /已停止/);
	reject(new Error("迟到"));
	await sleep(0);
	assert.match(textOf(await call(tool, controller.signal)), /已停止/);
	assert.equal(calls, 1);
});

test("永不返回的工具超过累计时限后放弃", async () => {
	const tool = await setup(() => new Promise(() => {}), { stallMs: 20, tickMs: 5 });
	assert.match(textOf(await call(tool)), /已放弃/);
});

test("等待用户期间不累计，用户回答后继续累计", async () => {
	let waiting = true;
	let finished = false;
	const tool = await setup(() => new Promise(() => {}), { stallMs: 20, tickMs: 5, waitingForUser: () => waiting });
	const pending = Promise.resolve(call(tool)).then((value) => { finished = true; return value; });
	await sleep(60);
	assert.equal(finished, false);
	waiting = false;
	assert.match(textOf(await pending), /已放弃/);
});

test("正常结果保留对象身份，参数、更新回调、上下文和其他方法照常转发", async () => {
	const expected = { content: [{ type: "text" as const, text: "完成" }], details: { a: 1 } };
	let received: unknown[] = [];
	const tool = await setup(async (...args) => { received = args; return expected; });
	const controller = new AbortController();
	const params = { a: 1 };
	const update = () => {};
	const context = {} as never;
	assert.equal(await tool.execute("id", params, controller.signal, update, context), expected);
	assert.deepEqual(received, ["id", params, controller.signal, update, context]);
});

test("原工具抛错仍原样拒绝", async () => {
	const error = new Error("原始错误");
	const tool = await setup(async () => { throw error; });
	await assert.rejects(Promise.resolve(call(tool)), (actual) => actual === error);
});
