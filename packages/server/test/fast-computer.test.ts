/**
 * 快速操作模型：默认关闭零调用、受限候选选择、未知 candidate/capture 不执行、错误/超时/低可信回退、
 * 熔断、用量记账、候选白名单、SystemOne / chat 协议解析。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastActionCandidate, FastActionChooser, FastComputerSettings } from "../src/fast-computer/index.ts";
const fc = await import("../src/fast-computer/index.ts");
const { createMockChooser, createClassifierChooser, parseChatChoice, parseClassifierChoice } = await import("../src/fast-computer/choosers.ts");

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
		settings: settings({ kind: "systemone", provider: "openrouter", id: "typesafe/jev-1.13" }),
		onUsage: (u) => seen.push(u),
	});
	assert.equal(seen.length, 1);
	assert.deepEqual(seen[0], { provider: "openrouter", model: "typesafe/jev-1.13", input: 12, output: 3 });
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

test("classifier 解析：选中 / 并列 / 非法概率 / 越界 / 缺置信度不合成", () => {
	const ids = ["a", "b"];
	const base = { provider: "openrouter", model: "typesafe/jev-1.13", api: "typesafe-system-one", stopReason: "stop" as const, timestamp: 1 };
	const ok = parseClassifierChoice({ ...base, answers: { pick: { type: "choice", choice: "a", confidence: 0.8, probabilities: { a: 0.8, b: 0.2 } } }, usage: { input: 5, output: 1, totalTokens: 6 } }, ids);
	assert.deepEqual(ok, { kind: "selected", candidateId: "a", confidence: 0.8, decisionConfidence: 0.6, probabilities: { a: 0.8, b: 0.2 }, usage: { input: 5, output: 1 }, model: "openrouter/typesafe/jev-1.13" });
	const tie = parseClassifierChoice({ ...base, answers: { pick: { type: "choice", choice: "a", confidence: 0.5, probabilities: { a: 0.5, b: 0.5 } } } }, ids);
	assert.equal(tie.kind, "abstain");
	const badProbs = parseClassifierChoice({ ...base, answers: { pick: { type: "choice", choice: "a", confidence: 0.8, probabilities: { a: 1.4, b: -0.1 } } } }, ids);
	assert.equal(badProbs.kind, "selected");
	if (badProbs.kind === "selected") {
		assert.equal(badProbs.probabilities, undefined, "非法概率整体丢弃，不部分信任");
		assert.equal(badProbs.decisionConfidence, undefined, "概率非法时不合成阈值比较值，退回协议 confidence");
	}
	const noConf = parseClassifierChoice({ ...base, answers: { pick: { type: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 } } } as never }, ids);
	assert.equal(noConf.kind, "abstain", "SDK 未给置信度一律 unknown，绝不合成");
	const noProbs = parseClassifierChoice({ ...base, answers: { pick: { type: "choice", choice: "a", confidence: 0.8 } } as never }, ids);
	assert.equal(noProbs.kind, "selected");
	if (noProbs.kind === "selected") {
		assert.equal(noProbs.probabilities, undefined, "概率缺失 → unknown，不合成");
		assert.equal(noProbs.decisionConfidence, undefined, "概率缺失 → 不合成阈值比较值");
	}
	const outOfSet = parseClassifierChoice({ ...base, answers: { pick: { type: "choice", choice: "z", confidence: 0.9, probabilities: { z: 1 } } } }, ids);
	assert.equal(outOfSet.kind, "error");
	const failed = parseClassifierChoice({ ...base, stopReason: "error", errorMessage: "System One API error (401)", answers: {} }, ids);
	assert.equal(failed.kind, "error");
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

test("classifier chooser：只发离散 choice 问题、答案必须是候选 id（假 classify）", async () => {
	let got: { provider: string; model: string; context: { questions: { pick: { type: string; criteria: Record<string, string> } } } } | undefined;
	const chooser = createClassifierChooser({
		provider: "openrouter",
		model: "typesafe/jev-1.13",
		classify: async (provider, model, context) => {
			got = { provider, model, context: context as never };
			return { provider, model, api: "typesafe-system-one", answers: { pick: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } } }, usage: { input: 7, output: 2, totalTokens: 9 }, stopReason: "stop", timestamp: 1 };
		},
	});
	const r = await chooser.choose({ goal: "点登录", captureId: "cap-1", candidates: [{ id: "a", label: "按钮：登录" }, { id: "b", label: "按钮：取消" }] });
	assert.equal(chooser.id, "systemone");
	assert.equal(chooser.nativeProbability, true);
	assert.equal(got?.provider, "openrouter");
	assert.equal(got?.model, "typesafe/jev-1.13");
	assert.equal(got?.context.questions.pick.type, "choice");
	assert.deepEqual(got?.context.questions.pick.criteria, { a: "按钮：登录", b: "按钮：取消" });
	assert.equal(r.kind === "selected" && r.candidateId, "a");
});

test("classifier chooser：classify 抛错 / 中止 → error（超时归 timeout）", async () => {
	const boom = createClassifierChooser({ provider: "p", model: "m", classify: async () => { throw new Error("aborted"); } });
	const r = await boom.choose({ goal: "g", captureId: "c", candidates: [{ id: "a", label: "a" }] });
	assert.equal(r.kind, "error");
	if (r.kind === "error") assert.equal(r.error, "timeout");
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

test("G4：systemone 从 classifier 目录选（provider+id）构建，不读全局 env key；chat 仍可构建", async () => {
	const { buildChooser } = await import("../src/fast-computer/tool.ts");
	const oldA = process.env.TYPESAFE_API_KEY;
	const oldB = process.env.OPENROUTER_API_KEY;
	process.env.TYPESAFE_API_KEY = "should-not-be-used";
	process.env.OPENROUTER_API_KEY = "should-not-be-used";
	try {
		// 选了 classifier 模型 → 构建原生 Jev chooser（不再看 baseUrl / 全局 env）
		const native = buildChooser(settings({ kind: "systemone", provider: "openrouter", id: "typesafe/jev-1.13" }));
		assert.ok(native, "选了 classifier 模型应构建原生 Jev chooser");
		assert.equal(native!.id, "systemone");
		assert.equal(native!.nativeProbability, true);
		// 没选 classifier 模型 / 只有旧 baseUrl → 不构建，不猜
		assert.equal(buildChooser(settings({ kind: "systemone", baseUrl: "https://evil.example", model: "jev-latest" })), null);
		assert.equal(buildChooser(settings({ kind: "systemone", provider: "openrouter", id: "" })), null);
		assert.ok(buildChooser(settings({ kind: "chat", provider: "openai", id: "gpt-x" })));
		assert.equal(buildChooser(settings({ kind: "chat", provider: "", id: "" })), null);
	} finally {
		if (oldA === undefined) delete process.env.TYPESAFE_API_KEY;
		else process.env.TYPESAFE_API_KEY = oldA;
		if (oldB === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = oldB;
	}
});

// ---------------------------------------------------------------- 阈值标度（Laya 归一化熵 vs 概率）

test("阈值标度：概率按 Jev 公式换算，不用 Laya 的归一化熵", () => {
	const ids = ["a", "b", "c", "d", "e", "f", "g"];
	const probs = Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 0.7 : 0.05]));
	const gate = fc.jevChoiceConfidence(probs, ids);
	assert.ok(typeof gate === "number");
	assert.ok(Math.abs(gate! - (0.7 - 1 / 7) / (1 - 1 / 7)) < 1e-12, `7 候选 0.7 → ${gate}`);
	// 同样的 0.6 选项概率在 32 个候选下仍接近阈值；归一化熵那套会掉到约 0.41，必然被拒。
	const ids32 = Array.from({ length: 32 }, (_, i) => `c${i}`);
	const probs32 = Object.fromEntries(ids32.map((id, i) => [id, i === 0 ? 0.6 : 0.4 / 31]));
	const gate32 = fc.jevChoiceConfidence(probs32, ids32)!;
	assert.ok(gate32 > 0.58 && gate32 < 0.6, `32 候选 0.6 → ${gate32}`);
	assert.ok(Math.abs(fc.jevChoiceConfidence({ a: 0.9, b: 0.1 }, ["a", "b"])! - 0.8) < 1e-9);
	assert.equal(fc.jevChoiceConfidence({ a: 0.4 }, ["a"]), undefined, "单候选不合成置信度，退回协议值");
	assert.equal(fc.jevChoiceConfidence({ a: 0, b: 0 }, ["a", "b"]), 0, "总和 0 视为均匀 → 0");
	assert.equal(fc.jevChoiceConfidence({ a: 0.9 }, ["a", "b"]), undefined, "缺候选概率不部分信任");
	assert.equal(fc.jevChoiceConfidence({ a: 0.9, b: Number.NaN }, ["a", "b"]), undefined);
	assert.equal(fc.jevChoiceConfidence(undefined, ["a"]), undefined);
});

test("classifier 解析：decisionConfidence 从概率换算，协议 confidence 原样保留", () => {
	const ids = ["a", "b", "c", "d", "e", "f", "g"];
	const probabilities = Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 0.7 : 0.05]));
	const base = { provider: "local-laya", model: "multilingual", api: "typesafe-system-one", stopReason: "stop" as const, timestamp: 1 };
	const out = parseClassifierChoice({ ...base, answers: { pick: { type: "choice", choice: "a", confidence: 0.41, probabilities } } }, ids);
	assert.equal(out.kind, "selected");
	if (out.kind === "selected") {
		assert.equal(out.confidence, 0.41, "协议原值不改");
		assert.ok(Math.abs(out.decisionConfidence! - (0.7 - 1 / 7) / (1 - 1 / 7)) < 1e-12);
	}
});

test("阈值按 decisionConfidence 判定：熵低但选项概率够 → 选中", async () => {
	fc._resetFastComputerState();
	const r = await fc.selectFastAction({ key: "kg1", goal: "g", candidates: [cand("a"), cand("b")], chooser: createMockChooser(() => ({ kind: "selected", candidateId: "a", confidence: 0.41, decisionConfidence: 0.65 })), settings: settings({ threshold: 0.6 }) });
	assert.equal(r.kind, "selected");
	if (r.kind === "selected") {
		assert.equal(r.confidence, 0.41);
		assert.equal(r.decisionConfidence, 0.65);
	}
});

test("阈值按 decisionConfidence 判定：概率不够 → 回退，详情带上两个数", async () => {
	fc._resetFastComputerState();
	const r = await fc.selectFastAction({ key: "kg2", goal: "g", candidates: [cand("a"), cand("b")], chooser: createMockChooser(() => ({ kind: "selected", candidateId: "a", confidence: 0.9, decisionConfidence: 0.55, probabilities: { a: 0.7, b: 0.3 } })), settings: settings({ threshold: 0.6 }) });
	assert.equal(r.kind === "fallback" && r.reason, "low_confidence");
	if (r.kind === "fallback") {
		assert.match(r.detail ?? "", /0\.55/);
		assert.match(r.detail ?? "", /选项概率 0\.7/);
		assert.match(r.detail ?? "", /协议 confidence 0\.9/);
	}
});

test("没有概率时退回协议 confidence（不合成）", async () => {
	fc._resetFastComputerState();
	const r = await fc.selectFastAction({ key: "kg3", goal: "g", candidates: [cand("a")], chooser: createMockChooser(() => ({ kind: "selected", candidateId: "a", confidence: 0.7 })), settings: settings({ threshold: 0.6 }) });
	assert.equal(r.kind, "selected");
});

// ---------------------------------------------------------------- 熔断 / capture 新鲜度

test("用户取消（signal aborted）不计入熔断：可重试", async () => {
	fc._resetFastComputerState();
	let calls = 0;
	const chooser = createMockChooser(() => (calls++, { kind: "error", error: "timeout" }));
	for (let i = 0; i < 4; i++) {
		const ac = new AbortController();
		ac.abort();
		const r = await fc.selectFastAction({ key: "kabort", goal: "g", candidates: [cand("a")], chooser, settings: settings(), signal: ac.signal });
		assert.equal(r.kind === "fallback" && r.reason, "timeout");
	}
	assert.equal(calls, 4, "取消不该触发 circuit_open，用户可重试");
});

test("保存设置清掉熔断（换模型 / 改阈值后能再试）", async () => {
	fc._resetFastComputerState();
	let calls = 0;
	const chooser = createMockChooser(() => (calls++, { kind: "abstain" }));
	for (let i = 0; i < 3; i++) await fc.selectFastAction({ key: "kreset", goal: "g", candidates: [cand("a")], chooser, settings: settings() });
	const blocked = await fc.selectFastAction({ key: "kreset", goal: "g", candidates: [cand("a")], chooser, settings: settings() });
	assert.equal(blocked.kind === "fallback" && blocked.reason, "circuit_open");
	fc.saveFastComputerSettings({ enabled: true, threshold: 0.5 });
	const after = await fc.selectFastAction({ key: "kreset", goal: "g", candidates: [cand("a")], chooser, settings: fc.fastComputerSettings() });
	assert.equal(after.kind === "fallback" && after.reason, "abstain");
	assert.equal(calls, 4);
});

test("captureId 内容寻址：同窗口同候选稳定，候选变了才变（Laya 把 state 序列化进模型输入）", async () => {
	fc._resetFastComputerState();
	const seen: string[] = [];
	const chooser = createMockChooser((req) => (seen.push(req.captureId), { kind: "abstain" }));
	for (let i = 0; i < 2; i++) await fc.selectFastAction({ key: "kcap", goal: "g", candidates: [cand("a"), cand("b")], chooser, settings: settings() });
	assert.equal(seen[0], seen[1], "同一窗口同一候选 → 同一个 captureId（同一份模型输入，不受随机 token 干扰）");
	await fc.selectFastAction({ key: "kcap", goal: "g", candidates: [cand("a"), cand("c")], chooser, settings: settings() });
	assert.notEqual(seen[2], seen[0], "候选变了 → captureId 变，旧 capture 失效");
	assert.match(seen[0], /^cap-[0-9a-f]{16}$/);
});
