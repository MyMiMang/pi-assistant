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
import { fastComputerExtension, narrowCandidates } from "../src/fast-computer/tool.ts";
import { createMockChooser, createClassifierChooser } from "../src/fast-computer/choosers.ts";
import type { FastChoiceRequest } from "../src/fast-computer/types.ts";

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

/** 精确绑定（0.35.4 bind 模式真实形状：没有页面快照）。 */
const REAL_BIND = { status: "ok", mode: "bind", binding_quality: "exact", mutation_allowed: true, target_id: "bt-1", tabs: [{ tab_id: "tab-1", active: true, url: "https://example.com/" }] };
const ok = (structured: unknown) => ({ isError: false, result: { structuredContent: structured, content: [{ type: "text", text: JSON.stringify(structured).slice(0, 200) }] } });

/** 用按次返回的窗口状态 / 页面快照驱动工具；返回工具文本与所有底层工具调用。 */
async function runFastTool(input: {
	states: unknown[];
	snapshots?: unknown[];
	/** 浏览器 bind 模式的返回（默认精确绑定）；给 null 表示 bind 直接报错。 */
	bind?: unknown;
	browser?: unknown;
	chooser?: unknown;
	expected?: unknown;
	candidates?: unknown;
	session?: string;
	prefix?: "hostpc" | "computer";
	signal?: AbortSignal;
	tools?: string[];
}): Promise<{ out: { content: { type: string; text?: string }[] }; calls: ToolCall[] }> {
	saveFastComputerSettings({ enabled: true, kind: "chat", provider: "p", id: "m" });
	_resetFastComputerState();
	const calls: ToolCall[] = [];
	let idx = 0;
	let snapIdx = 0;
	const toolNames = input.tools ?? ["mcp__hostpc__get_window_state", "mcp__hostpc__click"];
	const ctx = {
		tools: toolNames.map((name) => ({ name })),
		executeTool: async (name: string, args: Record<string, unknown>) => {
			calls.push({ name, args });
			if (name.endsWith("get_window_state")) {
				const structured = input.states[Math.min(idx++, input.states.length - 1)];
				return { isError: false, result: { structuredContent: structured, content: [{ type: "text", text: JSON.stringify({ element_count: (structured as { elements?: unknown[] })?.elements?.length ?? 0 }) }] } };
			}
			if (name.endsWith("get_browser_state")) {
				// bind 模式带 pid；snapshot 模式带 target_id。bind 报错用 null 模拟。
				if (args.pid !== undefined) {
					if (input.bind === null) return { isError: true, result: { content: [{ type: "text", text: "browser_bind_failed" }] } };
					return ok(input.bind ?? REAL_BIND);
				}
				const list = input.snapshots ?? [];
				const structured = list[Math.min(snapIdx++, Math.max(list.length - 1, 0))];
				return ok(structured);
			}
			return { isError: false, result: { content: [{ type: "text", text: "clicked" }] } };
		},
	} as unknown as ExtensionToolContext;

	let registered: { execute: (...a: unknown[]) => Promise<{ content: { type: string; text?: string }[] }> } | undefined;
	const pi = { registerTool: (t: never) => (registered = t), on: () => {} };
	fastComputerExtension({ agentId: "test", conversationId: null, taskId: null, chooserFor: () => (input.chooser as never) ?? createMockChooser(() => ({ kind: "selected", candidateId: "el-1" })) }).factory(pi as never);
	assert.ok(registered, "工具应已注册");
	const out = await registered!.execute("id", { goal: "点登录", pid: 9, window_id: 3, prefix: input.prefix, session: input.session, expected: input.expected, browser: input.browser, candidates: input.candidates }, input.signal, undefined, ctx);
	saveFastComputerSettings({ enabled: false });
	return { out, calls };
}

const preState = { elements: [el(1, "button", "登录", "snap1:1")] };
const reState = { elements: [el(1, "button", "登录", "snap2:1")] };
const postState = { elements: [el(1, "button", "登录", "snap3:1", { value: "已登录" })] };
const textOf = (o: { content: { type: string; text?: string }[] }) => o.content.map((c) => c.text ?? "").join("\n");

