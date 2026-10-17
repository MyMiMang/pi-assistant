/** 用量 / 价格 / 模型擅长 的 HTTP 接口（http.ts 挂载） */
import type { Hono } from "hono";
import { bus } from "../bus.ts";
import { setSetting } from "../db.ts";
import { STRENGTH_LABEL, STRENGTHS, TIER_LABEL, type Strength } from "../model-profile.ts";
import { providerNames, models } from "../models.ts";
import { cleanNeeds, configuredModels, getStrengthOverrides, modelProfiles, rankModels } from "../rooms/model-pick.ts";
import { listAgents } from "../runtime.ts";
import { db } from "../db.ts";
import { getFx, getOverrides, type PriceOverride } from "./prices.ts";
import { type Range, recomputeUnknown, resolvePrice, usageSummary } from "./index.ts";

const RANGES: Range[] = ["today", "7d", "30d", "90d", "all"];
const pos = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

export function cleanOverride(v: unknown): PriceOverride | null {
	const o = v as Record<string, unknown> | null;
	if (!o || typeof o !== "object") return null;
	if (o.mode === "discount") {
		const d = pos(o.discount);
		return d !== undefined && d <= 10 ? { mode: "discount", discount: d } : null;
	}
	if (o.mode === "price") {
		const input = pos(o.input);
		const output = pos(o.output);
		if (input === undefined || output === undefined) return null;
		return { mode: "price", currency: o.currency === "USD" ? "USD" : "CNY", input, output, ...(pos(o.cacheRead) !== undefined ? { cacheRead: pos(o.cacheRead) } : {}), ...(pos(o.cacheWrite) !== undefined ? { cacheWrite: pos(o.cacheWrite) } : {}) };
	}
	return null;
}

// biome-ignore lint/suspicious/noExplicitAny: Hono 的泛型环境在 http.ts 里
export function mountUsageRoutes(app: Hono<any>) {
	// ---- 建群：按角色给模型排序（卡片下拉框用）
	app.get("/api/proposals/models", (c) => {
		const names = providerNames();
		const needs = cleanNeeds((c.req.query("needs") ?? "").split(",").filter(Boolean));
		const ranked = rankModels({ needs, manager: c.req.query("manager") === "1" });
		const byKey = new Map(configuredModels().map((m) => [`${m.provider}/${m.id}`, m]));
		return c.json(
			ranked.map((r) => {
				const m = byKey.get(`${r.provider}/${r.id}`) as { name?: string; reasoning?: boolean } | undefined;
				// thinking 必须是这个模型真实的可用档位（与 /api/models 同一份 Pi 元数据），界面不自己造 7 档
				return { ...r, name: m?.name, reasoning: m?.reasoning, thinking: models.supportedThinking(r.provider, r.id), providerName: names.get(r.provider) ?? r.provider, tierLabel: TIER_LABEL[r.tier] };
			}),
		);
	});

	// ---- 模型擅长（设置 › 模型）
	app.get("/api/model-strengths", (c) => {
		const names = providerNames();
		return c.json({
			labels: STRENGTHS.map((k) => ({ key: k, label: STRENGTH_LABEL[k] })),
			models: modelProfiles().map((p) => ({ ...p, providerName: names.get(p.provider) ?? p.provider, tierLabel: TIER_LABEL[p.tier] })),
		});
	});
	app.put("/api/model-strengths", async (c) => {
		const b = await c.req.json<{ provider?: string; id?: string; tags?: string[] | null }>().catch(() => ({}) as { provider?: string; id?: string; tags?: null });
		if (!b.provider || !b.id) return c.json({ error: "缺少模型" }, 400);
		const all = { ...getStrengthOverrides() };
		const key = `${b.provider}/${b.id}`;
		if (b.tags === null || b.tags === undefined) delete all[key];
		else all[key] = cleanNeeds(b.tags) as Strength[];
		setSetting("modelStrengths", all);
		return c.json({ ok: true });
	});

	// ---- 用量
	app.get("/api/usage/summary", (c) => {
		const r = c.req.query("range") as Range;
		const s = usageSummary({ range: RANGES.includes(r) ? r : "7d", roomId: c.req.query("room") || undefined, agentId: c.req.query("agent") || undefined });
		const names = providerNames();
		const agents = new Map(listAgents().map((a) => [a.id, a.name]));
		let rooms = new Map<string, string>();
		try {
			rooms = new Map((db.prepare("SELECT id, name FROM rooms").all() as { id: string; name: string }[]).map((x) => [x.id, x.name]));
		} catch {}
		return c.json({
			...s,
			byModel: s.byModel.map((x) => ({ ...x, providerName: names.get(String(x.provider)) ?? x.provider })),
			byAgent: s.byAgent.map((x) => ({ ...x, name: agents.get(String(x.agent_id)) ?? "已删除的助理" })),
			byRoom: s.byRoom.map((x) => ({ ...x, name: rooms.get(String(x.room_id)) ?? "已删除的群" })),
		});
	});
	app.get("/api/usage/settings", (c) => {
		const names = providerNames();
		const models = configuredModels().map((m) => {
			const rp = resolvePrice(m.provider, m.id);
			return { provider: m.provider, providerName: names.get(m.provider) ?? m.provider, id: m.id, name: (m as { name?: string }).name, price: rp.price, source: rp.source, note: rp.note };
		});
		return c.json({ fx: getFx(), prices: getOverrides(), models });
	});
	app.put("/api/usage/settings", async (c) => {
		const b = await c.req.json<{ fx?: { rate?: number; display?: string }; price?: { key: string; value: unknown } }>().catch(() => ({}) as Record<string, never>);
		if (b.fx) {
			const cur = getFx();
			const rate = pos(b.fx.rate);
			setSetting("usageFx", { rate: rate && rate > 0 && rate < 100 ? rate : cur.rate, display: b.fx.display === "USD" ? "USD" : b.fx.display === "CNY" ? "CNY" : cur.display });
		}
		if (b.price && typeof b.price.key === "string" && /^[^/]+\/.+$/.test(b.price.key)) {
			const all = { ...getOverrides() };
			const v = cleanOverride(b.price.value);
			if (v) all[b.price.key] = v;
			else delete all[b.price.key];
			setSetting("usagePrices", all);
		}
		const recomputed = recomputeUnknown();
		bus.emit({ type: "settings.changed" });
		return c.json({ ok: true, recomputed });
	});
}
