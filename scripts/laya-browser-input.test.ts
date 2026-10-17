/**
 * 【研究 fixture】浏览器专项 checkpoint 的输入契约（纯函数）：只验证构造 / 分块 / 合并 / 解释，
 * 不启动模型、不下载权重、不碰网络；不属于产品测试集。
 *
 * 跑法：`node --test --import tsx scripts/laya-browser-input.test.ts`
 * 对照上游 `cklxx/laya-browser` revision `645cf366` 的 `laya_browser.py`（Apache-2.0，见 THIRD_PARTY_NOTICES）。
 */
await import("../packages/server/test/setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildBrowserRequest,
	compactCriterion,
	cutLabel,
	fieldsSummary,
	actionSpace,
	interpretBrowserAnswers,
	mergeChunkedAnswers,
	pythonRepr,
	secondPassQuestions,
	splitWideChoices,
	type BrowserAction,
} from "./laya-browser-input.ts";

const actions = (): BrowserAction[] => [
	{ id: "e1", kind: "fill", node: 1, label: "Search packages", role: "searchbox", value: "" },
	{ id: "e2", kind: "click", node: 2, label: "Search", role: "button" },
	{ id: "e3", kind: "click", node: 3, label: "argo", role: "link" },
	{ id: "e4", kind: "select", node: 4, label: "Sort → Relevance", role: "combobox", current_value: "Relevance" },
	{ id: "e5", kind: "select", node: 4, label: "Sort → Downloads", role: "combobox", current_value: "Relevance" },
	{ id: "scroll_down", kind: "scroll", node: 0, label: "Scroll down" },
];

test("compactCriterion：v5 选项字符串（去 [key]、带 role / 当前值 / 勾选态）", () => {
	assert.equal(compactCriterion({ element: "[3] argo", role: "link" }), "argo (link)");
	assert.equal(compactCriterion({ element: "[1] Search packages", role: "searchbox", current_value: "vim" }), "Search packages (searchbox) = 'vim'");
	assert.equal(compactCriterion({ element: "[6] Subscribe", role: "checkbox", checked: false }), "Subscribe (checkbox) checked=False");
	// <select> 选项：只留“字段 → 选项”，不重复 role
	assert.equal(compactCriterion({ element: "[4] Sort → Downloads" }), "Sort → Downloads");
	// 非对象（operation 问题的纯文本）原样
	assert.equal(compactCriterion("Click an element."), "Click an element.");
});

test("pythonRepr / cutLabel：引号转义与标签截断（含 → 两侧分别截断）", () => {
	assert.equal(pythonRepr("it's"), "'it\\'s'");
	assert.equal(cutLabel("short"), "short");
	const long = "x".repeat(80);
	assert.equal(cutLabel(long).length, 50);
	const arrow = `${"a".repeat(60)} → ${"b".repeat(60)}`;
	const cut = cutLabel(arrow);
	assert.ok(cut.includes(" → "));
	assert.ok(cut.endsWith("b".repeat(40)));
	// 上游 keep = max(12, n - opt - 3)，所以“字段 → 选项”整体可以比 n 长（12 + 3 + 40 = 55）
	assert.equal(cut.split(" → ")[0].length, 12);
	assert.equal(cut.length, 55);
});

test("actionSpace：按 node 去重、select 每个选项一个 index:option 目标、scroll 进控制项", () => {
	const space = actionSpace(actions());
	assert.equal(space.elements.length, 4);
	assert.deepEqual(Object.keys(space.targets).sort(), ["CLICK", "SELECT", "TYPE_TEXT"]);
	assert.deepEqual(Object.keys(space.targets.CLICK).sort(), ["2", "3"]);
	assert.deepEqual(Object.keys(space.targets.SELECT).sort(), ["4:1", "4:2"]);
	assert.equal(space.targets.SELECT["4:2"].id, "e5");
	assert.deepEqual(Object.keys(space.controls), ["SCROLL_DOWN"]);
	assert.equal(space.elementIds["4"], "e4");
});

test("fieldsSummary：只列可填 / 下拉 / 勾选，空值标 (empty)，最多 14 条", () => {
	const space = actionSpace(actions());
	const s = fieldsSummary(space.elements);
	assert.ok(s.includes("Search packages = (empty)"));
	assert.ok(s.includes("Sort = 'Relevance'"));
	const many = actionSpace(Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, kind: "fill", node: i, label: `F${i}`, role: "textbox", value: "" }) as BrowserAction));
	assert.equal(fieldsSummary(many.elements).split("; ").length, 14);
});

