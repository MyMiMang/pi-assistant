/**
 * 模型菜单分组规则单测（apps/web/src/modelMenu.ts 这条真实链路，纯函数，不起浏览器）：
 * 「常用」是快捷入口，不是把模型从原渠道分组里搬走。
 * 回归：选过一个「只有 1 个模型」的渠道后，原渠道分组整组消失、只剩常用。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { dedupeGroup, frequentModels, groupModelsByProvider, pickKey, rankPicks, searchModels } from "../../../apps/web/src/modelMenu.ts";

interface M {
	provider: string;
	id: string;
	name: string;
}
const m = (provider: string, id: string, name = id): M => ({ provider, id, name });
const nameOf = (p: string) => ({ "custom-a": "单模型渠道", "custom-b": "多模型渠道", mock: "Mock" })[p] ?? p;

// 单模型渠道 + 多模型渠道（同名模型跨渠道）+ 本地 mock
const models: M[] = [m("custom-a", "gpt-6.1-sol", "GPT 6.1 Sol"), m("custom-b", "gpt-6.1-sol", "GPT 6.1 Sol"), m("custom-b", "deepseek-v3", "DeepSeek V3"), m("custom-b", "kimi-k2", "Kimi K2"), m("mock", "echo")];
const pickTo = (slice: M[]): Record<string, { count: number; at: number }> =>
	Object.fromEntries(slice.map((x, i) => [pickKey(x), { count: 1, at: i + 1 }]));

test("canonical key 用 provider + id，同名模型跨渠道不合并", () => {
	assert.equal(pickKey(models[0]), "custom-a/gpt-6.1-sol");
	assert.notEqual(pickKey(models[0]), pickKey(models[1]));
	assert.equal(new Set(models.map(pickKey)).size, models.length);
});

test("选了单模型渠道的模型后：原渠道分组与行都还在（常用 1 行 + 原渠道 1 行）", () => {
	const picks = pickTo([models[0]]);
	const frequent = frequentModels(models, picks, "");
	assert.deepEqual(
		frequent.map(pickKey),
		["custom-a/gpt-6.1-sol"],
	);
	// 关键回归：分组不能因为进了常用就消失 / 少行
	const groups = groupModelsByProvider(models, nameOf, "custom-a");
	assert.deepEqual(
		groups.map((g) => g.provider),
		["custom-a", "custom-b", "mock"],
		"当前选中的服务排最前，且不能因为进常用就整组消失",
	);
	const a = groups.find((g) => g.provider === "custom-a");
	assert.ok(a && a.models.some((x) => x.id === "gpt-6.1-sol"), "原渠道分组里必须仍有这一行");
});

test("多模型渠道：选过的模型留在自己渠道，其余模型不受影响，跨渠道各一行", () => {
	const picks = pickTo([models[1]]);
	const frequent = frequentModels(models, picks, "");
	assert.deepEqual(
		frequent.map(pickKey),
		["custom-b/gpt-6.1-sol"],
		"同名模型只按选过的那个渠道进常用（不能只按 id 命中）",
	);
	const groups = groupModelsByProvider(models, nameOf);
	const b = groups.find((g) => g.provider === "custom-b");
	assert.deepEqual(
		b?.models.map(pickKey),
		["custom-b/gpt-6.1-sol", "custom-b/deepseek-v3", "custom-b/kimi-k2"],
		"选过的模型仍在原渠道，其余不受影响",
	);
	const a = groups.find((g) => g.provider === "custom-a");
	assert.ok(a?.models.some((x) => x.id === "gpt-6.1-sol"), "另一个渠道的同名模型不受影响");
});

test("同一分组内按 canonical key 去重；跨分组不合并", () => {
	const dup = [m("custom-a", "gpt-6.1-sol"), m("custom-a", "gpt-6.1-sol", "重复行"), m("custom-a", "x"), m("custom-b", "gpt-6.1-sol")];
	const groups = groupModelsByProvider(dup, nameOf);
	const a = groups.find((g) => g.provider === "custom-a");
	const b = groups.find((g) => g.provider === "custom-b");
	assert.deepEqual(a?.models.map((x) => x.name), ["gpt-6.1-sol", "x"], "同分组内重复条目只留第一行");
	assert.deepEqual(b?.models.map(pickKey), ["custom-b/gpt-6.1-sol"], "跨分组不能合并");
	assert.equal(dedupeGroup(dup).length, 3, "dedupeGroup 只做一维去重，不跨 provider 合并");
});

test("搜索时不显示常用，模型仍在自己渠道里能搜到", () => {
	const picks = pickTo([models[0]]);
	assert.deepEqual(frequentModels(models, picks, "gpt"), [], "搜索时不显示常用");
	const shown = searchModels(models, "gpt-6.1-sol", nameOf);
	const groups = groupModelsByProvider(shown, nameOf);
	assert.deepEqual(
		groups.map((g) => `${g.provider}:${g.models.map(pickKey).join(",")}`),
		["custom-a:custom-a/gpt-6.1-sol", "custom-b:custom-b/gpt-6.1-sol"],
		"两个渠道的同名模型都能搜到",
	);
	assert.deepEqual(searchModels(models, "单模型渠道", nameOf).map(pickKey), ["custom-a/gpt-6.1-sol"], "按服务名也能搜");
});

test("常用排序按频次、再按最近选择，最多 5 个；掉出常用不影响分组", () => {
	const picks = {
		"custom-a/gpt-6.1-sol": { count: 1, at: 1 },
		"custom-b/kimi-k2": { count: 3, at: 2 },
		"custom-b/deepseek-v3": { count: 1, at: 9 },
	};
	assert.deepEqual(rankPicks(picks), ["custom-b/kimi-k2", "custom-b/deepseek-v3", "custom-a/gpt-6.1-sol"]);
	const frequent = frequentModels(models, picks, "", 2);
	assert.deepEqual(
		frequent.map(pickKey),
		["custom-b/kimi-k2", "custom-b/deepseek-v3"],
	);
	// 单模型渠道的模型掉出常用后，原渠道分组里仍然有它
	const groups = groupModelsByProvider(models, nameOf);
	assert.ok(groups.find((g) => g.provider === "custom-a")?.models.some((x) => x.id === "gpt-6.1-sol"));
});

test("已删除 / 未配置渠道的模型不在列表里，就不会进常用（不 ghost 显示）", () => {
	const picks = { "custom-a/gpt-6.1-sol": { count: 2, at: 1 } };
	const remaining = models.filter((x) => x.provider !== "custom-a");
	assert.deepEqual(frequentModels(remaining, picks, ""), [], "列表里没有的模型不能从常用 ghost 回来");
	assert.ok(!groupModelsByProvider(remaining, nameOf).some((g) => g.provider === "custom-a"));
});