test("运行时引导：公开 before_agent_start 注入按需规则，不挂 tool_call 拦截直调", async () => {
	const hooks = new Map<string, (event: { systemPrompt: string }) => Promise<{ systemPrompt: string }>>();
	fastComputerExtension({ agentId: "test", conversationId: null, taskId: null }).factory({ registerTool: () => {}, on: (name: string, handler: never) => hooks.set(name, handler) } as never);
	assert.deepEqual([...hooks.keys()], ["before_agent_start"]);
	const result = await hooks.get("before_agent_start")!({ systemPrompt: "原有规则" });
	assert.ok(result.systemPrompt.startsWith("原有规则\n\n"), "保留其他扩展已有提示");
	for (const rule of ["开启只表示允许使用", "目标已经明确时直接操作", 'prefix:"hostpc"', 'prefix:"computer"', "Playwright", "p<快照>", "重新观察并接手"]) assert.ok(result.systemPrompt.includes(rule), rule);
});

test("工具 schema：goal 是本次一步点击的局部目标，并写明只点已展示控件", () => {
	let def: { description: string; parameters: { properties: Record<string, { description?: string }> } } | undefined;
	const pi = { registerTool: (t: never) => (def = t), on: () => {} };
	fastComputerExtension({ agentId: "test", conversationId: null, taskId: null }).factory(pi as never);
	assert.ok(def);
	assert.match(def!.parameters.properties.goal.description ?? "", /本次一步/, "goal schema 限定为一步局部目标");
	assert.match(def!.description, /不支持填字/, "工具说明不谎称能填字 / 键盘输入");
	assert.match(def!.description, /尚未展开的下拉项/);
	assert.match(def!.description, /动作描述/);
});

test("双目标：省略 prefix 时拒绝猜电脑，显式目标各走自己的通道", async () => {
	const tools = ["mcp__hostpc__get_window_state", "mcp__hostpc__click", "mcp__computer__get_window_state", "mcp__computer__click"];
	let chooserCalls = 0;
	const chooser = createMockChooser(() => { chooserCalls++; return { kind: "selected", candidateId: "el-1" }; });
	const ambiguous = await runFastTool({ states: [preState, reState], tools, chooser });
	assert.match(textOf(ambiguous.out), /必须指定 prefix/);
	assert.equal(ambiguous.calls.length, 0, "歧义时不读取任一台电脑");
	assert.equal(chooserCalls, 0);
	for (const prefix of ["hostpc", "computer"] as const) {
		const result = await runFastTool({ states: [preState, reState], tools, prefix, chooser });
		assert.ok(result.calls.some((c) => c.name === `mcp__${prefix}__click`));
		assert.ok(result.calls.every((c) => c.name.startsWith(`mcp__${prefix}__`)));
	}
	assert.equal(chooserCalls, 2);
	const missing = await runFastTool({ states: [preState], tools: ["mcp__computer__get_window_state", "mcp__computer__click"], prefix: "hostpc", chooser });
	assert.match(textOf(missing.out), /目标电脑通道不可用（hostpc）/);
	assert.equal(missing.calls.length, 0);
	assert.equal(chooserCalls, 2, "目标不可用不得转去另一台电脑");
});

test("G1：session 透传到 get_window_state 与 click 参数", async () => {
	const { calls } = await runFastTool({ states: [preState, reState, postState], session: "web" });
	const gws = calls.filter((c) => c.name.endsWith("get_window_state"));
	assert.ok(gws.length >= 2);
	assert.ok(gws.every((c) => c.args.session === "web"), "每次读窗口都要带 session");
	const click = calls.find((c) => c.name.endsWith("click"));
	assert.ok(click);
	assert.equal(click!.args.session, "web", "执行 click 也要带 session");
});

