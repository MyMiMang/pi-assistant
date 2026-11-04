/**
 * 目标模式执行循环的单测：假 `pi` + 假 `ctx.executeTool` / 假 `ctx.modelRegistry.classify`。
 * 纯逻辑在 quick-goal.test.ts。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";

const { registerQuickSteps } = await import("@pi-assistant/ext-computer");
type QuickStepsConfig = import("@pi-assistant/ext-computer").QuickStepsConfig;

const CFG: QuickStepsConfig = { provider: "typesafe", id: "jev-latest", images: false };
const HOST = "mcp__hostpc__";

interface ExecResult {
	isError: boolean;
	result: { content: { type: string; text?: string; data?: string; mimeType?: string }[]; structuredContent?: unknown };
}
type Exec = (tool: string, args: Record<string, unknown>) => Promise<ExecResult>;
interface CtxShape {
	state: Record<string, unknown>;
	questions: { next: { criteria: Record<string, string> } };
}
type Classify = (context: CtxShape) => Promise<{ stopReason: string; answers: Record<string, unknown>; errorMessage?: string }>;
interface Tool {
	name: string;
	execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<{ content: { type: string; text?: string }[]; details?: unknown }>;
}
const ok = (): ExecResult => ({ isError: false, result: { content: [{ type: "text", text: "ok" }] } });
const fail = (text: string): ExecResult => ({ isError: true, result: { content: [{ type: "text", text }] } });
const out = (structuredContent: Record<string, unknown>, content: { type: string; text?: string }[] = [{ type: "text", text: "ok" }]): ExecResult => ({ isError: false, result: { content, structuredContent: { structuredContent } } });
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("\n");

const CFG_INPUTS = [
	{ name: "名称", value: "苏折竹" },
	{ name: "分辨率", value: "2K" },
	{ name: "参考图片", files: ["/a.png", "/b.png"] },
];

function register() {
	const tools = new Map<string, Tool>();
	const pi = { registerTool: (t: Tool) => tools.set(t.name, t), on: () => {}, registerMcpServer: () => {} };
	registerQuickSteps(pi as never, { prefix: HOST, target: "host", browser: true, config: () => CFG });
	return tools;
}
function fakeCtx(exec: Exec, classify: Classify) {
	return {
		executeTool: (name: string, args: unknown) => exec(name, args as Record<string, unknown>),
		modelRegistry: {
			findOfType: () => ({ provider: CFG.provider, id: CFG.id, input: ["text"] }),
			classify: (_m: unknown, context: CtxShape) => classify(context),
		},
	};
}
/** 按顺序在 criteria 里找包含关键字的动作编号 */
function chooser(keys: string[], p = 0.95): Classify {
	let i = 0;
	return async (context) => {
		const criteria = context.questions.next.criteria;
		const key = keys[Math.min(i, keys.length - 1)]!;
		i++;
		const id = Object.keys(criteria).find((k) => criteria[k]!.includes(key));
		if (!id) return { stopReason: "error", answers: {}, errorMessage: `没找到「${key}」` };
		return { stopReason: "stop", answers: { next: { type: "choice", choice: id, probabilities: { [id]: p }, confidence: p } } };
	};
}

/** 一个会随动作变化的网页表单：名称 / 分辨率 / 上传 / 提交 */
function formWorld() {
	const s = { name: "", res: "", files: 0, submitted: false };
	const calls: { tool: string; args: Record<string, unknown> }[] = [];
	let n = 0;
	const exec: Exec = async (tool, args) => {
		calls.push({ tool, args });
		const t = tool.replace(HOST, "");
		if (t === "get_browser_state") {
			n++;
			const refs: Record<string, unknown>[] = [
				{ ref: `p${n}:1`, role: "textbox", name: "名称", value: s.name },
				{ ref: `p${n}:2`, role: "combobox", name: "分辨率", value: s.res },
				{ ref: `p${n}:3`, role: "button", name: "参考图片", actions: ["upload"] },
				{ ref: `p${n}:4`, role: "button", name: "提交" },
			];
			if (s.files) refs.push({ ref: `p${n}:5`, role: "heading", name: "已上传" });
			if (s.submitted) refs.push({ ref: `p${n}:6`, role: "heading", name: "已提交" });
			return out({ refs, outline: `- form\n  - textbox "名称"${s.submitted ? `\n  - heading "已提交"` : ""}`, title: "表单", url: "https://example.com/f" }, [{ type: "text", text: "页面" }]);
		}
		if (t === "browser_type") s.name = String(args.text ?? "");
		else if (t === "browser_select") s.res = String(args.label ?? "");
		else if (t === "browser_set_input_files") s.files = (args.files as string[]).length;
		else if (t === "browser_click") s.submitted = true;
		return ok();
	};
	return { exec, calls, actions: () => calls.filter((c) => c.tool !== `${HOST}get_browser_state` && c.tool !== `${HOST}browser_pointer`) };
}

test("表单目标模式：依次填名称 → 选分辨率 → 上传 → 点提交 → finish；值来自 inputs、结果带最后的页面内容", async () => {
	const world = formWorld();
	const r = await register().get("hostpc_quick_steps")!.execute(
		"id",
		{ target: { kind: "browser", tab_id: "t1" }, goal: "把表单填好并提交", inputs: CFG_INPUTS },
		undefined,
		undefined,
		fakeCtx(world.exec, chooser(["里填「名称」的值", "在「分辨率」里选", "文件传到", "点击button「提交」", "目标已经完成"])),
	);
	assert.deepEqual(world.actions().map((c) => c.tool.replace(HOST, "")), ["browser_type", "browser_select", "browser_set_input_files", "browser_click"]);
	assert.equal(world.calls.find((c) => c.tool === `${HOST}browser_type`)!.args.text, "苏折竹", "值只来自 inputs");
	assert.equal((world.calls.find((c) => c.tool === `${HOST}browser_set_input_files`)!.args.files as string[]).length, 2);
	const text = textOf(r);
	assert.match(text, /成功：决策模型认为目标已完成/);
	assert.match(text, /最后的页面内容（不用再读一遍）：/);
	assert.match(text, /已提交/);
	assert.equal((r as unknown as { details: { mode: string; pending: number[] } }).details.mode, "goal");
	assert.deepEqual((r as unknown as { details: { pending: number[] } }).details.pending, []);
});

