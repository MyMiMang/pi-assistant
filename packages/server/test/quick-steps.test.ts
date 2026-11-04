/**
 * 快速执行者的纯逻辑单测：候选解析、过滤排序、问题构造、判断、拼 cua 调用、核对。
 * 执行循环的单测在 quick-steps-tool.test.ts。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";

const { buildCall, buildClassifierContext, decide, exactMatch, filterByKind, parseObservation, rankCandidates, verifyStep } = await import("@pi-assistant/ext-computer");
type Candidate = import("@pi-assistant/ext-computer").Candidate;
type Observation = import("@pi-assistant/ext-computer").Observation;

const WIN = { kind: "window" as const, pid: 1, window_id: 2 };
const BROWSER = { kind: "browser" as const, tab_id: "t1" };

/** 用窗口结构造一份观察，省得每处都写全 */
const obsOf = (elements: Record<string, unknown>[]): Observation => parseObservation(WIN, { elements }, "", []);

test("窗口 elements 解析：token / role / label / value；没有 element_token 的跳过", () => {
	const obs = parseObservation(
		WIN,
		{
			elements: [
				{ element_token: "s1:1", role: "textfield", label: "名称", value: "旧值" },
				{ element_token: "s1:2", role: "button", label: "提交", actions: ["press"] },
				{ role: "button", label: "没有 token" },
				{ element_token: "s1:3", role: "button", title: "只有 title" },
			],
		},
		"",
		[],
	);
	assert.deepEqual(
		obs.candidates.map((c) => [c.id, c.handle, c.role, c.name, c.value]),
		[
			["c1", "s1:1", "textfield", "名称", "旧值"],
			["c2", "s1:2", "button", "提交", undefined],
			["c3", "s1:3", "button", "只有 title", undefined],
		],
	);
	assert.deepEqual(obs.candidates[1]!.actions, ["press"]);
});

test("网页解析：refs 数组、elements 数组、只有文本三种都认；非法 ref 跳过；重复只留第一个", () => {
	const refs = parseObservation(BROWSER, { refs: [{ ref: "p1:2", role: "textbox", name: "名称" }, { ref: "bad", role: "button", name: "坏的" }, { ref: "p1:2", role: "textbox", name: "重复" }], title: "表单", url: "https://example.com" }, "", []);
	assert.deepEqual(
		refs.candidates.map((c) => [c.id, c.handle, c.name]),
		[["c1", "p1:2", "名称"]],
	);
	assert.equal(refs.title, "表单");
	assert.equal(refs.url, "https://example.com");
	// 另一种字段名（elements）+ page 里的标题 / 地址
	const els = parseObservation(BROWSER, { elements: [{ ref: "p9:1", role: "button", label: "确定" }], page: { title: "设置", url: "https://a/b" } }, "", []);
	assert.deepEqual(els.candidates.map((c) => [c.handle, c.role, c.name]), [["p9:1", "button", "确定"]]);
	assert.equal(els.title, "设置");
	assert.equal(els.url, "https://a/b");
	// 只有文本
	const text = parseObservation(BROWSER, null, '[3] button "提交" [p5:3]\ntextbox "名称" [p5:4]\n没有 ref 的一行', []);
	assert.deepEqual(
		text.candidates.map((c) => [c.handle, c.role, c.name]),
		[
			["p5:3", "button", "提交"],
			["p5:4", "textbox", "名称"],
		],
	);
});

test("fingerprint：ref 变了但内容一样 → 相同；值变了 → 不同", () => {
	const a = obsOf([{ element_token: "s1:1", role: "textfield", label: "名称", value: "x" }]);
	const b = obsOf([{ element_token: "s2:9", role: "textfield", label: "名称", value: "x" }]);
	const c = obsOf([{ element_token: "s1:1", role: "textfield", label: "名称", value: "y" }]);
	assert.equal(a.fingerprint, b.fingerprint, "handle 不进 fingerprint");
	assert.notEqual(a.fingerprint, c.fingerprint);
});

test("filterByKind：type 只留输入框、select 只留下拉、过滤为空返回原列表、AXButton 认成 button", () => {
	const list: Candidate[] = [
		{ id: "c1", handle: "p1:1", role: "textfield", name: "名称" },
		{ id: "c2", handle: "p1:2", role: "button", name: "提交" },
		{ id: "c3", handle: "p1:3", role: "combobox", name: "分辨率" },
	];
	assert.deepEqual(filterByKind("type", list).map((c) => c.id), ["c1", "c3"], "输入框和可填的下拉都算 type 的候选（方案 §3.3）");
	assert.deepEqual(filterByKind("select", list).map((c) => c.id), ["c3"]);
	assert.deepEqual(filterByKind("check", list).map((c) => c.id), ["c1", "c2", "c3"], "过滤为空时原样返回，让决策模型自己判断");
	assert.deepEqual(filterByKind("click", [{ id: "c9", handle: "s1:9", role: "AXButton", name: "确定" }]).map((c) => c.id), ["c9"]);
	assert.deepEqual(filterByKind("press", list), [], "按键不需要候选");
	// upload 按 actions 里的 upload 认
	assert.deepEqual(filterByKind("upload", [{ id: "c5", handle: "p1:5", role: "button", name: "选择文件", actions: ["upload"] }]).map((c) => c.id), ["c5"]);
});