test("G1：读原生窗口显式要 elements（driver 0.35 默认 markdown 没有 element_token）", async () => {
	const { calls } = await runFastTool({ states: [preState, reState, postState] });
	const gws = calls.filter((c) => c.name.endsWith("get_window_state"));
	assert.ok(gws.length >= 2);
	assert.ok(gws.every((c) => c.args.tree_format === "elements"), "每次读窗口都要显式 tree_format=elements");
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

// ---------------------------------------------------------------- 原生 Jev（classifier）接入工具层

/** 用假 classify 构建原生 Jev chooser（provider-bound；这里不碰真实网络 / 凭据）。 */
function nativeChooser(answers: unknown, opts: { stopReason?: "stop" | "error" | "aborted"; errorMessage?: string } = {}) {
	return createClassifierChooser({
		provider: "openrouter",
		model: "typesafe/jev-1.13",
		classify: async (provider, model) => ({ provider, model, api: "typesafe-system-one", answers: answers as never, stopReason: opts.stopReason ?? "stop", errorMessage: opts.errorMessage, timestamp: 1 }),
	});
}

const choice = (choiceId: string, confidence: number) => ({ pick: { type: "choice", choice: choiceId, probabilities: { "el-1": confidence }, confidence } });

test("原生 Jev：选中候选 → 用新 element_token 派发一次 click", async () => {
	const { out, calls } = await runFastTool({ states: [preState, reState, postState], chooser: nativeChooser(choice("el-1", 0.9)) });
	const click = calls.find((c) => c.name.endsWith("click"));
	assert.ok(click, "高可信原生选择应派发");
	assert.equal(click!.args.element_token, "snap2:1");
	assert.match(textOf(out), /置信度 0\.9/);
});

test("工具层：classifier 收到完整动作描述，不含 token / tool 参数 / raw value，模型不被替换", async () => {
	const contexts: unknown[] = [];
	const models: string[] = [];
	const chooser = createClassifierChooser({
		provider: "local-laya",
		model: "multilingual",
		classify: async (provider, model, context) => {
			models.push(`${provider}/${model}`);
			contexts.push(context);
			return { provider, model, api: "typesafe-system-one", stopReason: "stop" as const, timestamp: 1, answers: { pick: { type: "choice", choice: "el-1", confidence: 0.9, probabilities: { "el-1": 0.9 } } } };
		},
	});
	const withSecret = { elements: [el(1, "button", "登录", "snap1:1", { value: "secret-raw-value" })] };
	const freshSecret = { elements: [el(1, "button", "登录", "snap2:1", { value: "secret-raw-value" })] };
	const { out, calls } = await runFastTool({ states: [withSecret, freshSecret, postState], chooser });
	assert.ok(calls.find((c) => c.name.endsWith("click")), "高可信选择应派发");
	const serialized = JSON.stringify(contexts[0]);
	assert.match(serialized, /点击当前界面上的「登录」（button 控件）/, "模型收到完整动作描述");
	assert.ok(!serialized.includes("snap1:1"), "描述不得漏 element_token");
	assert.ok(!serialized.includes("snap2:1"), "描述不得漏 fresh token");
	assert.ok(!serialized.includes("mcp__hostpc__click"), "不得漏 tool 名");
	assert.ok(!serialized.includes("secret-raw-value"), "不得漏控件 raw value");
	assert.ok(!/"args"|"element_token"/.test(serialized), "不得漏任何 args 形状");
	assert.deepEqual(models, ["local-laya/multilingual"], "模型与配置一致，不被描述层换掉");
	assert.match(textOf(out), /快速模型选了「button：登录」/);
});

test("G2 不受动作描述影响：同 role/label 但 value 已变 → 零派发", async () => {
	const changed = { elements: [el(1, "button", "登录", "snap2:1", { value: "忙" })] };
	const { out, calls } = await runFastTool({ states: [preState, changed], chooser: createMockChooser(() => ({ kind: "selected", candidateId: "el-1" })) });
	assert.equal(calls.filter((c) => c.name.endsWith("click")).length, 0, "语义已变则不得凭描述派发");
	assert.match(textOf(out), /目标已变化/);
});

test("原生 Jev：低可信 → 回退，零执行", async () => {
	const { out, calls } = await runFastTool({ states: [preState, reState, postState], chooser: nativeChooser(choice("el-1", 0.2)) });
	assert.equal(calls.filter((c) => c.name.endsWith("click")).length, 0);
	assert.match(textOf(out), /low_confidence/);
});

test("原生 Jev：未授权（401）→ 回退，零执行", async () => {
	const { out, calls } = await runFastTool({ states: [preState, reState, postState], chooser: nativeChooser({}, { stopReason: "error", errorMessage: "System One API error (401)" }) });
	assert.equal(calls.filter((c) => c.name.endsWith("click")).length, 0);
	assert.match(textOf(out), /快速路径跳过/);
});

test("原生 Jev：超时 → 回退，零执行", async () => {
	const { out, calls } = await runFastTool({ states: [preState, reState, postState], chooser: nativeChooser({}, { stopReason: "aborted" }) });
	assert.equal(calls.filter((c) => c.name.endsWith("click")).length, 0);
	assert.match(textOf(out), /timeout/);
});

test("原生 Jev：越界 id → 回退，零执行（答案必须是候选 id）", async () => {
	const { out, calls } = await runFastTool({ states: [preState, reState, postState], chooser: nativeChooser(choice("zzz", 0.99)) });
	assert.equal(calls.filter((c) => c.name.endsWith("click")).length, 0);
	assert.match(textOf(out), /快速路径跳过/);
});

// ---------------------------------------------------------------- 网页目标（browser：CDP semantic_v2 refs）
// 产品差异（主审发现）：`fast_pick_action` 以前只读 `get_window_state` 原生 AX，而 Chrome 后台窗口**不暴露网页 AX 子树**
// （只有工具栏），所以真实网页 fallback 的候选收集不到。这里把网页目标接到同一套 G1/G2/G3 + `browser_click{ref}`。

const browserTools = ["mcp__hostpc__get_window_state", "mcp__hostpc__click", "mcp__hostpc__get_browser_state", "mcp__hostpc__browser_click"];
/** 网页候选 id 是 `ref-<序号>`（不是原生 AX 的 `el-<index>`），默认 mock 选中第一个。 */
const pickFirstRef = () => createMockChooser(() => ({ kind: "selected", candidateId: "ref-0" }));
/** 原生 Jev 形状的「低可信」答案：choice 与唯一最高概率一致，只是概率低。 */
const refChoice = (choiceId: string, confidence: number) => ({ pick: { type: "choice", choice: choiceId, probabilities: { [choiceId]: confidence }, confidence } });
const snapshot = (pin: string, refs: unknown[], extra: Record<string, unknown> = {}) => ({
	status: "ok",
	mode: "snapshot",
	target_id: "bt-1",
	tab_id: "tab-1",
	page: { url: "https://example.com/", title: "示例" },
	snapshot: { id: pin, format: "semantic_v2" },
	refs,
	content_refs: [],
	...extra,
});
const login = (pin: string, name = "登录", actions: string[] = ["click"]) => [{ ref: `${pin}:1`, role: "button", name, actions, value: null }];

test("浏览器目标：选中 → 用 fresh 快照的 ref 派发 browser_click（不是 element_token），并带 target/tab/session", async () => {
	const { out, calls } = await runFastTool({
		states: [],
		tools: browserTools,
		browser: { target_id: "bt-1", tab_id: "tab-1" },
		session: "web",
		chooser: pickFirstRef(),
		snapshots: [snapshot("p1", login("p1")), snapshot("p2", login("p2"))],
	});
	const clicks = calls.filter((c) => c.name.endsWith("browser_click"));
	assert.equal(clicks.length, 1, "应派发一次 browser_click");
	assert.equal(clicks[0].args.ref, "p2:1", "用执行前重读得到的最新 ref");
	assert.equal(clicks[0].args.element_token, undefined, "browser_click 不接受 element_token");
	assert.equal(clicks[0].args.target_id, "bt-1");
	assert.equal(clicks[0].args.tab_id, "tab-1");
	assert.equal(clicks[0].args.session, "web", "G1：session 透传到浏览器读写");
	const reads = calls.filter((c) => c.name.endsWith("get_browser_state"));
	assert.ok(reads.length >= 2, "执行前必须重读一次页面快照");
	assert.ok(reads.every((c) => c.args.snapshot_format === "semantic_v2" && c.args.session === "web" && c.args.target_id === "bt-1" && c.args.tab_id === "tab-1"));
	assert.equal(calls.filter((c) => c.name.endsWith("get_window_state")).length, 0, "网页目标不应再读原生 AX");
	assert.match(textOf(out), /独立核验：unknown/, "无 expected → unknown");
});

test("浏览器目标：bind 核对（browser:{}）→ 只在 pid+window 上取精确绑定，不 attach 浏览器", async () => {
	const { calls } = await runFastTool({
		states: [],
		tools: browserTools,
		browser: {},
		chooser: pickFirstRef(),
		snapshots: [snapshot("p1", login("p1")), snapshot("p2", login("p2"))],
	});
	const bindCalls = calls.filter((c) => c.name.endsWith("get_browser_state") && c.args.pid !== undefined);
	assert.equal(bindCalls.length, 1, "应只做一次绑定核对");
	assert.deepEqual({ pid: bindCalls[0].args.pid, window_id: bindCalls[0].args.window_id }, { pid: 9, window_id: 3 });
	assert.equal(calls.filter((c) => c.name.includes("browser_prepare")).length, 0, "绝不自行 attach / prepare 浏览器");
	const click = calls.find((c) => c.name.endsWith("browser_click"));
	assert.ok(click);
	assert.equal(click!.args.target_id, "bt-1", "target 来自 bind 的精确绑定");
	assert.equal(click!.args.tab_id, "tab-1", "tab 来自 tabs[] 的唯一活动标签");
});

test("浏览器目标：绑定证据不足（binding_quality 非 exact）→ fail-closed，零快照 / 零点击", async () => {
	const { out, calls } = await runFastTool({
		states: [],
		tools: browserTools,
		browser: {},
		bind: { ...REAL_BIND, binding_quality: "heuristic" },
		snapshots: [snapshot("p1", login("p1"))],
	});
	assert.equal(calls.filter((c) => c.name.endsWith("browser_click")).length, 0);
	assert.equal(calls.filter((c) => c.name.endsWith("get_browser_state") && c.args.pid === undefined).length, 0, "绑定不通过就不该再读快照");
	assert.match(textOf(out), /精确绑定核对不通过/);
	assert.match(textOf(out), /不会替你 attach/);
});

test("浏览器目标：bind 直接报错 → 明确回主模型自己完成", async () => {
	const { out, calls } = await runFastTool({ states: [], tools: browserTools, browser: {}, bind: null, snapshots: [] });
	assert.equal(calls.filter((c) => c.name.endsWith("browser_click")).length, 0);
	assert.match(textOf(out), /浏览器精确绑定核对失败/);
	assert.match(textOf(out), /请你自己用浏览器工具完成/);
});

test("浏览器目标：快照报回别的 target/tab → 拒绝换 target，零点击", async () => {
	const { out, calls } = await runFastTool({
		states: [],
		tools: browserTools,
		browser: { target_id: "bt-1", tab_id: "tab-1" },
		snapshots: [snapshot("p1", login("p1"), { target_id: "bt-other" })],
	});
	assert.equal(calls.filter((c) => c.name.endsWith("browser_click")).length, 0);
	assert.match(textOf(out), /拒绝换 target/);
});

test("浏览器目标：执行前重读发现目标已变化 → 中止，零执行", async () => {
	const { out, calls } = await runFastTool({
		states: [],
		tools: browserTools,
		browser: { target_id: "bt-1", tab_id: "tab-1" },
		chooser: pickFirstRef(),
		snapshots: [snapshot("p1", login("p1")), snapshot("p2", login("p2", "登录", ["click", "pointer"]))],
	});
	assert.equal(calls.filter((c) => c.name.endsWith("browser_click")).length, 0);
	assert.match(textOf(out), /目标已变化/);
});

test("浏览器目标：快速模型回退 → 零执行，明确由主模型接手", async () => {
	const { out, calls } = await runFastTool({
		states: [],
		tools: browserTools,
		browser: { target_id: "bt-1", tab_id: "tab-1" },
		chooser: nativeChooser(refChoice("ref-0", 0.1)),
		snapshots: [snapshot("p1", login("p1"))],
	});
	assert.equal(calls.filter((c) => c.name.endsWith("browser_click")).length, 0);
	assert.match(textOf(out), /快速路径跳过/);
	assert.match(textOf(out), /自己用电脑工具完成/);
});

test("浏览器目标：电脑工具缺浏览器能力 → fail-closed 提示自己完成（不读原生 AX 充当网页）", async () => {
	const { out, calls } = await runFastTool({ states: [preState], tools: ["mcp__hostpc__get_window_state", "mcp__hostpc__click"], browser: { target_id: "bt-1", tab_id: "tab-1" } });
	assert.equal(calls.length, 0, "缺能力时不派发任何调用");
	assert.match(textOf(out), /浏览器工具不完整/);
	assert.match(textOf(out), /请你自己用浏览器工具完成/);
});

test("浏览器目标：只给 target_id 或只给 tab_id → 明确失败，不猜另一个", async () => {
	const { out, calls } = await runFastTool({ states: [], tools: browserTools, browser: { target_id: "bt-1" } });
	assert.equal(calls.length, 0);
	assert.match(textOf(out), /同时给 target_id \+ tab_id/);
});

test("浏览器候选能力语义：content 节点（无动作）不进候选，pointer-only 文本保留（label-click 未证，不凭猜删）", async () => {
	const { browserSnapshotAsWindow } = await import("../src/fast-computer/browser-snapshot.ts");
	const { clickCandidatesFromBrowserRefs } = await import("../src/fast-computer/tool.ts");
	const normalized = browserSnapshotAsWindow({
		status: "ok",
		mode: "snapshot",
		page: { url: "https://example.com/" },
		snapshot: { id: "p3", format: "semantic_v2" },
		refs: [
			{ ref: "p3:1", role: "button", name: "提交", actions: ["click"] },
			{ ref: "p3:2", role: "statictext", name: "请选择城市", actions: ["pointer"] },
		],
		content_refs: [{ ref: "p3:9", role: "statictext", name: "提交完成" }],
	});
	const candidates = clickCandidatesFromBrowserRefs("mcp__hostpc__", { target_id: "bt-1", tab_id: "tab-1" }, normalized);
	assert.deepEqual(candidates.map((c) => c.args.element_token), ["p3:1", "p3:2"], "内容节点不进候选；pointer-only 保留");
	// 网页候选也带同一份点击语义描述（从 role/name 生成，不含 ref / 动作参数 / 内容文本）。
	assert.deepEqual(candidates.map((c) => c.description), ["点击当前界面上的「提交」（button 控件）", "点击当前界面上的「请选择城市」（statictext 控件）"]);
	assert.ok(candidates.every((c) => !(c.description ?? "").includes("p3:")), "描述不带 ref");
	assert.ok(candidates.every((c) => !/展开|提交成功/.test(c.description ?? "")), "不承诺未知后置结果");
});

// ---------------------------------------------------------------- 显式候选范围（candidates：主模型圈定的精确 selector）
// 用户要求：工具描述声称「主已收窄候选」，实际却总扫全页最多 32 个、无法表达范围。这里圈定 {role?, label} 2..32 个，
// 程序只在**本次收集到的有界候选**里匹配，每个 selector 必须恰好命中 1 个；缺 / 模糊 / 重复 / 超界 / 重读后范围变化
// 全部 fail-closed，**不调 chooser、不派发、也不退回整页**。

/** 记录 chooser 实际收到的请求（用来证明“有没有调用快速模型 / 它看到了哪些候选”）。 */
function recordingChooser(respondId: string) {
	const seen: FastChoiceRequest[] = [];
	const chooser = createMockChooser((req) => {
		seen.push(req);
		return { kind: "selected", candidateId: respondId };
	});
	return { chooser, seen };
}

const threeButtons = (pin: string) => ({ elements: [el(1, "button", "登录", `${pin}:1`), el(2, "button", "取消", `${pin}:2`), el(3, "button", "提交", `${pin}:3`)] });
const clicks = (calls: ToolCall[]) => calls.filter((c) => c.name.endsWith("click"));

test("显式候选范围：只透传圈定的子集，保持收集顺序 / ID / 描述；选中项由模型决定（不是整页第一个 / 不按 fixture 答案筛）", async () => {
	const { chooser, seen } = recordingChooser("el-2");
	const { calls } = await runFastTool({
		states: [threeButtons("snap1"), threeButtons("snap2"), postState],
		candidates: [{ role: "button", label: "提交" }, { role: "button", label: "取消" }],
		chooser,
	});
	assert.equal(seen.length, 1, "范围成立时应调用一次快速模型");
	assert.deepEqual(seen[0].candidates.map((c) => c.id), ["el-2", "el-3"], "保持程序收集顺序，不按 selector 排序");
	assert.ok(!seen[0].candidates.some((c) => c.label.includes("登录")), "没圈定的候选不进模型输入");
	assert.equal(seen[0].candidates[1].description, "点击当前界面上的「提交」（button 控件）", "描述原样透传");
	const click = clicks(calls);
	assert.equal(click.length, 1);
	assert.equal(click[0].args.element_token, "snap2:2", "派发模型圈定并选中的那个控件，且用 fresh token");
});

test("显式候选范围：label 忽略首尾空白精确匹配；模糊子串不匹配 → 零 chooser / 零派发", async () => {
	const { chooser, seen } = recordingChooser("el-1");
	const trimmed = await runFastTool({ states: [threeButtons("snap1"), threeButtons("snap2"), postState], candidates: [{ label: " 登录 " }, { label: "取消" }], chooser });
	assert.equal(seen.length, 1, "首尾空白不应影响精确匹配");
	assert.equal(clicks(trimmed.calls)[0]?.args.element_token, "snap2:1");

	const fuzzy = recordingChooser("el-1");
	const rejected = await runFastTool({ states: [threeButtons("snap1")], candidates: [{ label: "登" }, { label: "取消" }], chooser: fuzzy.chooser });
	assert.equal(fuzzy.seen.length, 0, "范围不成立不得调用快速模型");
	assert.equal(clicks(rejected.calls).length, 0, "范围不成立不得派发");
	assert.match(textOf(rejected.out), /找不到/);
});

test("显式候选范围：空 / 单项 / 非数组 / 超 32 / 重复 / 超长 / 越界字段 → 参数错误，零调用、不退回整页", async () => {
	const cases: [string, unknown, RegExp][] = [
		["空数组", [], /至少 2 个/],
		["只有 1 项", [{ label: "登录" }], /至少 2 个/],
		["不是数组", "登录", /必须是 selector 数组/],
		["超过 32 项", Array.from({ length: 33 }, (_, i) => ({ label: `按钮${i}` })), /最多 32 个/],
		["selector 重复", [{ label: "登录" }, { label: "登录" }], /重复/],
		["空 label", [{ label: "   " }, { label: "取消" }], /缺少 label/],
		["label 超长", [{ label: "x".repeat(121) }, { label: "取消" }], /超过 120/],
		["role 超长", [{ role: "r".repeat(81), label: "登录" }, { label: "取消" }], /超过 80/],
	];
	for (const [name, candidates, pattern] of cases) {
		const { chooser, seen } = recordingChooser("el-1");
		const { out, calls } = await runFastTool({ states: [threeButtons("snap1")], candidates, chooser });
		assert.equal(seen.length, 0, `${name}：不得调用快速模型`);
		assert.equal(calls.length, 0, `${name}：参数非法时连窗口都不读（不拿整页候补）`);
		assert.match(textOf(out), pattern, name);
		assert.match(textOf(out), /没有退回整页候选/, `${name}：明确说明没有退回整页`);
	}
});

test("显式候选范围：多个 selector 指向同一个控件 → 拒绝（不能重复圈同一个控件凑数量）", async () => {
	const { chooser, seen } = recordingChooser("el-1");
	const { out, calls } = await runFastTool({ states: [threeButtons("snap1")], candidates: [{ label: "登录" }, { role: "button", label: "登录" }], chooser });
	assert.equal(seen.length, 0);
	assert.equal(clicks(calls).length, 0);
	assert.match(textOf(out), /指向同一个候选/);
});

test("显式候选范围：只匹配程序本次收集的有界候选（第 33 个控件不在候选里 → 诚实拒绝，不扫描整页）", async () => {
	const many = { elements: Array.from({ length: 40 }, (_, i) => el(i + 1, "button", `其他${i + 1}`, `s1:${i + 1}`)) };
	const { chooser, seen } = recordingChooser("el-1");
	const { out, calls } = await runFastTool({ states: [many], candidates: [{ label: "其他1" }, { label: "其他40" }], chooser });
	assert.equal(seen.length, 0, "未收集到的控件不能被当成可选项");
	assert.equal(clicks(calls).length, 0);
	assert.match(textOf(out), /最多 32 个/);
	assert.match(textOf(out), /不扫描整页/);
});

test("显式候选范围：重读后**未选中**的候选语义变化也中止（模型可能在不同 choice set 里决定）", async () => {
	const changed = { elements: [el(1, "button", "登录", "s2:1"), el(2, "button", "取消", "s2:2", { value: "已取消" })] };
	const first = { elements: [el(1, "button", "登录", "s1:1"), el(2, "button", "取消", "s1:2")] };
	const { chooser } = recordingChooser("el-1");
	const { out, calls } = await runFastTool({ states: [first, changed], candidates: [{ label: "登录" }, { label: "取消" }], chooser });
	assert.equal(clicks(calls).length, 0, "整个显式范围变了就不得派发（哪怕选中的那个没变）");
	assert.match(textOf(out), /第 2 个 selector/);
	assert.match(textOf(out), /role \/ value \/ actions 已变化/);
});

test("显式候选范围：重读后某个 selector 找不到 → 中止，零派发", async () => {
	const fresh = { elements: [el(1, "button", "登录", "s2:1"), el(2, "button", "关闭", "s2:2")] };
	const { chooser } = recordingChooser("el-1");
	const { out, calls } = await runFastTool({ states: [threeButtons("snap1"), fresh], candidates: [{ label: "登录" }, { label: "取消" }], chooser });
	assert.equal(clicks(calls).length, 0);
	assert.match(textOf(out), /显式候选范围在重读后已变化/);
});

test("默认不传 candidates：仍收集整页有界候选（含容器），旧行为兼容", async () => {
	const state = { elements: [el(1, "button", "登录", "s1:1"), el(2, "row", "第一行", "s1:2"), el(3, "textfield", "搜索", "s1:3")] };
	const fresh = { elements: [el(1, "button", "登录", "s2:1"), el(2, "row", "第一行", "s2:2"), el(3, "textfield", "搜索", "s2:3")] };
	const { chooser, seen } = recordingChooser("el-1");
	const { calls } = await runFastTool({ states: [state, fresh, postState], chooser });
	assert.deepEqual(seen[0]?.candidates.map((c) => c.id), ["el-1", "el-2", "el-3"], "默认候选范围与顺序不变");
	assert.equal(clicks(calls)[0]?.args.element_token, "s2:1");
});

test("显式候选范围：模型输入只有圈定候选的描述，不含 raw value / token / tool，也不重复复制 selector", async () => {
	const contexts: unknown[] = [];
	const chooser = createClassifierChooser({
		provider: "local-laya",
		model: "multilingual",
		classify: async (provider, model, context) => {
			contexts.push(context);
			return { provider, model, api: "typesafe-system-one", stopReason: "stop" as const, timestamp: 1, answers: { pick: { type: "choice", choice: "el-1", confidence: 0.9, probabilities: { "el-1": 0.9 } } } };
		},
	});
	const withSecret = (pin: string) => ({ elements: [el(1, "button", "登录", `${pin}:1`, { value: "secret-raw-value" }), el(2, "button", "取消", `${pin}:2`), el(3, "button", "提交", `${pin}:3`)] });
	const { calls } = await runFastTool({ states: [withSecret("s1"), withSecret("s2")], candidates: [{ label: "取消" }, { label: "登录" }], chooser });
	assert.equal(clicks(calls)[0]?.args.element_token, "s2:1");
	const ctx = contexts[0] as { state: unknown; questions: { pick: { criteria: Record<string, string> } } };
	const serialized = JSON.stringify(ctx);
	assert.match(serialized, /点击当前界面上的「登录」（button 控件）/, "圈定的候选仍带完整描述");
	assert.deepEqual(Object.keys(ctx.questions.pick.criteria).sort(), ["el-1", "el-2"], "只有圈定的候选");
	assert.ok(!serialized.includes("提交"), "没圈定的候选不进模型输入");
	assert.ok(!serialized.includes("secret-raw-value"), "不得漏控件 raw value");
	assert.ok(!serialized.includes("s1:1") && !serialized.includes("s2:1"), "不得漏 element_token");
	assert.deepEqual(ctx.state, { goal: "点登录" }, "selector 不进 state，不重复复制");
});

test("浏览器目标 + 显式候选范围：只在圈定的 ref 里选，派发用 fresh ref", async () => {
	const page = (pin: string) => ({ refs: [
		{ ref: `${pin}:1`, role: "button", name: "登录", actions: ["click"] },
		{ ref: `${pin}:2`, role: "button", name: "取消", actions: ["click"] },
		{ ref: `${pin}:3`, role: "button", name: "提交", actions: ["click"] },
	] });
	const { chooser, seen } = recordingChooser("ref-2");
	const { calls } = await runFastTool({
		states: [],
		tools: browserTools,
		browser: { target_id: "bt-1", tab_id: "tab-1" },
		chooser,
		candidates: [{ label: "提交" }, { label: "登录" }],
		snapshots: [snapshot("p1", page("p1").refs), snapshot("p2", page("p2").refs)],
	});
	assert.deepEqual(seen[0]?.candidates.map((c) => c.id), ["ref-0", "ref-2"], "保持 page 收集顺序，不是 selector 顺序");
	const click = calls.find((c) => c.name.endsWith("browser_click"));
	assert.equal(click?.args.ref, "p2:3", "用 fresh 快照里选中控件的 ref");
});

test("显式候选范围：按完整可见 label（semantic.label）匹配，不受 120 字展示截断影响", async () => {
	const longLabel = "长".repeat(120);
	const first = { elements: [el(1, "button", longLabel, "s1:1"), el(2, "button", "取消", "s1:2")] };
	const fresh = { elements: [el(1, "button", longLabel, "s2:1"), el(2, "button", "取消", "s2:2")] };
	const { chooser, seen } = recordingChooser("el-1");
	const { calls } = await runFastTool({ states: [first, fresh, postState], candidates: [{ role: "button", label: longLabel }, { label: "取消" }], chooser });
	assert.equal(seen.length, 1, "完整可见 label 即使被展示层截断也应能匹配");
	assert.ok(seen[0].candidates[0].label.length <= 120, "展示 label 仍限 120 字，不影响精确匹配");
	assert.equal(clicks(calls)[0]?.args.element_token, "s2:1");
});

test("narrowCandidates 纯函数：缺 / 模糊 / 重复都会拒，且返回子集保持收集顺序", () => {
	const cands = [
		{ id: "el-1", label: "button：登录", tool: "mcp__hostpc__click", args: {}, semantic: { role: "button", label: "登录", value: "", actions: ["press"] } },
		{ id: "el-2", label: "button：取消", tool: "mcp__hostpc__click", args: {}, semantic: { role: "button", label: "取消", value: "", actions: ["press"] } },
	];
	const okSubset = narrowCandidates(cands, [{ label: "取消" }, { role: "button", label: "登录" }]);
	assert.ok(okSubset.ok);
	assert.deepEqual(okSubset.ok && okSubset.candidates.map((c) => c.id), ["el-1", "el-2"]);
	assert.equal(narrowCandidates(cands, [{ label: "登" }, { label: "取消" }]).ok, false);
	assert.equal(narrowCandidates(cands, [{ label: "登录" }]).ok, false, "1 项不算 bounded 选择");
	assert.equal(narrowCandidates(cands, []).ok, false, "空 selector 数组拒绝");
});