test("abstain → 停下，结果里有还没用上的值", async () => {
	const world = formWorld();
	const r = await register().get("hostpc_quick_steps")!.execute(
		"id",
		{ target: { kind: "browser", tab_id: "t1" }, goal: "填表", inputs: CFG_INPUTS.slice(0, 1) },
		undefined,
		undefined,
		fakeCtx(world.exec, chooser(["拿不准"])),
	);
	const text = textOf(r);
	assert.match(text, /停下：决策模型拿不准/);
	assert.match(text, /还没用上的值：名称/);
	assert.deepEqual(world.actions(), []);
});

test("概率 < 0.6 → 停下，不执行动作", async () => {
	const world = formWorld();
	const r = await register().get("hostpc_quick_steps")!.execute(
		"id",
		{ target: { kind: "browser", tab_id: "t1" }, goal: "填表", inputs: CFG_INPUTS.slice(0, 1) },
		undefined,
		undefined,
		fakeCtx(world.exec, chooser(["里填「名称」的值"], 0.3)),
	);
	const text = textOf(r);
	assert.match(text, /把握不够/);
	assert.deepEqual(world.actions(), []);
});

test("动作 isError（审批被拒）→ 停下，后面不再调用动作", async () => {
	const world = formWorld();
	const exec: Exec = async (tool, args) => (tool === `${HOST}browser_type` ? fail("用户拒绝了这个电脑操作") : world.exec(tool, args));
	const r = await register().get("hostpc_quick_steps")!.execute(
		"id",
		{ target: { kind: "browser", tab_id: "t1" }, goal: "填表", inputs: CFG_INPUTS.slice(0, 1) },
		undefined,
		undefined,
		fakeCtx(exec, chooser(["里填「名称」的值", "里选「"])) ,
	);
	const text = textOf(r);
	assert.match(text, /用户拒绝了这个电脑操作/);
	assert.match(text, /不要换方式重试/);
	assert.deepEqual(world.actions().map((c) => c.tool).filter((t) => t !== `${HOST}browser_type`), [], "被拒后没有后续动作工具被调用");
});

test("同一页面指纹出现超过 3 次 → 停下「页面一直没变化」", async () => {
	const world = formWorld();
	const r = await register().get("hostpc_quick_steps")!.execute(
		"id",
		{ target: { kind: "browser", tab_id: "t1" }, goal: "看更多", inputs: [] },
		undefined,
		undefined,
		fakeCtx(world.exec, chooser(["往下滚动"])),
	);
	assert.match(textOf(r), /页面一直没变化/);
	assert.ok(world.calls.filter((c) => c.tool === `${HOST}browser_pointer`).length <= 3);
});

test("max_steps 用完 → 停下「步数用完了」", async () => {
	let n = 0;
	const exec: Exec = async (tool) => {
		const t = tool.replace(HOST, "");
		if (t === "get_browser_state") {
			n++;
			return out({ refs: [{ ref: `p${n}:1`, role: "heading", name: `第 ${n} 节` }] });
		}
		return ok();
	};
	const r = await register().get("hostpc_quick_steps")!.execute(
		"id",
		{ target: { kind: "browser", tab_id: "t1" }, goal: "看更多", inputs: [], max_steps: 2 },
		undefined,
		undefined,
		fakeCtx(exec, chooser(["往下滚动"])),
	);
	assert.match(textOf(r), /步数用完了/);
});

test("连续两次 reobserve → 停下", async () => {
	const world = formWorld();
	const r = await register().get("hostpc_quick_steps")!.execute(
		"id",
		{ target: { kind: "browser", tab_id: "t1" }, goal: "填表", inputs: [] },
		undefined,
		undefined,
		fakeCtx(world.exec, chooser(["等一下再看"])),
	);
	assert.match(textOf(r), /页面一直没准备好/);
});

test("scroll：网页调 browser_pointer，窗口调 scroll", async () => {
	const web = formWorld();
	await register().get("hostpc_quick_steps")!.execute("id", { target: { kind: "browser", tab_id: "t1" }, goal: "看更多", inputs: [], max_steps: 1 }, undefined, undefined, fakeCtx(web.exec, chooser(["往下滚动"])));
	const pointer = web.calls.find((c) => c.tool === `${HOST}browser_pointer`)!;
	assert.equal(pointer.args.action, "scroll");
	assert.equal(pointer.args.delta_y, 600);
	assert.equal(pointer.args.tab_id, "t1");

	const calls: { tool: string; args: Record<string, unknown> }[] = [];
	const exec: Exec = async (tool, args) => {
		calls.push({ tool, args });
		if (tool.replace(HOST, "") === "get_window_state") return out({ elements: [{ element_token: "s1:1", role: "textbox", label: "名称" }] });
		return ok();
	};
	await register().get("hostpc_quick_steps")!.execute("id", { target: { kind: "window", pid: 7, window_id: 8 }, goal: "看更多", inputs: [], max_steps: 1 }, undefined, undefined, fakeCtx(exec, chooser(["往下滚动"])));
	const scroll = calls.find((c) => c.tool === `${HOST}scroll`)!;
	assert.deepEqual(scroll.args, { pid: 7, window_id: 8, direction: "down", by: "page" });
});