test("rankCandidates：相近的排前面、最多 24 个、id 不变", () => {
	const list: Candidate[] = [
		{ id: "c1", handle: "p1:1", role: "button", name: "名称说明" },
		{ id: "c2", handle: "p1:2", role: "button", name: "提交" },
		{ id: "c3", handle: "p1:3", role: "textfield", name: "名称" },
	];
	assert.deepEqual(rankCandidates("名称", list).map((c) => c.name), ["名称", "名称说明", "提交"]);
	const many: Candidate[] = Array.from({ length: 30 }, (_, i) => ({ id: `c${i + 1}`, handle: `p1:${i + 1}`, role: "button", name: `项目 ${i + 1}` }));
	const top = rankCandidates("项目 7", many);
	assert.equal(top.length, 24);
	assert.equal(top[0]!.id, "c7", "id 保持原来的，不重新编号");
	assert.ok(top.every((c) => many.some((m) => m.id === c.id)));
});

test("exactMatch：唯一完全一致才命中；两个同名不命中", () => {
	const list: Candidate[] = [
		{ id: "c1", handle: "p1:1", role: "button", name: "提交" },
		{ id: "c2", handle: "p1:2", role: "textfield", name: "名称" },
	];
	assert.equal(exactMatch("名称", list)?.id, "c2");
	assert.equal(exactMatch("名称", [...list, { id: "c3", handle: "p1:3", role: "textfield", name: " 名称 " }]), null);
	assert.equal(exactMatch("没这个", list), null);
});

test("buildClassifierContext：type 不带 value、select 带；有 reobserve / abstain；withImage 才带图", () => {
	const obs = obsOf([{ element_token: "s1:1", role: "textfield", label: "名称", value: "" }]);
	const typeStep = { do: "type" as const, what: "名称", value: "苏折竹" };
	const ctx = buildClassifierContext(typeStep, 0, 3, [], obs, obs.candidates, false);
	assert.equal(JSON.stringify(ctx.state).includes("苏折竹"), false, "要填的内容不给决策模型看");
	assert.match(ctx.state.任务, /第 1\/3 步：在「名称」里填写/);
	assert.equal(ctx.questions.pick.criteria.c1, "textfield「名称」");
	assert.ok(ctx.questions.pick.criteria.reobserve && ctx.questions.pick.criteria.abstain);
	assert.equal(ctx.images, undefined);
	const sel = buildClassifierContext({ do: "select", what: "分辨率", value: "2K" }, 0, 1, ["点了确定"], obs, obs.candidates, false);
	assert.match(sel.state.任务, /选择「2K」/, "选择要知道选哪个，否则判断不了是不是对的下拉");
	assert.deepEqual(sel.state.已完成, ["点了确定"]);
	const shot = { ...obs, screenshot: { data: "AAA", mimeType: "image/png" } };
	assert.equal(buildClassifierContext(typeStep, 0, 1, [], shot, obs.candidates, true).images?.length, 1);
	assert.equal(buildClassifierContext(typeStep, 0, 1, [], shot, obs.candidates, false).images, undefined, "模型不支持看图就不带");
});

test("decide：拿不准 / 重新读一次（只一次）/ 概率阈值 / 乱回答", () => {
	const list: Candidate[] = [
		{ id: "c1", handle: "p1:1", role: "button", name: "提交" },
		{ id: "c2", handle: "p1:2", role: "button", name: "取消" },
	];
	assert.deepEqual(decide({ type: "choice", choice: "abstain", probabilities: {}, confidence: 1 }, list, false), { kind: "stop", reason: "决策模型拿不准" });
	assert.deepEqual(decide({ type: "choice", choice: "reobserve", probabilities: {}, confidence: 1 }, list, false), { kind: "reobserve" });
	assert.deepEqual(decide({ type: "choice", choice: "reobserve", probabilities: {}, confidence: 1 }, list, true), { kind: "stop", reason: "页面一直没准备好" });
	const low = decide({ type: "choice", choice: "c1", probabilities: { c1: 0.59, c2: 0.41 }, confidence: 0.59 }, list, false);
	assert.equal(low.kind, "stop");
	assert.match(low.kind === "stop" ? low.reason : "", /0\.59/);
	assert.match(low.kind === "stop" ? low.reason : "", /提交/, "原因里附上概率最高的候选");
	assert.deepEqual(decide({ type: "choice", choice: "c1", probabilities: { c1: 0.6, c2: 0.4 }, confidence: 0.6 }, list, false), { kind: "pick", candidate: list[0], probability: 0.6 });
	assert.equal(decide("随便", list, false).kind, "stop");
	assert.equal(decide({ type: "choice" }, list, false).kind, "stop");
	assert.equal(decide({ type: "choice", choice: "c9", probabilities: { c9: 0.9 } }, list, false).kind, "stop", "选了不存在的候选也停下");
});

