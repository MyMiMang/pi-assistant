/**
 * 目标模式的纯逻辑单测：候选动作生成、剪枝、危险按钮守门、问题构造、动作转步骤。
 * 执行循环的单测在 quick-goal-run.test.ts。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";

const { actionToStep, buildGoalContext, goalActions, guardedOut, parseObservation } = await import("@pi-assistant/ext-computer");
type Candidate = import("@pi-assistant/ext-computer").Candidate;
type GoalAction = import("@pi-assistant/ext-computer").GoalAction;
type GoalInput = import("@pi-assistant/ext-computer").GoalInput;
type Observation = import("@pi-assistant/ext-computer").Observation;

const WIN = { kind: "window" as const, pid: 1, window_id: 2 };
const obsOf = (elements: Record<string, unknown>[]): Observation => parseObservation(WIN, { elements }, "", []);

const FORM = [
	{ element_token: "s1:1", role: "textbox", label: "名称" },
	{ element_token: "s1:2", role: "combobox", label: "分辨率" },
	{ element_token: "s1:3", role: "button", label: "参考图片", actions: ["upload"] },
	{ element_token: "s1:4", role: "checkbox", label: "高清" },
	{ element_token: "s1:5", role: "button", label: "提交" },
	{ element_token: "s1:6", role: "button", label: "取消" },
];
const INPUTS: GoalInput[] = [
	{ name: "名称", value: "苏折竹" },
	{ name: "分辨率", value: "2K" },
	{ name: "参考图片", files: ["/a.png", "/b.png"] },
];
const ALL_PENDING = new Set([0, 1, 2]);

test("表单生成 fill / select / upload / check / click，最后固定 4 个动作", () => {
	const actions = goalActions(obsOf(FORM), INPUTS, ALL_PENDING, "把表单填好并提交");
	const kinds = actions.map((a) => a.kind);
	for (const k of ["fill", "select", "upload", "check", "click"] as const) assert.ok(kinds.includes(k), `缺少 ${k}：${kinds.join(",")}`);
	assert.deepEqual(kinds.slice(-4), ["scroll", "finish", "reobserve", "abstain"]);
	assert.deepEqual(
		actions.map((a) => a.id),
		actions.map((_, i) => `a${i + 1}`),
	);
	assert.match(actions.find((a) => a.kind === "fill")!.desc, /在textbox「名称」里填「名称」的值/);
	assert.match(actions.find((a) => a.kind === "select")!.desc, /在「分辨率」里选「2K」/);
	assert.match(actions.find((a) => a.kind === "upload")!.desc, /2 个文件传到「参考图片」/);
});

test("每个元素最多给 2 个 input；所有动作超过 28 个只留 28 个（加固定 4 个）", () => {
	const inputs: GoalInput[] = Array.from({ length: 6 }, (_, i) => ({ name: `名称${i + 1}`, value: `v${i}` }));
	const one = goalActions(obsOf([{ element_token: "s1:1", role: "textbox", label: "名称输入" }]), inputs, new Set([0, 1, 2, 3, 4, 5]), "填表");
	assert.equal(one.filter((a) => a.kind === "fill").length, 2, "一个元素最多 2 个 input");
	const many = obsOf(Array.from({ length: 40 }, (_, i) => ({ element_token: `s1:${i + 1}`, role: "button", label: `按钮 ${i + 1}` })));
	const actions = goalActions(many, [], new Set(), "做点事");
	assert.equal(actions.length, 32, "28 个候选 + 4 个固定动作");
	assert.deepEqual(actions.slice(-4).map((a) => a.kind), ["scroll", "finish", "reobserve", "abstain"]);
});

test("危险按钮守门：目标里没写提交 / 取消就不列入", () => {
	const draft = goalActions(obsOf(FORM), INPUTS, ALL_PENDING, "把表单填好").filter((a) => a.kind === "click").map((a) => a.candidate!.name).sort();
	assert.deepEqual(draft, [], "没写「提交」时提交按钮不列入；取消永远不列入");
	const submit = goalActions(obsOf(FORM), INPUTS, ALL_PENDING, "填好并提交").filter((a) => a.kind === "click").map((a) => a.candidate!.name).sort();
	assert.deepEqual(submit, ["提交"], "目标写了提交才列入，取消仍然不列入");
});

test("已经用过的 input 不再生成 fill / select / upload", () => {
	const actions = goalActions(obsOf(FORM), INPUTS, new Set([2]), "把表单填好并提交");
	assert.equal(actions.filter((a) => a.kind === "fill").length, 0);
	assert.equal(actions.filter((a) => a.kind === "select").length, 0);
	assert.equal(actions.filter((a) => a.kind === "upload").length, 1, "还没用上的参考图片还有");
	assert.ok(actions.every((a) => a.input !== 0 && a.input !== 1));
});

test("buildGoalContext：目标 / 要用的值（含状态）/ 已经做了 / 页面内容；criteria 和 actions 一一对应；withImage 才带图", () => {
	const obs = obsOf(FORM);
	const actions = goalActions(obs, INPUTS, new Set([1]), "把表单填好并提交");
	const ctx = buildGoalContext("把表单填好并提交", INPUTS, new Set([1]), ["打开页面", "填名称"], obs, actions, false);
	assert.equal(ctx.state.目标, "把表单填好并提交");
	assert.deepEqual(ctx.state.要用的值, [
		{ 名字: "名称", 值: "苏折竹", 状态: "已用过" },
		{ 名字: "分辨率", 值: "2K", 状态: "还没用" },
		{ 名字: "参考图片", 值: "2 个文件", 状态: "已用过" },
	]);
	assert.deepEqual(ctx.state.已经做了, ["打开页面", "填名称"]);
	assert.match(ctx.state.页面.内容, /textbox「名称」/);
	assert.deepEqual(Object.keys(ctx.questions.next.criteria), actions.map((a) => a.id));
	assert.equal(ctx.questions.next.instructions.includes("finish"), true);
	assert.equal(ctx.images, undefined);
	const shot = { ...obs, screenshot: { data: "AAA", mimeType: "image/png" } };
	assert.equal(buildGoalContext("x", INPUTS, new Set(), [], shot, actions, true).images?.length, 1);
	assert.equal(buildGoalContext("x", INPUTS, new Set(), [], shot, actions, false).images, undefined);
});

test("actionToStep：值只来自 inputs；scroll / finish / reobserve / abstain 返回 null", () => {
	const c: Candidate = { id: "c1", handle: "s1:1", role: "textbox", name: "名称", value: "候选自己的值" };
	const a = (kind: GoalAction["kind"]): GoalAction => ({ id: "a1", kind, candidate: c, input: 0, desc: "x" });
	assert.deepEqual(actionToStep(a("fill"), INPUTS), { do: "type", what: "名称", value: "苏折竹" });
	assert.deepEqual(actionToStep(a("select"), INPUTS), { do: "select", what: "名称", value: "苏折竹" });
	assert.deepEqual(actionToStep(a("upload"), [{ name: "图", files: ["/x.png"] }]), { do: "upload", what: "名称", files: ["/x.png"] });
	assert.deepEqual(actionToStep({ id: "a1", kind: "click", candidate: c, desc: "x" }, INPUTS), { do: "click", what: "名称" });
	assert.deepEqual(actionToStep({ id: "a1", kind: "check", candidate: c, desc: "x" }, INPUTS), { do: "check", what: "名称" });
	for (const k of ["scroll", "finish", "reobserve", "abstain"] as const) assert.equal(actionToStep({ id: "a1", kind: k, desc: "x" }, INPUTS), null);
});

test("guardedOut：目标里写到的危险词不拦，没写的拦", () => {
	assert.equal(guardedOut("删除文件", "删除旧文件"), false);
	assert.equal(guardedOut("删除文件", "整理文件"), true);
	assert.equal(guardedOut("提交表单", "填好并提交"), false);
	assert.equal(guardedOut("取消", "填好并提交"), true);
});
