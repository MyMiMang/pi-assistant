/**
 * fast_pick_action 工具层执行路径（G1 session 透传、G2 执行前新鲜度校验、G3 执行后独立核验）。
 *
 * 用假 `ctx.executeTool` 复现工具层编排；生产钩子/执行链的正向证据在 fast-computer-guard.test.ts（真实 SDK）。
 * 不碰真实桌面、不调付费模型。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { fastComputerSettings, saveFastComputerSettings, _resetFastComputerState } from "../src/fast-computer/index.ts";
import { fastComputerExtension } from "../src/fast-computer/tool.ts";
import { createMockChooser } from "../src/fast-computer/choosers.ts";

interface El {
	element_index: number;
	role?: string;
	label?: string;
	value?: string;
	actions?: string[];
	element_token?: string;
}
const el = (i: number, role: string, label: string, token: string, extra: Partial<El> = {}): El => ({ element_index: i, role, label, value: "", actions: ["press"], element_token: token, ...extra });

interface ToolCall {
	name: string;
	args: Record<string, unknown>;
}

/** 用按次返回的窗口状态驱动工具；返回工具文本与所有底层工具调用。 */
async function runFastTool(input: {
	states: unknown[];
	chooser?: unknown;
	expected?: unknown;
	session?: string;
	signal?: AbortSignal;
	tools?: string[];
}): Promise<{ out: { content: { type: string; text?: string }[] }; calls: ToolCall[] }> {
	saveFastComputerSettings({ enabled: true, kind: "chat", provider: "p", id: "m" });
	_resetFastComputerState();
	const calls: ToolCall[] = [];
	let idx = 0;
	const toolNames = input.tools ?? ["mcp__hostpc__get_window_state", "mcp__hostpc__click"];
	const ctx = {
		tools: toolNames.map((name) => ({ name })),
		executeTool: async (name: string, args: Record<string, unknown>) => {
			calls.push({ name, args });
			if (name.endsWith("get_window_state")) {
				const structured = input.states[Math.min(idx++, input.states.length - 1)];
				return { isError: false, result: { structuredContent: structured, content: [{ type: "text", text: JSON.stringify({ element_count: (structured as { elements?: unknown[] })?.elements?.length ?? 0 }) }] } };
			}
			return { isError: false, result: { content: [{ type: "text", text: "clicked" }] } };
		},
	} as unknown as ExtensionToolContext;

	let registered: { execute: (...a: unknown[]) => Promise<{ content: { type: string; text?: string }[] }> } | undefined;
	const pi = { registerTool: (t: never) => (registered = t), on: () => {} };
	fastComputerExtension({ agentId: "test", conversationId: null, taskId: null, chooserFor: () => (input.chooser as never) ?? createMockChooser(() => ({ kind: "selected", candidateId: "el-1" })) }).factory(pi as never);
	assert.ok(registered, "工具应已注册");
	const out = await registered!.execute("id", { goal: "点登录", pid: 9, window_id: 3, session: input.session, expected: input.expected }, input.signal, undefined, ctx);
	saveFastComputerSettings({ enabled: false });
	return { out, calls };
}

const preState = { elements: [el(1, "button", "登录", "snap1:1")] };
const reState = { elements: [el(1, "button", "登录", "snap2:1")] };
const postState = { elements: [el(1, "button", "登录", "snap3:1", { value: "已登录" })] };
const textOf = (o: { content: { type: string; text?: string }[] }) => o.content.map((c) => c.text ?? "").join("\n");

test("G1：session 透传到 get_window_state 与 click 参数", async () => {
	const { calls } = await runFastTool({ states: [preState, reState, postState], session: "web" });
	const gws = calls.filter((c) => c.name.endsWith("get_window_state"));
	assert.ok(gws.length >= 2);
	assert.ok(gws.every((c) => c.args.session === "web"), "每次读窗口都要带 session");
	const click = calls.find((c) => c.name.endsWith("click"));
	assert.ok(click);
	assert.equal(click!.args.session, "web", "执行 click 也要带 session");
});

test("G2：执行前重读并用新 element_token 派发（绝不复用旧 token）", async () => {
	const { calls } = await runFastTool({ states: [preState, reState, postState] });
	const click = calls.find((c) => c.name.endsWith("click"));
	assert.ok(click);
	assert.equal(click!.args.element_token, "snap2:1");
	const gws = calls.filter((c) => c.name.endsWith("get_window_state"));
	assert.ok(gws.length >= 2, "执行前必须重新读一次窗口状态");
});

test("G2：目标变化 → 中止，零执行", async () => {
	const changed = { elements: [el(1, "button", "取消", "snap2:1")] };
	const { out, calls } = await runFastTool({ states: [preState, changed] });
	assert.equal(calls.filter((c) => c.name.endsWith("click")).length, 0, "目标变了不得派发");
	assert.match(textOf(out), /目标已变化/);
});

test("G2：目标不唯一 → 中止，零执行", async () => {
	const dup = { elements: [el(1, "button", "登录", "s2:1"), el(2, "button", "登录", "s2:2")] };
	const { out, calls } = await runFastTool({ states: [preState, dup] });
	assert.equal(calls.filter((c) => c.name.endsWith("click")).length, 0);
	assert.match(textOf(out), /目标已变化/);
});

test("G3：无 expected → 独立核验 unknown，且不宣称任务成功", async () => {
	const { out } = await runFastTool({ states: [preState, reState, postState] });
	assert.match(textOf(out), /独立核验：unknown/);
	assert.ok(!/后置条件已满足|任务完成|成功/.test(textOf(out)), "无 expected 不得宣称成功");
});

test("G3：expected 满足 → confirmed", async () => {
	const { out } = await runFastTool({ states: [preState, reState, postState], expected: { role: "button", label_contains: "登录", value_equals: "已登录" } });
	assert.match(textOf(out), /独立核验：confirmed/);
	assert.match(textOf(out), /后置条件已满足/);
});

test("G3：expected 不满足 → unsatisfied，不重复操作", async () => {
	const { out, calls } = await runFastTool({ states: [preState, reState, postState], expected: { value_equals: "从未出现的值" } });
	assert.match(textOf(out), /独立核验：unsatisfied/);
	assert.equal(calls.filter((c) => c.name.endsWith("click")).length, 1, "核验不满足时也不得重复点击");
});

test("执行前重查：signal 已中止 → 零执行", async () => {
	const ac = new AbortController();
	ac.abort();
	const { out, calls } = await runFastTool({ states: [preState, reState, postState], signal: ac.signal });
	assert.equal(calls.filter((c) => c.name.endsWith("click")).length, 0);
	assert.match(textOf(out), /已取消/);
});

test("执行前重查：异步期间动态关闭 → 零执行", async () => {
	// chooser 在作答时把设置关掉，模拟异步等待快模型期间用户关闭
	const chooser = createMockChooser(() => {
		saveFastComputerSettings({ enabled: false });
		return { kind: "selected", candidateId: "el-1" };
	});
	const { out, calls } = await runFastTool({ states: [preState, reState, postState], chooser });
	assert.equal(calls.filter((c) => c.name.endsWith("click")).length, 0);
	assert.match(textOf(out), /关闭/);
});
