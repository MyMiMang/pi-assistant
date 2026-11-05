/**
 * 快速执行者执行循环的单测：假的 `pi`（收集 registerTool）+ 假的 `ctx.executeTool` / `ctx.modelRegistry.classify`。
 * 纯逻辑本身在 quick-steps.test.ts。
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
type Classify = (context: { images?: unknown[]; state: Record<string, unknown> }) => Promise<{ stopReason: string; answers: Record<string, unknown>; errorMessage?: string }>;
interface Tool {
	name: string;
	execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<{ content: { type: string; text?: string }[]; details?: unknown }>;
}
const ok = (text = "done"): ExecResult => ({ isError: false, result: { content: [{ type: "text", text }] } });
const fail = (text: string): ExecResult => ({ isError: true, result: { content: [{ type: "text", text }] } });
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("\n");
const pick = (choice: string, p = 0.92) => async () => ({ stopReason: "stop", answers: { pick: { type: "choice", choice, probabilities: { [choice]: p }, confidence: p } } });

/** 假的 pi：只收集 registerTool 注册的工具 */
function register(o: { config?: QuickStepsConfig | null; target?: "sandbox" | "host"; browser?: boolean } = {}) {
	const tools = new Map<string, Tool>();
	const handlers: string[] = [];
	const pi = {
		registerTool: (t: Tool) => tools.set(t.name, t),
		on: (ev: string) => handlers.push(ev),
		registerMcpServer: () => {},
	};
	registerQuickSteps(pi as never, { prefix: o.target === "sandbox" ? "mcp__computer__" : HOST, target: o.target ?? "host", browser: o.browser ?? true, config: () => (o.config === undefined ? CFG : o.config) });
	return { tools, handlers };
}

function fakeCtx(exec: Exec, classify?: Classify, input: string[] = ["text"]) {
	return {
		executeTool: (name: string, args: unknown) => exec(name, args as Record<string, unknown>),
		modelRegistry: {
			findOfType: () => (classify ? { provider: CFG.provider, id: CFG.id, input } : undefined),
			classify: (_m: unknown, context: never) => classify!(context),
		},
	};
}

/** 一个会随动作变化的网页表单：名称框 / 下拉 / 提交按钮；`apply:false` 时点了也不变（核对失败用） */
function formWorld(o: { apply?: boolean } = {}) {
	const form = { name: "", res: "", clicked: 0 };
	const calls: { tool: string; args: Record<string, unknown> }[] = [];
	let n = 0;
	const exec: Exec = async (tool, args) => {
		calls.push({ tool, args });
		const name = tool.replace(HOST, "");
		if (name === "get_browser_state") {
			n++;
			const refs = [
				{ ref: `p${n}:1`, role: "textbox", name: "名称", value: form.name },
				{ ref: `p${n}:2`, role: "combobox", name: "分辨率", value: form.res },
				{ ref: `p${n}:3`, role: "button", name: "提交" },
				...(form.clicked ? [{ ref: `p${n}:4`, role: "heading", name: "已提交" }] : []),
			];
			return {
				isError: false,
				result: { content: [{ type: "text", text: "页面" }, ...(args.include_screenshot ? [{ type: "image", data: "AAA", mimeType: "image/png" }] : [])], structuredContent: { structuredContent: { refs, outline: `- textbox "名称"${form.clicked ? `\n- heading "已提交"` : ""}`, title: "表单", url: "https://example.com/f" } } },
			};
		}
		if (o.apply !== false) {
			if (name === "browser_type") form.name = String(args.text ?? "");
			else if (name === "browser_select") form.res = String(args.label ?? "");
			else if (name === "browser_click") form.clicked++;
		}
		return ok();
	};
	return { exec, calls, form, actions: () => calls.filter((c) => c.tool !== `${HOST}get_browser_state`) };
}

const THREE_STEPS = [
	{ do: "type" as const, what: "名称输入框", value: "苏折竹" },
	{ do: "select" as const, what: "分辨率下拉", value: "2K" },
	{ do: "click" as const, what: "提交" },
];

test("没配决策模型（config() 返回 null）时完全不注册工具和提示词", () => {
	const { tools, handlers } = register({ config: null });
	assert.equal(tools.size, 0);
	assert.equal(handlers.length, 0);
});

test("三步表单全部成功：调用顺序对、要填的值只来自 step、结果里有「全部 3 步做完」", async () => {
	const { tools } = register();
	const tool = tools.get("hostpc_quick_steps")!;
	const world = formWorld();
	const asked: string[] = [];
	const r = await tool.execute("id", { target: { kind: "browser", tab_id: "t1" }, steps: THREE_STEPS }, undefined, undefined, fakeCtx(world.exec, async () => (asked.push("x"), await pick(asked.length === 1 ? "c1" : "c2")())));
	assert.deepEqual(
		world.calls.map((c) => c.tool.replace(HOST, "")),
		["get_browser_state", "browser_type", "get_browser_state", "browser_select", "get_browser_state", "browser_click", "get_browser_state"],
	);
	assert.equal(world.calls.find((c) => c.tool === `${HOST}browser_type`)!.args.text, "苏折竹", "要填的值只来自 step.value");
	assert.equal(world.calls.find((c) => c.tool === `${HOST}browser_select`)!.args.label, "2K");
	assert.equal(asked.length, 2, "「名称输入框」「分辨率下拉」名字不完全一致，要问决策模型；「提交」完全一致，不问");
	const text = textOf(r);
	assert.match(text, /全部 3 步做完/);
	assert.match(text, /页面上新出现 \/ 变了的内容：\n- heading "已提交"/);
	assert.match(text, /最后的页面内容（不用再读一遍）：/);
	assert.match(text, /textbox "名称"/, "返回里带上最后一次读到的页面内容，大模型不用再读一遍");
	assert.match(text, /名字完全对上，没问决策模型/);
});