test("buildBrowserRequest：state 截 1200 字、history 留最后 10 条且只带 4 个键、问题名与 operation 选项齐全", () => {
	const page = { url: "https://example.test", title: "T", text: "y".repeat(5000), actions: actions() };
	const history = Array.from({ length: 12 }, (_, i) => ({ action: `a${i}`, kind: "click", text: null, page_changed: true, extra: "drop" }));
	const req = buildBrowserRequest(page, "Search for vim", history);
	assert.equal(req.state.page.text.length, 1200);
	assert.equal(req.state.recent_actions.length, 10);
	assert.equal(req.state.recent_actions[0].action, "a2");
	assert.deepEqual(Object.keys(req.state.recent_actions[0]).sort(), ["action", "kind", "page_changed", "text"]);
	assert.deepEqual(Object.keys(req.questions).sort(), ["click_target", "operation", "select_target", "type_text_target"]);
	assert.deepEqual(Object.keys(req.questions.operation.criteria).sort(), ["BLOCKED", "CLICK", "DONE", "SCROLL_DOWN", "SELECT", "TYPE_TEXT"]);
	assert.equal(req.questions.operation.criteria.SCROLL_DOWN, "Scroll down");
	// 目标候选：元素编号 → action id 的映射必须与 criteria 同源
	assert.equal(req.targetIds.CLICK["3"], "e3");
	assert.equal(req.targetIds.SELECT["4:2"], "e5");
	assert.equal(req.controlIds.SCROLL_DOWN, "scroll_down");
});

test("splitWideChoices / mergeChunkedAnswers：>60 交错切块，第二段赢家相乘归一", () => {
	const criteria: Record<string, string> = {};
	for (let i = 1; i <= 130; i++) criteria[String(i)] = `opt ${i}`;
	const questions = { click_target: { type: "choice" as const, instructions: { goal: "g" }, criteria } };
	const { questions: sent, plan } = splitWideChoices(questions, 60);
	assert.equal(plan.click_target.chunks.length, 3);
	assert.deepEqual(plan.click_target.chunks.flat().sort((a, b) => Number(a) - Number(b)), Object.keys(criteria));
	assert.ok(!sent.click_target);
	assert.equal(Object.keys(sent).filter((k) => k.startsWith("click_target__chunk")).length, 3);

	const answers = {
		"click_target__chunk0": { choice: "1", probabilities: { "1": 0.6, "4": 0.4 } },
		"click_target__chunk1": { choice: "2", probabilities: { "2": 0.9, "5": 0.1 } },
		"click_target__chunk2": { choice: "3", probabilities: { "3": 0.7, "6": 0.3 } },
	};
	const secondQs = secondPassQuestions(plan, answers);
	assert.deepEqual(Object.keys(secondQs.click_target.criteria).sort(), ["1", "2", "3"]);
	const merged = mergeChunkedAnswers(plan, answers, { click_target: { choice: "2", probabilities: { "1": 0.2, "2": 0.5, "3": 0.3 }, confidence: 0.4 } });
	assert.equal(merged.click_target.choice, "2");
	assert.ok(!("click_target__chunk0" in merged));
	const total = Object.values(merged.click_target.probabilities ?? {}).reduce((a, b) => a + b, 0);
	assert.ok(Math.abs(total - 1) < 1e-9);
	// 0.5*0.9 = 0.45 最大；非赢家块内选项也按 p(块赢家)*p_块内 计入（0.2*0.6 / 0.2*0.4 …）
	assert.ok(Math.abs((merged.click_target.probabilities?.["2"] ?? 0) - 0.45) < 1e-9);
	assert.ok(Math.abs((merged.click_target.probabilities?.["6"] ?? 0) - 0.09) < 1e-9);
});

test("mergeChunkedAnswers：第二段缺概率时不合成、块答案原样留着", () => {
	const criteria = { a: "a", b: "b", c: "c" };
	const questions = { click_target: { type: "choice" as const, instructions: {}, criteria } };
	const { plan } = splitWideChoices(questions, 2);
	const answers = { "click_target__chunk0": { choice: "a", probabilities: { a: 1, c: 0 } }, "click_target__chunk1": { choice: "b", probabilities: { b: 1 } } };
	const merged = mergeChunkedAnswers(plan, answers, { click_target: {} });
	assert.ok(!merged.click_target);
	assert.equal(merged["click_target__chunk0"].choice, "a");
});

test("interpretBrowserAnswers：operation → 目标 → action id；DONE / 缺目标 / 越界都不给 action", () => {
	const req = buildBrowserRequest({ actions: actions() }, "Search for vim");
	assert.deepEqual(interpretBrowserAnswers(req, { operation: { choice: "CLICK", confidence: 0.8 }, click_target: { choice: "3" } }), {
		operation: "CLICK",
		actionId: "e3",
		confidence: 0.8,
	});
	assert.equal(interpretBrowserAnswers(req, { operation: { choice: "SELECT" }, select_target: { choice: "4:2" } }).actionId, "e5");
	assert.equal(interpretBrowserAnswers(req, { operation: { choice: "SCROLL_DOWN" } }).actionId, "scroll_down");
	const done = interpretBrowserAnswers(req, { operation: { choice: "DONE", confidence: 0.9 } });
	assert.equal(done.actionId, undefined);
	assert.equal(done.reason, "done");
	assert.equal(interpretBrowserAnswers(req, { operation: { choice: "CLICK" } }).reason, "no_target_answer");
	assert.equal(interpretBrowserAnswers(req, { operation: { choice: "CLICK" }, click_target: { choice: "99" } }).reason, "target_not_offered");
	assert.equal(interpretBrowserAnswers(req, { operation: { choice: "WAIT" } }).reason, "operation_not_offered");
	assert.equal(interpretBrowserAnswers(req, {}).reason, "no_operation");
});
