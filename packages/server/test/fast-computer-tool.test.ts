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
import { createMockChooser, createClassifierChooser } from "../src/fast-computer/choosers.ts";

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
	session?: string;
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
	const out = await registered!.execute("id", { goal: "点登录", pid: 9, window_id: 3, session: input.session, expected: input.expected, browser: input.browser }, input.signal, undefined, ctx);
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
});