test("名字完全一致时不调用决策模型", async () => {
	const { tools } = register();
	const world = formWorld();
	let asked = 0;
	const r = await tools.get("hostpc_quick_steps")!.execute("id", { target: { kind: "browser", tab_id: "t1" }, steps: [{ do: "click", what: "提交" }] }, undefined, undefined, fakeCtx(world.exec, async () => (asked++, await pick("c3")())));
	assert.equal(asked, 0);
	assert.match(textOf(r), /全部 1 步做完/);
});

test("带图问失败 → 去掉图再问一次", async () => {
	const { tools } = register({ config: { ...CFG, images: true } });
	const world = formWorld();
	const contexts: { images?: unknown[] }[] = [];
	const classify: Classify = async (context) => {
		contexts.push(context);
		if (contexts.length === 1) return { stopReason: "error", answers: {}, errorMessage: "不支持图片" };
		return await pick("c1")();
	};
	const r = await tools.get("hostpc_quick_steps")!.execute("id", { target: { kind: "browser", tab_id: "t1" }, steps: [THREE_STEPS[0]!] }, undefined, undefined, fakeCtx(world.exec, classify, ["text", "image"]));
	assert.equal(contexts.length, 2);
	assert.equal(contexts[0]!.images?.length, 1, "第一次带图");
	assert.equal(contexts[1]!.images, undefined, "第二次不带图");
	assert.match(textOf(r), /全部 1 步做完/);
});

test("动作被拒（isError，例如审批没批准）→ 在这一步停下、后面的步骤没做、后面的动作没被调用", async () => {
	const { tools } = register();
	const world = formWorld();
	const exec: Exec = async (tool, args) => (tool === `${HOST}browser_type` ? fail("用户拒绝了这个电脑操作") : world.exec(tool, args));
	const r = await tools.get("hostpc_quick_steps")!.execute("id", { target: { kind: "browser", tab_id: "t1" }, steps: THREE_STEPS }, undefined, undefined, fakeCtx(exec, pick("c1")));
	const text = textOf(r);
	assert.match(text, /第 1 步停下/);
	assert.match(text, /用户拒绝了这个电脑操作/);
	assert.match(text, /后面的步骤没做/);
	assert.match(text, /不要换方式重试/);
	assert.deepEqual(world.actions(), [], "后面的 browser_select / browser_click 一次都没调");
});

test("决策模型把握不够 → 停下，不执行任何动作", async () => {
	const { tools } = register();
	const world = formWorld();
	const r = await tools.get("hostpc_quick_steps")!.execute("id", { target: { kind: "browser", tab_id: "t1" }, steps: [THREE_STEPS[0]!] }, undefined, undefined, fakeCtx(world.exec, pick("c1", 0.4)));
	const text = textOf(r);
	assert.match(text, /把握不够/);
	assert.deepEqual(world.actions(), []);
});

test("点击后两次观察都没变化 → 停下", async () => {
	const { tools } = register();
	const world = formWorld({ apply: false });
	const r = await tools.get("hostpc_quick_steps")!.execute("id", { target: { kind: "browser", tab_id: "t1" }, steps: [{ do: "click", what: "提交" }] }, undefined, undefined, fakeCtx(world.exec, pick("c3")));
	const text = textOf(r);
	assert.match(text, /没有变化/);
	assert.equal(world.calls.filter((c) => c.tool === `${HOST}browser_click`).length, 1, "只点了一次，没有反复重试");
	assert.equal(world.calls.filter((c) => c.tool === `${HOST}get_browser_state`).length, 3, "核对多等一次再判");
});

test("signal 已中止 → 直接停下，什么都不做", async () => {
	const { tools } = register();
	const world = formWorld();
	const ac = new AbortController();
	ac.abort();
	const r = await tools.get("hostpc_quick_steps")!.execute("id", { target: { kind: "browser", tab_id: "t1" }, steps: THREE_STEPS }, ac.signal, undefined, fakeCtx(world.exec, pick("c1")));
	assert.match(textOf(r), /已中断/);
	assert.deepEqual(world.calls, []);
});

test("不传 target：沿用上一次的目标；第一次就不传时报错文案对", async () => {
	const { tools } = register();
	const tool = tools.get("hostpc_quick_steps")!;
	const world = formWorld();
	await assert.rejects(tool.execute("id", { steps: [{ do: "click", what: "提交" }] }, undefined, undefined, fakeCtx(world.exec, pick("c3"))), /没有当前目标：先用 hostpc_quick_open 打开，或传 target/);
	await tool.execute("id", { target: { kind: "browser", tab_id: "t1" }, steps: [{ do: "click", what: "提交" }] }, undefined, undefined, fakeCtx(world.exec, pick("c3")));
	await tool.execute("id", { steps: [{ do: "click", what: "提交" }] }, undefined, undefined, fakeCtx(world.exec, pick("c3")));
	const clicks = world.calls.filter((c) => c.tool === `${HOST}browser_click`);
	assert.equal(clicks.length, 2);
	assert.equal(clicks[1]!.args.tab_id, "t1", "第二次省略 target，用的是上一次的");
});

test("工具声明自己不直接碰外部（openWorldHint:false），通用审批不会为它多弹一张卡；里面的动作照常单独审批", () => {
	const { tools } = register();
	const a = (tools.get("hostpc_quick_steps") as unknown as { annotations?: { openWorldHint?: boolean; destructiveHint?: boolean } }).annotations;
	assert.equal(a?.openWorldHint, false);
	assert.equal(a?.destructiveHint, false);
});
