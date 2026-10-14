/** 模型选择记录：频次 +1、最近选择时间更新、常用排序（次数优先，其次最近）、超量淘汰 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
const { getModelPicks, MAX_PICKS, rankModelPicks, recordModelPick } = await import("../src/model-picks.ts");

test("记录选择：频次累加，最近选择时间更新", () => {
	recordModelPick("p1", "m1", 1000);
	recordModelPick("p1", "m1", 2000);
	recordModelPick("p2", "m2", 3000);
	const picks = getModelPicks();
	assert.deepEqual(picks["p1/m1"], { count: 2, at: 2000 });
	assert.deepEqual(picks["p2/m2"], { count: 1, at: 3000 });
});

test("缺少 provider / id 不记录", () => {
	const before = JSON.stringify(getModelPicks());
	assert.deepEqual(recordModelPick(null, "m"), getModelPicks());
	assert.deepEqual(recordModelPick("p", ""), getModelPicks());
	assert.equal(JSON.stringify(getModelPicks()), before);
});

test("常用排序：次数多的在前，次数相同按最近选择", () => {
	const picks = { "a/1": { count: 3, at: 10 }, "b/2": { count: 5, at: 1 }, "c/3": { count: 3, at: 99 }, "d/4": { count: 1, at: 100 } };
	assert.deepEqual(rankModelPicks(picks, 5), ["b/2", "c/3", "a/1", "d/4"]);
	assert.deepEqual(rankModelPicks(picks, 2), ["b/2", "c/3"]);
});

test("超过上限时淘汰最久没选的", () => {
	for (let i = 0; i < MAX_PICKS + 5; i++) recordModelPick("bulk", `m${i}`, 10_000 + i);
	recordModelPick("hot", "x", 10_000 + MAX_PICKS + 10);
	recordModelPick("hot", "x", 10_000 + MAX_PICKS + 11);
	const picks = getModelPicks();
	assert.ok(Object.keys(picks).length <= MAX_PICKS, `记录数 ${Object.keys(picks).length} 应不超过 ${MAX_PICKS}`);
	assert.ok(!picks["bulk/m0"], "最久没选的应被淘汰");
	assert.ok(picks[`bulk/m${MAX_PICKS + 4}`], "最近选的应保留");
	assert.equal(picks["hot/x"].count, 2, "常选模型保留计数");
});