test("buildCall：每种 do × 两种 target；值只来自 step；缺 value / files / key 报错", () => {
	const P = "mcp__hostpc__";
	const W = "mcp__computer__";
	const browser = { kind: "browser" as const, tab_id: "t1", target_id: "g1" };
	const win = { kind: "window" as const, pid: 7, window_id: 8 };
	const c: Candidate = { id: "c1", handle: "p1:2", role: "textbox", name: "名称" };
	const base = { tab_id: "t1", target_id: "g1" };
	assert.deepEqual(buildCall({ do: "type", what: "名称", value: "苏折竹" }, c, browser, P), { tool: `${P}browser_type`, args: { ...base, ref: "p1:2", text: "苏折竹", replace: true } });
	assert.deepEqual(buildCall({ do: "click", what: "提交" }, c, browser, P), { tool: `${P}browser_click`, args: { ...base, ref: "p1:2" } });
	assert.deepEqual(buildCall({ do: "check", what: "记住我" }, c, browser, P), { tool: `${P}browser_click`, args: { ...base, ref: "p1:2" } });
	assert.deepEqual(buildCall({ do: "select", what: "分辨率", value: "2K" }, c, browser, P), { tool: `${P}browser_select`, args: { ...base, ref: "p1:2", label: "2K" } });
	assert.deepEqual(buildCall({ do: "upload", what: "图片", files: ["/a.png"] }, c, browser, P), { tool: `${P}browser_set_input_files`, args: { ...base, ref: "p1:2", files: ["/a.png"] } });
	assert.ok("error" in buildCall({ do: "press", what: "回车", key: "return" }, null, browser, P), "网页里按键交回大模型");
	assert.deepEqual(buildCall({ do: "click", what: "提交" }, c, win, W), { tool: `${W}click`, args: { pid: 7, window_id: 8, element_token: "p1:2" } });
	assert.deepEqual(buildCall({ do: "type", what: "名称", value: "苏折竹" }, c, win, W), { tool: `${W}set_value`, args: { pid: 7, window_id: 8, element_token: "p1:2", value: "苏折竹" } });
	assert.deepEqual(buildCall({ do: "select", what: "分辨率", value: "2K" }, c, win, W), { tool: `${W}set_value`, args: { pid: 7, window_id: 8, element_token: "p1:2", value: "2K" } });
	assert.deepEqual(buildCall({ do: "press", what: "回车", key: "return" }, null, win, W), { tool: `${W}press_key`, args: { pid: 7, window_id: 8, key: "return" } });
	assert.ok("error" in buildCall({ do: "upload", what: "图片", files: ["/a.png"] }, c, win, W), "窗口里上传文件交回大模型");
	assert.ok("error" in buildCall({ do: "type", what: "名称" }, c, browser, P));
	assert.ok("error" in buildCall({ do: "select", what: "分辨率" }, c, win, W));
	assert.ok("error" in buildCall({ do: "upload", what: "图片" }, c, browser, P));
	assert.ok("error" in buildCall({ do: "press", what: "回车" }, null, win, W));
	// 要填的值只来自 step：候选自己的 value 绝不会被当成要填的内容
	const withValue: Candidate = { ...c, value: "候选自己的值" };
	const call = buildCall({ do: "type", what: "名称", value: "我写的" }, withValue, browser, P);
	assert.ok("args" in call);
	assert.equal(call.args.text, "我写的");
});

test("verifyStep：值对上 ok、值不对 fail、找不到 ok、点击有变化 ok、没变化 fail", () => {
	const before = obsOf([{ element_token: "s1:1", role: "textfield", label: "名称", value: "" }]);
	const picked = before.candidates[0]!;
	const afterOk = obsOf([{ element_token: "s2:1", role: "textfield", label: "名称", value: "苏折竹" }]);
	const afterBad = obsOf([{ element_token: "s2:1", role: "textfield", label: "名称", value: "旧值" }]);
	const afterGone = obsOf([{ element_token: "s2:2", role: "button", label: "下一页" }]);
	const typeStep = { do: "type" as const, what: "名称", value: "苏折竹" };
	assert.equal(verifyStep(typeStep, picked, before, afterOk).ok, true);
	const bad = verifyStep(typeStep, picked, before, afterBad);
	assert.equal(bad.ok, false);
	assert.match(bad.ok === false ? bad.reason : "", /值没变/);
	assert.equal(verifyStep(typeStep, picked, before, afterGone).ok, true, "找不到原来的输入框不算失败");
	assert.equal(verifyStep({ do: "click", what: "提交" }, null, before, afterOk).ok, true);
	const still = verifyStep({ do: "click", what: "提交" }, null, before, before);
	assert.equal(still.ok, false);
	assert.match(still.ok === false ? still.reason : "", /没有变化/);
});
