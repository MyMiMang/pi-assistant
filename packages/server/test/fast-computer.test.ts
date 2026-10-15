/**
 * 快速操作模型：默认关闭零调用、受限候选选择、未知 candidate/capture 不执行、错误/超时/低可信回退、
 * 熔断、用量记账、候选白名单、SystemOne / chat 协议解析。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastActionCandidate, FastActionChooser, FastComputerSettings } from "../src/fast-computer/index.ts";
const fc = await import("../src/fast-computer/index.ts");
const { createMockChooser, createSystemOneChooser, parseChatChoice, parseSystemOneChoice } = await import("../src/fast-computer/choosers.ts");

const cand = (id: string, tool = "click"): FastActionCandidate => ({ id, label: `候选 ${id}`, tool, args: { element_token: `${id}:1` } });
const settings = (patch: Partial<FastComputerSettings> = {}): FastComputerSettings => ({ ...fc.FAST_COMPUTER_DEFAULT, enabled: true, ...patch });

test("默认关闭：零额外调用", async () => {
	fc._resetFastComputerState();
	let calls = 0;
	const chooser = createMockChooser(() => (calls++, { kind: "selected", candidateId: "a" }));
	const r = await fc.selectFastAction({ key: "k1", goal: "g", candidates: [cand("a")], chooser, settings: fc.FAST_COMPUTER_DEFAULT });
	assert.equal(r.kind, "disabled");
	assert.equal(calls, 0, "关闭时不得调用 chooser");
	assert.equal(fc.fastComputerSettings().enabled, false);
});

test("开启 + 合法候选：选中并回候选动作", async () => {
	fc._resetFastComputerState();
	const r = await fc.selectFastAction({ key: "k2", goal: "g", candidates: [cand("a"), cand("b")], chooser: createMockChooser(() => ({ kind: "selected", candidateId: "b", confidence: 0.9 })), settings: settings() });
	assert.equal(r.kind, "selected");
	if (r.kind !== "selected") return;
	assert.equal(r.candidate.id, "b");
	assert.equal(r.candidate.tool, "click");
	assert.equal(r.uncalibrated, false);
});

test("未知 candidateId：不执行、回退", async () => {
	fc._resetFastComputerState();
	const r = await fc.selectFastAction({ key: "k3", goal: "g", candidates: [cand("a")], chooser: createMockChooser(() => ({ kind: "selected", candidateId: "zzz" })), settings: settings() });
	assert.equal(r.kind, "fallback");
	if (r.kind === "fallback") assert.equal(r.reason, "unknown_candidate");
});

test("过期 capture：不执行、回退", async () => {
	fc._resetFastComputerState();
	// chooser 在作答时又登记了一次同 key 的 capture，使之前那次 capture 失效
	const chooser = createMockChooser((req) => {
		fc.registerCapture("k4", [cand("x")]);
		return { kind: "selected", candidateId: "a" };
	});
	const r = await fc.selectFastAction({ key: "k4", goal: "g", candidates: [cand("a")], chooser, settings: settings() });
	assert.equal(r.kind, "fallback");
	if (r.kind === "fallback") assert.equal(r.reason, "capture_invalid");
});

test("chooser 抛错 / 超时 → 回退", async () => {
	fc._resetFastComputerState();
	const thrower: FastActionChooser = { id: "t", label: "t", nativeProbability: true, choose: async () => { throw new Error("boom"); } };
	const r1 = await fc.selectFastAction({ key: "k5", goal: "g", candidates: [cand("a")], chooser: thrower, settings: settings() });
	assert.equal(r1.kind === "fallback" && r1.reason, "model_error");
	const timeout: FastActionChooser = { id: "t", label: "t", nativeProbability: true, choose: async () => ({ kind: "error", error: "timeout" }) };
	const r2 = await fc.selectFastAction({ key: "k6", goal: "g", candidates: [cand("a")], chooser: timeout, settings: settings() });
	assert.equal(r2.kind === "fallback" && r2.reason, "timeout");
});

test("原生 confidence 低于阈值 → 回退，不执行", async () => {
	fc._resetFastComputerState();
	const r = await fc.selectFastAction({ key: "k7", goal: "g", candidates: [cand("a")], chooser: createMockChooser(() => ({ kind: "selected", candidateId: "a", confidence: 0.3 })), settings: settings({ threshold: 0.6 }) });
	assert.equal(r.kind === "fallback" && r.reason, "low_confidence");
});

test("chat 替代（无原生概率）：选中但标记 uncalibrated，阈值不适用", async () => {
	fc._resetFastComputerState();
	const r = await fc.selectFastAction({ key: "k8", goal: "g", candidates: [cand("a")], chooser: createMockChooser(() => ({ kind: "selected", candidateId: "a" }), { nativeProbability: false }), settings: settings({ kind: "chat", threshold: 0.99 }) });
	assert.equal(r.kind, "selected");
	if (r.kind === "selected") assert.equal(r.uncalibrated, true);
});

test("abstain / reobserve → 回退", async () => {
	fc._resetFastComputerState();
	const r1 = await fc.selectFastAction({ key: "k9", goal: "g", candidates: [cand("a")], chooser: createMockChooser(() => ({ kind: "abstain" })), settings: settings() });
	assert.equal(r1.kind === "fallback" && r1.reason, "abstain");
	const r2 = await fc.selectFastAction({ key: "k10", goal: "g", candidates: [cand("a")], chooser: createMockChooser(() => ({ kind: "reobserve" })), settings: settings() });
	assert.equal(r2.kind === "fallback" && r2.reason, "reobserve");
});

test("连续回退熔断：第 4 次不再调用 chooser", async () => {
	fc._resetFastComputerState();
	let calls = 0;
	const chooser = createMockChooser(() => (calls++, { kind: "abstain" }));
	for (let i = 0; i < 3; i++) await fc.selectFastAction({ key: "kc", goal: "g", candidates: [cand("a")], chooser, settings: settings() });
	const r = await fc.selectFastAction({ key: "kc", goal: "g", candidates: [cand("a")], chooser, settings: settings() });
	assert.equal(calls, 3, "熔断后不再调用 chooser");
	assert.equal(r.kind === "fallback" && r.reason, "circuit_open");
	fc.resetFastCircuit("kc");
	const r2 = await fc.selectFastAction({ key: "kc", goal: "g", candidates: [cand("a")], chooser, settings: settings() });
	assert.equal(r2.kind, "fallback"); // 恢复后会再次调用
	assert.equal(calls, 4);
});

test("用量按真实返回记账（有 usage 才记）", async () => {
	fc._resetFastComputerState();
	const seen: { provider: string; model: string; input: number; output: number }[] = [];
	await fc.selectFastAction({
		key: "ku",
		goal: "g",
		candidates: [cand("a")],
		chooser: createMockChooser(() => ({ kind: "selected", candidateId: "a", usage: { input: 12, output: 3 }, model: "typesafe/jev-1.13" })),
		settings: settings({ kind: "systemone", model: "jev-latest" }),
		onUsage: (u) => seen.push(u),
	});
	assert.equal(seen.length, 1);
	assert.deepEqual(seen[0], { provider: "jev", model: "typesafe/jev-1.13", input: 12, output: 3 });
	// 没有 usage 就不记
	await fc.selectFastAction({ key: "ku2", goal: "g", candidates: [cand("a")], chooser: createMockChooser(() => ({ kind: "selected", candidateId: "a" })), settings: settings(), onUsage: (u) => seen.push(u) });
	assert.equal(seen.length, 1);
});

test("候选校验：空 / 超限 / 重复 / 非白名单工具", () => {
	assert.ok(fc.validateCandidates([]));
	assert.ok(fc.validateCandidates(Array.from({ length: 33 }, (_, i) => cand(`c${i}`))));
	assert.ok(fc.validateCandidates([cand("a"), cand("a")]));
	assert.ok(fc.validateCandidates([cand("a", "bash")]), "非电脑输入工具不允许");
	assert.equal(fc.validateCandidates([cand("a"), cand("b", "type_text")]), null);
});

test("SystemOne 解析：选中 / 并列 / 非法概率 / 越界", () => {
	const ids = ["a", "b"];
	const ok = parseSystemOneChoice({ answers: { pick: { type: "choice", choice: "a", confidence: 0.8, probabilities: { a: 0.8, b: 0.2 } } }, usage: { input_tokens: 5, output_tokens: 1 } }, ids);
	assert.deepEqual(ok, { kind: "selected", candidateId: "a", confidence: 0.8, probabilities: { a: 0.8, b: 0.2 }, usage: { input: 5, output: 1 }, model: undefined });
	const tie = parseSystemOneChoice({ answers: { pick: { type: "choice", choice: "a", probabilities: { a: 0.5, b: 0.5 } } } }, ids);
	assert.equal(tie.kind, "abstain");
	const badProbs = parseSystemOneChoice({ answers: { pick: { type: "choice", choice: "a", probabilities: { a: 1.4, b: -0.1 } } } }, ids);
	assert.equal(badProbs.kind, "selected");
	if (badProbs.kind === "selected") assert.equal(badProbs.probabilities, undefined, "非法概率整体丢弃，不部分信任");
	const outOfSet = parseSystemOneChoice({ answers: { pick: { type: "choice", choice: "z" } } }, ids);
	assert.equal(outOfSet.kind, "error");
});

test("chat 解析：不合成 confidence", () => {
	const ids = ["a", "b"];
	const ok = parseChatChoice('{"id":"b"}', ids);
	assert.deepEqual(ok, { kind: "selected", candidateId: "b", reason: undefined });
	assert.ok(!("confidence" in ok), "chat 替代不得返回 confidence");
	assert.equal(parseChatChoice('{"abstain":true}', ids).kind, "abstain");
	assert.equal(parseChatChoice("not json", ids).kind, "error");
	assert.equal(parseChatChoice('{"id":"z"}', ids).kind, "error");
});

test("SystemOne chooser：请求形状正确、解析响应（假 fetch）", async () => {
	let url = "";
	let body: unknown;
	const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => {
		url = String(u);
		body = JSON.parse(String(init?.body));
		return new Response(JSON.stringify({ answers: { pick: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } } }, model: "typesafe/jev-1.13", usage: { input_tokens: 7, output_tokens: 2 } }), { status: 200 });
	}) as unknown as typeof fetch;
	const chooser = createSystemOneChooser({ baseUrl: "https://openrouter.ai/api/", model: "typesafe/jev-1.13", apiKey: "k", fetchImpl });
	const r = await chooser.choose({ goal: "点登录", captureId: "cap-1", candidates: [{ id: "a", label: "按钮：登录" }, { id: "b", label: "按钮：取消" }] });
	assert.equal(url, "https://openrouter.ai/api/v1/systemone");
	const b = body as { model: string; questions: { pick: { type: string; criteria: Record<string, string> } } };
	assert.equal(b.model, "typesafe/jev-1.13");
	assert.equal(b.questions.pick.type, "choice");
	assert.deepEqual(b.questions.pick.criteria, { a: "按钮：登录", b: "按钮：取消" });
	assert.equal(r.kind === "selected" && r.candidateId, "a");
});

test("程序收集：从窗口状态生成点击候选（限上限、只取可点击）", async () => {
	const { clickCandidatesFromWindowState } = await import("../src/fast-computer/tool.ts");
	const elements = [
		{ element_index: 1, role: "button", label: "登录", element_token: "s1:1", actions: ["press"] },
		{ element_index: 2, role: "statictext", label: "提示", element_token: "s1:2" },
		{ element_index: 3, role: "textfield", label: "邮箱", element_token: "s1:3" },
		{ element_index: 4, role: "button", label: "取消" },
	];
	const cands = clickCandidatesFromWindowState("mcp__hostpc__", { pid: 9, window_id: 3 }, { elements });
	assert.equal(cands.length, 3, "取有 element_token 的可点击控件（button/textfield），排除 statictext");
	assert.equal(cands[0].tool, "mcp__hostpc__click");
	assert.deepEqual(cands[0].args, { pid: 9, window_id: 3, element_token: "s1:1" });
	assert.match(cands[0].label, /登录/);
	assert.ok(cands.every((c) => fc.validateCandidates([c]) === null));
});

test("设置保存：边界收敛 + 未知 kind 回落", () => {
	const s = fc.saveFastComputerSettings({ enabled: true, threshold: 9, timeoutMs: 1 });
	assert.equal(s.threshold, 1);
	assert.equal(s.timeoutMs, 500);
	assert.equal(s.kind, "chat");
	fc.saveFastComputerSettings({ enabled: false });
	assert.equal(fc.fastComputerSettings().enabled, false);
});

// ---------------------------------------------------------------- G2/G3/G4 专项

test("G2 执行前新鲜度：语义唯一且 value/actions 未变 → 用新 element_token 重构", () => {
	const candidate = { id: "el-1", label: "button：登录", tool: "mcp__hostpc__click", args: { pid: 1, window_id: 2, element_token: "snap1:1" }, semantic: { role: "button", label: "登录", value: "", actions: ["press"] } };
	const structured = { elements: [{ element_index: 1, role: "button", label: "登录", value: "", actions: ["press"], element_token: "snap9:1" }] };
	const r = fc.resolveFreshCandidate(candidate, structured);
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.candidate.args.element_token, "snap9:1");
		assert.notEqual(r.candidate.args.element_token, "snap1:1");
	}
});

test("G2：目标找不到 / 不唯一 / 值或 actions 变化 → 中止（不复用旧 token）", () => {
	const base = { id: "el-1", label: "button：登录", tool: "mcp__hostpc__click", args: { element_token: "snap1:1" }, semantic: { role: "button", label: "登录", value: "", actions: ["press"] } };
	assert.equal(fc.resolveFreshCandidate(base, { elements: [] }).ok, false);
	const notFound = fc.resolveFreshCandidate(base, { elements: [{ role: "button", label: "取消", value: "", element_token: "s:2" }] });
	assert.deepEqual(notFound, { ok: false, reason: "not_found" });
	const ambiguous = fc.resolveFreshCandidate(base, { elements: [{ role: "button", label: "登录", value: "", actions: ["press"], element_token: "s:1" }, { role: "button", label: "登录", value: "", actions: ["press"], element_token: "s:2" }] });
	assert.deepEqual(ambiguous, { ok: false, reason: "ambiguous" });
	const valueChanged = fc.resolveFreshCandidate(base, { elements: [{ role: "button", label: "登录", value: "忙", actions: ["press"], element_token: "s:1" }] });
	assert.deepEqual(valueChanged, { ok: false, reason: "changed" });
	const actionsChanged = fc.resolveFreshCandidate(base, { elements: [{ role: "button", label: "登录", value: "", actions: ["press", "show_menu"], element_token: "s:1" }] });
	assert.deepEqual(actionsChanged, { ok: false, reason: "changed" });
	const noSemantic = fc.resolveFreshCandidate({ id: "x", label: "x", tool: "click", args: {} }, { elements: [] });
	assert.deepEqual(noSemantic, { ok: false, reason: "no_semantic" });
});

test("G3 核验：无 expected → unknown；不把执行成功当成功", () => {
	assert.equal(fc.verifyExpectation(undefined, { elements: [] }), "unknown");
	assert.equal(fc.verifyExpectation({ role: "button" }, {}), "unknown");
});

test("G3 核验：confirmed / unsatisfied（存在、值、actions、不存在）", () => {
	const state = { elements: [{ role: "button", label: "登录", value: "已登录", actions: ["press"] }] };
	assert.equal(fc.verifyExpectation({ role: "button", label_contains: "登录", exists: true }, state), "confirmed");
	assert.equal(fc.verifyExpectation({ role: "button", value_equals: "已登录" }, state), "confirmed");
	assert.equal(fc.verifyExpectation({ role: "button", value_equals: "未登录" }, state), "unsatisfied");
	assert.equal(fc.verifyExpectation({ role: "button", action_contains: "show_menu" }, state), "unsatisfied");
	// 确实匹配到元素 → 「不存在」断言被正向证据证伪（可以 unsatisfied）
	assert.equal(fc.verifyExpectation({ label_contains: "登录", exists: false }, state), "unsatisfied");
});

test("G3 核验：没匹配到 ≠ 不存在 —— 缺少完整覆盖证明一律 unknown，不得 confirmed", () => {
	const state = { elements: [{ role: "button", label: "登录", value: "已登录", actions: ["press"] }] };
	// 正向断言找不到 → unknown（不是 unsatisfied）
	assert.equal(fc.verifyExpectation({ label_contains: "取消", exists: true }, state), "unknown");
	// 「不存在」断言找不到 → unknown（不是 confirmed）：控件树可能没覆盖全
	assert.equal(fc.verifyExpectation({ label_contains: "取消", exists: false }, state), "unknown");
	assert.equal(fc.verifyExpectation({ label_contains: "取消", exists: false }, { elements: [] }), "unknown");
});

test("G3 核验：截断 / 过滤 / 部分可见的响应不把「没找到」误判 confirmed", () => {
	// truncated：元素太多只回了一部分
	assert.equal(fc.verifyExpectation({ label_contains: "取消", exists: false }, { elements: [{ role: "button", label: "登录", value: "" }], truncated: true }), "unknown");
	// filtered：只回过滤后的部分元素
	assert.equal(fc.verifyExpectation({ label_contains: "取消", exists: false }, { elements: [{ role: "button", label: "登录", value: "" }], filtered_element_count: 1 }), "unknown");
	// partial / 覆盖不完整
	assert.equal(fc.verifyExpectation({ label_contains: "取消", exists: false }, { elements: [], elements_complete: false }), "unknown");
	assert.equal(fc.verifyExpectation({ label_contains: "取消", exists: false }, { elements: [], degraded_reason: "ax_window_unresolved" }), "unknown");
	// 但确实出现在（哪怕不完整的）响应里的元素仍能证伪「不存在」
	assert.equal(fc.verifyExpectation({ label_contains: "登录", exists: false }, { elements: [{ role: "button", label: "登录", value: "" }], truncated: true }), "unsatisfied");
});

test("G3 核验：值断言缺 value 字段 → unknown，不把 undefined 当空串误判 confirmed", () => {
	// 元素没有 value 字段：norm(undefined) === ""，若 value_equals:"" 会被误判 confirmed
	assert.equal(fc.verifyExpectation({ role: "button", value_equals: "" }, { elements: [{ role: "button", label: "登录" }] }), "unknown");
	// 显式空串才算满足
	assert.equal(fc.verifyExpectation({ role: "button", value_equals: "" }, { elements: [{ role: "button", label: "登录", value: "" }] }), "confirmed");
	// 有值但不匹配 → unsatisfied
	assert.equal(fc.verifyExpectation({ role: "button", value_equals: "已登录" }, { elements: [{ role: "button", label: "登录", value: "未登录" }] }), "unsatisfied");
	// 多命中里有一个满足即可 confirmed
	assert.equal(fc.verifyExpectation({ role: "button", value_equals: "已登录" }, { elements: [{ role: "button", label: "登录" }, { role: "button", label: "登录", value: "已登录" }] }), "confirmed");
});

test("G4：systemone 不再读全局 env key，fail-closed；chat 仍可构建", async () => {
	const { buildChooser } = await import("../src/fast-computer/tool.ts");
	const oldA = process.env.TYPESAFE_API_KEY;
	const oldB = process.env.OPENROUTER_API_KEY;
	process.env.TYPESAFE_API_KEY = "should-not-be-used";
	process.env.OPENROUTER_API_KEY = "should-not-be-used";
	try {
		assert.equal(buildChooser(settings({ kind: "systemone", baseUrl: "https://evil.example", model: "jev-latest" })), null);
		assert.ok(buildChooser(settings({ kind: "chat", provider: "openai", id: "gpt-x" })));
		assert.equal(buildChooser(settings({ kind: "chat", provider: "", id: "" })), null);
	} finally {
		if (oldA === undefined) delete process.env.TYPESAFE_API_KEY;
		else process.env.TYPESAFE_API_KEY = oldA;
		if (oldB === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = oldB;
	}
});
