/**
 * 快速打开（*_quick_open）的单测：假 `pi` + 假 `ctx.executeTool`，断言调用顺序、绑定校验、应用启动和参数限制。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";

const { registerQuickOpen } = await import("@pi-assistant/ext-computer");
type QuickStepsConfig = import("@pi-assistant/ext-computer").QuickStepsConfig;

const CFG: QuickStepsConfig = { provider: "typesafe", id: "jev-latest", images: false };
const HOST = "mcp__hostpc__";

interface ExecResult {
	isError: boolean;
	result: { content: { type: string; text?: string }[]; structuredContent?: unknown };
}
type Exec = (tool: string, args: Record<string, unknown>) => Promise<ExecResult>;

interface Tool {
	name: string;
	parameters: { properties: Record<string, unknown> };
	execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<{ content: { type: string; text?: string }[]; details?: unknown }>;
}
const ok = (): ExecResult => ({ isError: false, result: { content: [{ type: "text", text: "ok" }] } });
const out = (structuredContent: Record<string, unknown>): ExecResult => ({ isError: false, result: { content: [{ type: "text", text: "ok" }], structuredContent: { structuredContent } } });
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("\n");

function register(o: { config?: QuickStepsConfig | null; target?: "sandbox" | "host"; browser?: boolean } = {}) {
	const tools = new Map<string, Tool>();
	const pi = { registerTool: (t: Tool) => tools.set(t.name, t), on: () => {}, registerMcpServer: () => {} };
	registerQuickOpen(pi as never, { prefix: o.target === "sandbox" ? "mcp__computer__" : HOST, target: o.target ?? "host", browser: o.browser ?? true, config: () => (o.config === undefined ? CFG : o.config) });
	return tools;
}
const ctxOf = (exec: Exec) => ({ executeTool: (name: string, args: unknown) => exec(name, args as Record<string, unknown>), modelRegistry: {} });
const short = (tool: string) => tool.replace(HOST, "");

function webWorld(o: { binding?: Record<string, unknown> } = {}) {
	const calls: { tool: string; args: Record<string, unknown> }[] = [];
	let snapshots = 0;
	const exec: Exec = async (tool, args) => {
		calls.push({ tool, args });
		const n = short(tool);
		if (n === "browser_prepare") return out({ prepared_pid: 42 });
		if (n === "list_windows") return out({ windows: [{ window_id: 7, pid: 42, z_index: 3, app_name: "Chrome", title: "Chrome", is_on_screen: true }] });
		if (n === "get_browser_state") {
			if (args.snapshot_format === "semantic_v2") {
				snapshots++;
				return out({ refs: [{ ref: `p${snapshots}:1`, role: "textbox", name: "名称" }], content_refs: [], outline: '- textbox "名称"', title: "表单", url: "https://example.com/f" });
			}
			return out(o.binding ?? { target_id: "g1", tabs: [{ tab_id: "t1", active: true, url: "about:blank", title: "" }], binding_quality: "exact", mutation_allowed: true });
		}
		return ok();
	};
	return { exec, calls };
}

test("网页 isolated：browser_prepare → list_windows → 绑定 → navigate → 读页面；返回 target 和页面内容", async () => {
	const tools = register();
	const world = webWorld();
	const r = await tools.get("hostpc_quick_open")!.execute("id", { url: "https://example.com/f" }, undefined, undefined, ctxOf(world.exec));
	assert.deepEqual(world.calls.map((c) => short(c.tool)), ["browser_prepare", "list_windows", "get_browser_state", "browser_navigate", "get_browser_state"]);
	assert.deepEqual(world.calls[0]!.args.profile, { mode: "isolated_new" });
	assert.equal(world.calls[2]!.args.window_id, 7);
	assert.equal(world.calls[3]!.args.url, "https://example.com/f");
	assert.equal(world.calls[4]!.args.snapshot_format, "semantic_v2");
	const text = textOf(r);
	assert.match(text, /已打开：https:\/\/example.com\/f/);
	assert.match(text, /target（传给 hostpc_quick_steps）：\{"kind":"browser","tab_id":"t1","target_id":"g1","session":"quick-/);
	assert.match(text, /页面内容：- textbox "名称"/);
	const details = (r as unknown as { details: { target: { tab_id: string } } }).details;
	assert.equal(details.target.tab_id, "t1");
});

test("网页 user：先找 Chrome 窗口再按现有资料绑定", async () => {
	const tools = register();
	const world = webWorld();
	await tools.get("hostpc_quick_open")!.execute("id", { url: "https://example.com", browser: "user" }, undefined, undefined, ctxOf(world.exec));
	assert.equal(short(world.calls[0]!.tool), "list_windows");
	assert.equal(world.calls[0]!.args.app, "Chrome");
	assert.deepEqual(world.calls[1]!.args.strategy, { kind: "existing_profile" });
});

test("绑定不是 exact → 报错并带上 hint", async () => {
	const tools = register();
	const world = webWorld({ binding: { target_id: "g1", tabs: [], binding_quality: "heuristic", mutation_allowed: false, hint: "先检查浏览器权限" } });
	await assert.rejects(tools.get("hostpc_quick_open")!.execute("id", { url: "https://example.com" }, undefined, undefined, ctxOf(world.exec)), /先检查浏览器权限/);
});

test("应用：launch_app 用 name / bundle_id；list_windows → get_window_state", async () => {
	const tools = register();
	const appWorld = (launched: Record<string, unknown>) => {
		const calls: { tool: string; args: Record<string, unknown> }[] = [];
		const exec: Exec = async (tool, args) => {
			calls.push({ tool, args });
			const n = short(tool);
			if (n === "launch_app") return out(launched);
			if (n === "list_windows") return out({ windows: [{ window_id: 7, pid: 99, z_index: 1 }] });
			if (n === "get_window_state") return out({ elements: [{ element_token: "s1:1", role: "button", label: "确定" }] });
			return ok();
		};
		return { exec, calls };
	};
	const byName = appWorld({ pid: 99 });
	const r = await tools.get("hostpc_quick_open")!.execute("id", { app: "计算器" }, undefined, undefined, ctxOf(byName.exec));
	assert.equal(byName.calls[0]!.args.name, "计算器");
	assert.deepEqual(byName.calls.map((c) => short(c.tool)), ["launch_app", "list_windows", "get_window_state"]);
	assert.match(textOf(r), /target（传给 hostpc_quick_steps）：\{"kind":"window","pid":99,"window_id":7\}/);
	assert.match(textOf(r), /button「确定」/);
	const byBundle = appWorld({ pid: 99 });
	await tools.get("hostpc_quick_open")!.execute("id", { app: "com.apple.calculator" }, undefined, undefined, ctxOf(byBundle.exec));
	assert.equal(byBundle.calls[0]!.args.bundle_id, "com.apple.calculator");
	assert.equal(byBundle.calls[0]!.args.name, undefined);
});

test("应用：launch_app 没返回进程号时用 list_windows {app} 找", async () => {
	const tools = register();
	const calls: { tool: string; args: Record<string, unknown> }[] = [];
	const exec: Exec = async (tool, args) => {
		calls.push({ tool, args });
		const n = short(tool);
		if (n === "launch_app") return out({});
		if (n === "list_windows" && args.app) return out({ windows: [{ window_id: 7, pid: 55, z_index: 0 }] });
		if (n === "list_windows") return out({ windows: [{ window_id: 7, pid: 55, z_index: 1 }] });
		if (n === "get_window_state") return out({ elements: [{ element_token: "s1:1", role: "button", label: "1" }] });
		return ok();
	};
	await tools.get("hostpc_quick_open")!.execute("id", { app: "计算器" }, undefined, undefined, ctxOf(exec));
	assert.deepEqual(calls.map((c) => short(c.tool)), ["launch_app", "list_windows", "list_windows", "get_window_state"]);
	assert.equal(calls[1]!.args.app, "计算器");
	assert.equal(calls[2]!.args.pid, 55);
});

test("url 和 app 都给 / 都不给 → 报错；sandbox 的参数里没有 url", async () => {
	const tools = register();
	const world = webWorld();
	await assert.rejects(tools.get("hostpc_quick_open")!.execute("id", { url: "https://a", app: "计算器" }, undefined, undefined, ctxOf(world.exec)), /恰好给一个/);
	await assert.rejects(tools.get("hostpc_quick_open")!.execute("id", {}, undefined, undefined, ctxOf(world.exec)), /恰好给一个/);
	await assert.rejects(tools.get("hostpc_quick_open")!.execute("id", { url: "ftp://a" }, undefined, undefined, ctxOf(world.exec)), /只支持/);
	const sandbox = register({ target: "sandbox", browser: false });
	const tool = sandbox.get("computer_quick_open")!;
	assert.equal(tool.parameters.properties.url, undefined, "sandbox 的参数里没有 url");
	assert.equal(tool.parameters.properties.browser, undefined);
});

test("config() 为 null 时不注册", () => {
	const tools = register({ config: null });
	assert.equal(tools.size, 0);
});

test("网页 user：不替换用户正在看的标签页，没有空白标签页就报错；有空白页就用它", async () => {
	const tools = register();
	const busy = webWorld({ binding: { target_id: "g1", tabs: [{ tab_id: "t1", active: true, url: "https://mail.example.com/draft", title: "写信" }], binding_quality: "exact", mutation_allowed: true } });
	await assert.rejects(tools.get("hostpc_quick_open")!.execute("id", { url: "https://example.com", browser: "user" }, undefined, undefined, ctxOf(busy.exec)), /没有空白标签页/);
	assert.ok(!busy.calls.some((c) => short(c.tool) === "browser_navigate"), "不导航用户的标签页");
	const free = webWorld({ binding: { target_id: "g1", tabs: [{ tab_id: "t1", active: true, url: "https://mail.example.com/draft" }, { tab_id: "t2", active: false, url: "chrome://newtab/" }], binding_quality: "exact", mutation_allowed: true } });
	await tools.get("hostpc_quick_open")!.execute("id", { url: "https://example.com", browser: "user" }, undefined, undefined, ctxOf(free.exec));
	assert.equal(free.calls.find((c) => short(c.tool) === "browser_navigate")!.args.tab_id, "t2");
});

test("刚打开读到空页面：等一下再读，读到元素就停；file: 网址和带点的应用名按规则处理", async () => {
	const tools = register();
	let reads = 0;
	const calls: { tool: string; args: Record<string, unknown> }[] = [];
	const exec: Exec = async (tool, args) => {
		calls.push({ tool, args });
		const n = short(tool);
		if (n === "launch_app") return out({ pid: 9 });
		if (n === "list_windows") return out({ windows: [{ window_id: 3, pid: 9, z_index: 1 }] });
		if (n === "get_window_state") return out({ elements: ++reads < 3 ? [] : [{ element_token: "s1:1", role: "button", label: "保存" }] });
		return ok();
	};
	await tools.get("hostpc_quick_open")!.execute("id", { app: "/Applications/TextEdit.app" }, undefined, undefined, ctxOf(exec));
	assert.equal(reads, 3, "空页面重读到有元素为止");
	assert.equal(calls[0]!.args.name, "/Applications/TextEdit.app", ".app 路径按 name 传");
	await tools.get("hostpc_quick_open")!.execute("id", { app: "com.apple.TextEdit" }, undefined, undefined, ctxOf(exec));
	assert.equal(calls.filter((c) => short(c.tool) === "launch_app")[1]!.args.bundle_id, "com.apple.TextEdit");
	await assert.rejects(tools.get("hostpc_quick_open")!.execute("id", { url: "file:///tmp/a.html" }, undefined, undefined, ctxOf(exec)), /只支持 http/);
});
