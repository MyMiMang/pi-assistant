/**
 * CUA 0.35 适配：批量动作 run_steps 的逐层权限检查，以及 run_script 不暴露（不能绕过 guard）。
 * 背景：0.35 起 driver 一次调用可以跑多步（run_steps）或一段脚本（run_script）。我们的 tool_call 闸门
 * 只看得到外层工具名，所以要把批量展开成每一步，逐层套同一套 guard / 敏感动作 / 文件限制；脚本先不提供。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
await import("./setup.ts");
const { computerExtension, expandComputerSteps, HIDDEN_TOOLS, HOST_MCP_PREFIX, CUA_BROWSER_TOOLS, STEP_CHECK, STEP_UNKNOWN } = await import("@pi-assistant/ext-computer");

test("expandComputerSteps：run_steps 展开成每一步；普通工具原样；简写也认；纯检查只读；认不出的标 UNKNOWN", () => {
	assert.deepEqual(expandComputerSteps("click", { x: 1 }), [{ tool: "click", input: { x: 1 } }]);
	assert.deepEqual(expandComputerSteps("run_steps", { steps: [{ tool: "click", args: { x: 1 } }, { tool: "type_text", args: { text: "hi" } }] }), [
		{ tool: "click", input: { x: 1 } },
		{ tool: "type_text", input: { text: "hi" } },
	]);
	// 简写 {click:{…}}（0.35 官方写法）和简写 + expect
	assert.deepEqual(expandComputerSteps("run_steps", { steps: [{ click: { x: 2 } }, { hotkey: { keys: ["cmd", "shift", "q"] }, expect: [{ name: "x" }] }] }), [
		{ tool: "click", input: { x: 2 } },
		{ tool: "hotkey", input: { keys: ["cmd", "shift", "q"] } },
	]);
	// 纯检查步骤（只读）
	assert.deepEqual(expandComputerSteps("run_steps", { steps: [{ role: "button", name: "Confirm", gone: true }] }), [{ tool: STEP_CHECK, input: { role: "button", name: "Confirm", gone: true } }]);
	// 认不出的步骤 → UNKNOWN，整批拦
	assert.equal(expandComputerSteps("run_steps", { steps: [{ 奇奇怪怪: 1 }] })[0].tool, STEP_UNKNOWN);
	assert.equal(expandComputerSteps("run_steps", { steps: [{}] })[0].tool, STEP_UNKNOWN);
	// 嵌套也展开
	assert.deepEqual(expandComputerSteps("run_steps", { steps: [{ tool: "run_steps", args: { steps: [{ tool: "press_key", args: { key: "return" } }] } }] }), [{ tool: "press_key", input: { key: "return" } }]);
});

function harness(opts: { policy: () => "observe" | "all" | "sensitive" | "none"; answer?: () => { approved: boolean; scope?: "task" }; browserTools?: boolean }) {
	const asks: { toolName: string; summary: string; allowTask?: boolean }[] = [];
	const h: Record<string, (e: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>> = {};
	let cfg: { toolExposure: Record<string, string>; env: Record<string, string> } | null = null;
	computerExtension({
		target: "host",
		mcp: { command: "x", args: [] },
		isPaused: () => false,
		approvals: opts.policy,
		browserTools: opts.browserTools,
		request: async (r) => (asks.push(r), opts.answer?.() ?? { approved: true }),
		guard: { target: "host" },
	})({
		registerMcpServer: (_n: string, c: never) => (cfg = c),
		registerTool: () => {},
		on: (n: string, fn: (e: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>) => (h[n] = fn),
	} as never);
	let seq = 0;
	const call = (tool: string, input: Record<string, unknown> = {}) => h.tool_call({ toolName: `${HOST_MCP_PREFIX}${tool}`, input, toolCallId: `${tool}-${++seq}` });
	return { asks, cfg: cfg!, call };
}

test("run_script 不提供：HIDDEN_TOOLS + MCP env 关掉脚本；即使出现在批量里也直接拦、不弹审批", async () => {
	const { cfg, call, asks } = harness({ policy: () => "sensitive" });
	assert.ok(HIDDEN_TOOLS.includes("run_script"));
	assert.equal(cfg.toolExposure.run_script, "hidden");
	assert.equal(cfg.env.CUA_DRIVER_DISABLE_RUN_SCRIPT, "1", "driver 侧也关掉脚本（双保险）");
	const r = await call("run_script", { script: "return 1" });
	assert.equal(r?.block, true);
	assert.equal(asks.length, 0, "脚本不弹审批，直接拦");
	const inBatch = await call("run_steps", { steps: [{ tool: "click", args: { x: 1 } }, { tool: "run_script", args: { script: "return 1" } }] });
	assert.equal(inBatch?.block, true, "批量里夹脚本也要拦");
});

test("批量动作逐层过 guard：run_steps 里藏关机快捷键必须单独批准、不能本任务内都允许", async () => {
	let answer: { approved: boolean; scope?: "task" } = { approved: false };
	const { asks, call } = harness({ policy: () => "sensitive", answer: () => answer });
	// 普通批量（信任档位）：不问
	assert.equal(await call("run_steps", { steps: [{ tool: "click", args: { x: 1 } }, { tool: "type_text", args: { text: "hi" } }], observe: {} }), undefined);
	assert.equal(asks.length, 0);
	// 批量里藏受保护快捷键（简写写法也要认出）
	const r = await call("run_steps", { steps: [{ click: { x: 1 } }, { hotkey: { keys: ["cmd", "shift", "q"] } }], observe: {} });
	assert.equal(r?.block, true, "拒绝后整批拦下");
	assert.equal(asks.length, 1);
	assert.equal(asks[0].allowTask, false, "受保护的操作不提供本任务内都允许");
	assert.match(asks[0].summary, /受保护的操作/);
	assert.match(asks[0].summary, /hotkey/, "说明是哪一步");
	// 批准后放行
	answer = { approved: true };
	assert.equal(await call("run_steps", { steps: [{ tool: "hotkey", args: { keys: ["cmd", "shift", "q"] } }], observe: {} }), undefined);
});

test("认不出的批量步骤整批拦；纯检查步骤放行", async () => {
	const { call, asks } = harness({ policy: () => "sensitive" });
	const bad = await call("run_steps", { steps: [{ 奇奇怪怪: 1 }] });
	assert.equal(bad?.block, true);
	assert.match(bad?.reason ?? "", /认不出/);
	assert.equal(asks.length, 0, "认不出的步骤不弹审批");
	assert.equal(await call("run_steps", { steps: [{ role: "button", name: "Confirm", gone: true }] }), undefined, "纯检查是只读，放行");
});

test("批量动作里的危险点击 / 敏感动作同样按档位处理；只看档位整批拦；浏览器工具在批量里也按档位拦", async () => {
	// 信任：批量里点击「删除」按钮 → 敏感动作，要批准
	const a = harness({ policy: () => "sensitive", answer: () => ({ approved: false }) });
	const r = await a.call("run_steps", { steps: [{ tool: "click", args: { label: "删除" } }], observe: {} });
	assert.equal(r?.block, true);
	assert.equal(a.asks.length, 1);
	// 只看：批量里任何输入动作都拦
	const b = harness({ policy: () => "observe" });
	const o = await b.call("run_steps", { steps: [{ tool: "click", args: { x: 1 } }] });
	assert.equal(o?.block, true);
	assert.match(o?.reason ?? "", /只看/);
	assert.equal(b.asks.length, 0);
	// 限定（all）：不提供 cua 浏览器工具，批量里夹 browser_click 也拦
	const c = harness({ policy: () => "all", browserTools: false });
	const br = await c.call("run_steps", { steps: [{ tool: CUA_BROWSER_TOOLS[3], args: { ref: "x" } }] });
	assert.equal(br?.block, true);
	// 完全权限：批量里受保护动作也不弹
	const d = harness({ policy: () => "none" });
	assert.equal(await d.call("run_steps", { steps: [{ tool: "hotkey", args: { keys: ["cmd", "shift", "q"] } }] }), undefined);
	assert.equal(d.asks.length, 0);
});

test("CUA 0.38：get_window_state 默认不带截图（显式传了照传），run_steps 的 observe 不动，get_desktop_state 不动", async () => {
	const { call } = harness({ policy: () => "none" });
	const d: Record<string, unknown> = { pid: 1, window_id: 2 };
	await call("get_window_state", d);
	assert.equal(d.include_screenshot, false);
	const t: Record<string, unknown> = { pid: 1, window_id: 2, include_screenshot: true };
	await call("get_window_state", t);
	assert.equal(t.include_screenshot, true, "模型显式要截图就给它");
	const r: Record<string, unknown> = { steps: [{ tool: "click", args: { x: 1 } }], observe: {} };
	await call("run_steps", r);
	assert.deepEqual(r.observe, {}, "官方 observe 默认就不截图，不加字段");
	const g: Record<string, unknown> = {};
	await call("get_desktop_state", g);
	assert.equal(g.include_screenshot, undefined);
});

test("CUA 0.38：browser_select 属于浏览器工具（限定 / 信任按档位拦或审批）、get_guide 只读放行、history_* 隐藏、限定档位不给 get_guide", async () => {
	assert.ok(CUA_BROWSER_TOOLS.includes("browser_select"));
	assert.ok(HIDDEN_TOOLS.includes("history_status") && HIDDEN_TOOLS.includes("history_query"));
	const a = harness({ policy: () => "sensitive", browserTools: true, answer: () => ({ approved: false }) });
	assert.equal(await a.call("get_guide", { topic: "browser" }), undefined, "get_guide 只读，不弹审批");
	assert.equal(a.asks.length, 0);
	assert.equal(a.cfg.toolExposure.get_guide, undefined);
	assert.equal(a.cfg.toolExposure.browser_select, undefined);
	const b = harness({ policy: () => "sensitive", browserTools: false });
	assert.equal((await b.call("browser_select", { ref: "p1:2", value: "x" }))?.block, true, "没开浏览器工具时拦");
	const c = harness({ policy: () => "observe" });
	assert.equal(c.cfg.toolExposure.browser_select, "hidden", "只看档位不给输入类的 browser_select");
	const d = harness({ policy: () => "all", browserTools: false });
	assert.equal(d.cfg.toolExposure.get_guide, "hidden", "限定档位清单里没有 get_guide");
});

test("批量里的官方别名（press / type / triple_click / 键名当 tool）也归一后过敏感动作判断", async () => {
	assert.deepEqual(expandComputerSteps("run_steps", { steps: [{ tool: "press", args: { key: "return" } }, { tool: "type", args: { text: "a" } }, { tool: "triple_click", args: { x: 1 } }, { tool: "return", args: {} }] }), [
		{ tool: "press_key", input: { key: "return" } },
		{ tool: "type_text", input: { text: "a" } },
		{ tool: "click", input: { x: 1 } },
		{ tool: "press_key", input: { key: "return" } },
	]);
	// 认不出的名字不能被当成普通按键，也不能放行：标成认不出的步骤
	assert.equal(expandComputerSteps("run_steps", { steps: [{ tool: "kill_everything", args: {} }] })[0].tool, STEP_UNKNOWN);
	{
		const h = harness({ policy: () => "sensitive", answer: () => ({ approved: false }) });
		const r = await h.call("run_steps", { steps: [{ tool: "kill_everything", args: {} }] });
		assert.ok(r?.block || h.asks.length > 0, "认不出的工具名不能直接放行");
	}
	const { call, asks } = harness({ policy: () => "sensitive", answer: () => ({ approved: false }) });
	assert.equal((await call("run_steps", { steps: [{ tool: "type", args: { text: "hi\n" } }] }))?.block, true, "type 带换行 = 回车发送，要批准");
	assert.equal(asks.length, 1);
});
