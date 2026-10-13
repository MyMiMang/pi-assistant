/** 用量与费用：价格解析（自定义 / 打折 / models.dev / 未知）、费用计算（缓存、推理、超 200K 分档）、记录、汇总、90 天滚动；组队选模型打分 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
const { computeCost, fromDbCost, lookupDbPrice, resolvePriceFrom } = await import("../src/usage/prices.ts");
const { buildProfile, defaultStrengths, inferNeeds, pickModel, priceTier, scoreModels } = await import("../src/model-profile.ts");
const { trimModelsDev } = await import("../src/model-db.ts");
const { indexModelDb } = await import("../src/pi-adapter/model-limits.ts");

const fx = { rate: 7, display: "CNY" as const };
const db = indexModelDb(
	trimModelsDev({
		anthropic: { models: { "claude-sonnet-4-5": { limit: { context: 200000, output: 64000 }, modalities: { input: ["text", "image"] }, reasoning: true, tool_call: true, cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } } },
		google: { models: { "gemini-3.1-pro": { limit: { context: 1_000_000, output: 64000 }, tool_call: true, cost: { input: 2, output: 12, cache_read: 0.2, context_over_200k: { input: 4, output: 18, cache_read: 0.4 } } } } },
		hoster: { models: { "vendor/claude-sonnet-4-5": { limit: { context: 200000, output: 1 }, cost: { input: 9, output: 9 } } } },
	}).providers as never,
);

test("快照：标记位和价格数组", () => {
	const t = trimModelsDev({ a: { models: { m: { limit: { context: 10, output: 5 }, reasoning: true, tool_call: true, cost: { input: 1, output: 2, cache_read: 0.1 } }, plain: { limit: { context: 10, output: 5 } } } } });
	assert.deepEqual(t.providers.a.m, [10, 5, 6, [1, 2, 0.1]]);
	assert.deepEqual(t.providers.a.plain, [10, 5]);
	const e = indexModelDb(t.providers as never)[0];
	assert.equal(e.reasoning, true);
	assert.equal(e.toolCall, true);
	assert.equal(e.vision, undefined);
	assert.deepEqual(fromDbCost([1, 2, null, null, null, 4, 5]), { input: 1, output: 2, tiers: [{ above: 200_000, input: 4, output: 5 }] });
});

test("价格查找：同服务商 → 官方服务商按模型名 → 未知", () => {
	assert.equal(lookupDbPrice("anthropic", "claude-sonnet-4-5", db)!.price.input, 3);
	// 中转里叫 claude-sonnet-4-5 的模型参考官方价，不用托管商的
	const r = lookupDbPrice("custom-relay", "claude-sonnet-4-5", db)!;
	assert.equal(r.from, "anthropic");
	assert.equal(lookupDbPrice("x", "no-such-model", db), null);
});

test("价格解析：自定义人民币单价换算美元；打折；Pi 内置价优先；未知", () => {
	const base = { overrides: {}, fx, db };
	const cny = resolvePriceFrom({ ...base, provider: "r", id: "claude-sonnet-4-5", overrides: { "r/*": { mode: "price", currency: "CNY", input: 7, output: 14 } } });
	assert.equal(cny.source, "custom");
	assert.equal(cny.price!.input, 1);
	assert.equal(cny.price!.output, 2);
	const disc = resolvePriceFrom({ ...base, provider: "r", id: "claude-sonnet-4-5", overrides: { "r/claude-sonnet-4-5": { mode: "discount", discount: 0.5 } } });
	assert.equal(disc.source, "discount");
	assert.equal(disc.price!.input, 1.5);
	assert.equal(disc.price!.cacheRead, 0.15);
	const pi = resolvePriceFrom({ ...base, provider: "anthropic", id: "claude-sonnet-4-5", piCost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
	assert.equal(pi.source, "pi");
	const zeroPi = resolvePriceFrom({ ...base, provider: "anthropic", id: "claude-sonnet-4-5", piCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
	assert.equal(zeroPi.source, "models.dev", "Pi 价格全是 0（自定义模型）时不当作免费");
	assert.equal(resolvePriceFrom({ ...base, provider: "x", id: "mystery" }).source, "unknown");
});

test("费用：缓存读写、推理单价、超 200K 整次按高档", () => {
	const p = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
	const c = computeCost({ input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 100_000 }, p);
	assert.ok(Math.abs(c.total - (3 + 1.5 + 0.6 + 0.375)) < 1e-9);
	assert.ok(Math.abs(c.saved - 2 * (3 - 0.3)) < 1e-9);
	// 没有缓存单价：按输入价算，不算省钱
	assert.equal(computeCost({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }, { input: 2, output: 8 }).saved, 0);
	// 推理单价
	const r = computeCost({ input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0, reasoning: 400_000 }, { input: 1, output: 2, reasoning: 5 });
	assert.ok(Math.abs(r.total - (0.6 * 2 + 0.4 * 5)) < 1e-9);
	const tiered = fromDbCost([2, 12, 0.2, null, null, 4, 18, 0.4])!;
	assert.equal(computeCost({ input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0 }, tiered).total, 0.2);
	assert.ok(Math.abs(computeCost({ input: 150_000, output: 1_000_000, cacheRead: 100_000, cacheWrite: 0 }, tiered).total - (0.6 + 18 + 0.04)) < 1e-9);
});

test("记录用量 → 汇总（今天 / 按模型 / 群）→ 未知价补上后重算 → 90 天滚动汇总", async () => {
	const { db: sql, setSetting } = await import("../src/db.ts");
	const u = await import("../src/usage/index.ts");
	const now = Date.now();
	const a = u.recordUsage({ agentId: "ag1", provider: "anthropic", model: "claude-sonnet-4-5", input: 1000, output: 500, cacheRead: 9000, cacheWrite: 0, roomId: "room1" });
	assert.equal(a.priceSource, "models.dev");
	assert.ok(a.cost! > 0);
	const b = u.recordUsage({ agentId: "ag1", provider: "relay", model: "mystery-1", input: 100, output: 100, cacheRead: 0, cacheWrite: 0, roomId: null });
	assert.equal(b.cost, null);
	assert.equal(b.priceSource, "unknown");
	let s = u.usageSummary({ range: "today" });
	assert.equal(s.totals.calls, 2);
	assert.equal(s.totals.unknownCalls, 1);
	assert.ok(Math.abs(s.totals.hitRate! - 9000 / 10100) < 1e-9);
	assert.equal(s.byRoom.length, 1);
	assert.equal(u.usageSummary({ range: "today", roomId: "room1" }).totals.calls, 1);
	setSetting("usagePrices", { "relay/*": { mode: "price", currency: "USD", input: 1, output: 1 } });
	assert.equal(u.recomputeUnknown(), 1);
	s = u.usageSummary({ range: "today" });
	assert.equal(s.totals.unknownCalls, 0);
	// 100 天前的一条：滚进按天汇总，明细删掉，汇总里还在
	u.recordUsage({ agentId: "ag2", provider: "anthropic", model: "claude-sonnet-4-5", input: 10, output: 10, cacheRead: 0, cacheWrite: 0, ts: now - 100 * 86_400_000, roomId: null });
	assert.equal(u.rollupUsage(now), 1);
	assert.equal((sql.prepare("SELECT COUNT(*) n FROM usage_calls").get() as { n: number }).n, 2);
	assert.equal(u.usageSummary({ range: "all" }).totals.calls, 3);
	assert.equal(u.usageSummary({ range: "30d" }).totals.calls, 2);
	assert.equal(u.rollupUsage(now), 0);
});

test("组队选模型：按需求打分、硬条件排除、价格扣分、全不合格退回默认", () => {
	const mk = (provider: string, id: string, f: object) => buildProfile({ provider, id, ...f });
	const ps = [
		mk("anthropic", "claude-sonnet-4-5", { vision: true, reasoning: true, toolCall: true, price: { input: 3, output: 15 } }),
		mk("deepseek", "deepseek-v4-flash", { toolCall: true, price: { input: 0.1, output: 0.4 } }),
		mk("x", "no-tools-model", { toolCall: false, price: { input: 0.01, output: 0.01 } }),
	];
	assert.ok(defaultStrengths({ provider: "deepseek", id: "deepseek-v4-flash", price: { input: 0.1, output: 0.4 } }).includes("cheap"));
	assert.equal(priceTier(undefined), "unknown");
	assert.deepEqual(inferNeeds("负责写前端代码和单元测试"), ["coding"]);
	assert.ok(inferNeeds("写小红书文案").includes("writing_zh"));
	// 看图：只有 claude 能看图
	assert.equal(pickModel({ needs: ["vision"] }, ps).model!.id, "claude-sonnet-4-5");
	// 中文 + 便宜 → deepseek flash
	const r = scoreModels({ needs: ["writing_zh", "cheap"] }, ps);
	assert.equal(r[0].id, "deepseek-v4-flash");
	assert.match(r[0].reason, /中文写作/);
	assert.match(r[0].reason, /便宜/);
	// 不支持工具调用的排在最后并说明
	assert.equal(r[r.length - 1].id, "no-tools-model");
	assert.match(r[r.length - 1].reason, /不支持调用工具/);
	// 用户改了擅长标签：覆盖默认
	const edited = buildProfile({ provider: "x", id: "no-tools-model", toolCall: true }, { "x/no-tools-model": ["vision"] });
	assert.deepEqual(edited.tags, ["vision"]);
	assert.equal(edited.userEdited, true);
	// 全不合格：退回默认模型
	const fb = pickModel({ needs: ["vision"] }, [ps[1]], { provider: "deepseek", id: "deepseek-v4-flash" });
	assert.equal(fb.model!.id, "deepseek-v4-flash");
	assert.match(fb.reason, /默认模型/);
	assert.equal(pickModel({ needs: [] }, [], null).model, null);
});
