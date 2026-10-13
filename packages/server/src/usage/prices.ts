/**
 * 价格：用量记录时按“当时的价格”算费用并把价格快照存进记录（以后价格变了不影响旧账）。
 * 价格来源优先级：
 *  1) 用户自定义（设置 › 用量 › 价格）：按模型或整个服务填单价（美元或人民币），或“按官方价打折”（中转常用）；
 *  2) Pi 内置模型自带的价格（非 0 时）；
 *  3) models.dev 快照：同服务商同模型 → 按模型名在官方服务商里找 → 任意托管商；
 *  4) 都没有 = 未知：费用记 NULL，界面显示「—」，补了价格后可以重算。
 * 单位一律 美元 / 百万 token；人民币只在显示时按用户设的汇率换算（默认 7.1）。
 */
import { getSetting } from "../db.ts";
import { modelDb } from "../model-db.ts";
import { baseId, type DbEntry, normId } from "../pi-adapter/model-limits.ts";

export interface Rates {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** 推理输出单价（少数模型单独计价；推理 token 是输出的一部分） */
	reasoning?: number;
}
export interface Price extends Rates {
	/** 按整次请求的输入 token 数分档（超过 above 的整次请求都按这档） */
	tiers?: (Partial<Rates> & { above: number })[];
}
export type PriceSource = "custom" | "discount" | "pi" | "models.dev" | "unknown";
export interface ResolvedPrice {
	price: Price | null;
	source: PriceSource;
	/** 给人看的来源说明 */
	note: string;
}
export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
}
export interface CostBreakdown {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	/** 读缓存比按原价输入省下的钱 */
	saved: number;
}

export type PriceOverride =
	| { mode: "discount"; discount: number }
	| { mode: "price"; currency: "USD" | "CNY"; input: number; output: number; cacheRead?: number; cacheWrite?: number };
export const getOverrides = () => getSetting<Record<string, PriceOverride>>("usagePrices", {});
export interface Fx {
	rate: number;
	display: "CNY" | "USD";
}
export const getFx = (): Fx => {
	const f = getSetting<Partial<Fx>>("usageFx", {});
	return { rate: typeof f.rate === "number" && f.rate > 0 ? f.rate : 7.1, display: f.display === "USD" ? "USD" : "CNY" };
};

const OFFICIAL = ["deepseek", "zai", "zhipuai", "moonshotai", "alibaba", "minimax", "openai", "anthropic", "google", "xai", "mistral", "volcengine"];
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** models.dev 精简价格数组 → Price */
export function fromDbCost(c: (number | null)[] | undefined): Price | null {
	if (!c) return null;
	const [i, o, cr, cw, r, oi, oo, ocr] = c;
	if (i == null && o == null) return null;
	const p: Price = { input: i ?? 0, output: o ?? 0 };
	if (cr != null) p.cacheRead = cr;
	if (cw != null) p.cacheWrite = cw;
	if (r != null) p.reasoning = r;
	if (oi != null || oo != null) p.tiers = [{ above: 200_000, ...(oi != null ? { input: oi } : {}), ...(oo != null ? { output: oo } : {}), ...(ocr != null ? { cacheRead: ocr } : {}) }];
	return p;
}

/** 在 models.dev 里找参考价（纯函数，db 可注入） */
export function lookupDbPrice(provider: string, id: string, db: DbEntry[] = modelDb()): { price: Price; from: string } | null {
	const withCost = (xs: DbEntry[]) => xs.filter((x) => x.cost && fromDbCost(x.cost));
	const exact = withCost(db.filter((x) => x.provider === provider && x.id === id));
	if (exact[0]) return { price: fromDbCost(exact[0].cost)!, from: provider };
	const n = normId(id);
	let hits = withCost(db.filter((x) => normId(x.id) === n));
	if (!hits.length) hits = withCost(db.filter((x) => baseId(normId(x.id)) === baseId(n)));
	if (!hits.length) return null;
	const off = hits.find((x) => x.provider && OFFICIAL.includes(x.provider));
	const h = off ?? hits[0];
	return { price: fromDbCost(h.cost)!, from: h.provider ?? "" };
}

type PiCost = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; tiers?: { inputTokensAbove: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }[] } | undefined;
export function fromPiCost(c: PiCost): Price | null {
	if (!c || !(num(c.input) || num(c.output))) return null;
	const p: Price = { input: c.input ?? 0, output: c.output ?? 0 };
	if (num(c.cacheRead) !== undefined) p.cacheRead = c.cacheRead;
	if (num(c.cacheWrite) !== undefined) p.cacheWrite = c.cacheWrite;
	if (c.tiers?.length) p.tiers = c.tiers.map((t) => ({ above: t.inputTokensAbove, input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite }));
	return p;
}

const scale = (p: Price, k: number): Price => ({
	input: p.input * k,
	output: p.output * k,
	...(p.cacheRead != null ? { cacheRead: p.cacheRead * k } : {}),
	...(p.cacheWrite != null ? { cacheWrite: p.cacheWrite * k } : {}),
	...(p.reasoning != null ? { reasoning: p.reasoning * k } : {}),
	...(p.tiers ? { tiers: p.tiers.map((t) => ({ above: t.above, ...Object.fromEntries(Object.entries(t).filter(([key]) => key !== "above").map(([key, v]) => [key, (v as number) * k])) })) } : {}),
});

/** 解析价格（纯函数版：参考价和自定义设置都由调用方给） */
export function resolvePriceFrom(o: { provider: string; id: string; piCost?: PiCost; overrides: Record<string, PriceOverride>; fx: Fx; db?: DbEntry[] }): ResolvedPrice {
	const ov = o.overrides[`${o.provider}/${o.id}`] ?? o.overrides[`${o.provider}/*`];
	if (ov?.mode === "price") {
		const k = ov.currency === "CNY" ? 1 / o.fx.rate : 1;
		const p: Price = { input: ov.input * k, output: ov.output * k };
		if (num(ov.cacheRead) !== undefined) p.cacheRead = ov.cacheRead! * k;
		if (num(ov.cacheWrite) !== undefined) p.cacheWrite = ov.cacheWrite! * k;
		return { price: p, source: "custom", note: "自定义价格" };
	}
	const pi = fromPiCost(o.piCost);
	const ref = pi ? { price: pi, from: "pi" } : lookupDbPrice(o.provider, o.id, o.db);
	if (ov?.mode === "discount" && ref) {
		return { price: scale(ref.price, ov.discount), source: "discount", note: `官方价 × ${ov.discount}` };
	}
	if (!ref) return { price: null, source: "unknown", note: "价格未知" };
	return pi ? { price: pi, source: "pi", note: "内置价格" } : { price: ref.price, source: "models.dev", note: ref.from === o.provider ? "models.dev" : `models.dev（参考 ${ref.from} 的价格）` };
}

/** 按价格算费用（美元）。tiers：整次请求的输入（含缓存）超过阈值时整次按该档 */
export function computeCost(u: TokenUsage, price: Price): CostBreakdown {
	const totalIn = u.input + u.cacheRead + u.cacheWrite;
	let r: Rates = { ...price };
	const tier = (price.tiers ?? []).filter((t) => totalIn > t.above).sort((a, b) => b.above - a.above)[0];
	if (tier) r = { ...r, ...Object.fromEntries(Object.entries(tier).filter(([k, v]) => k !== "above" && v != null)) };
	const cr = r.cacheRead ?? r.input;
	const cw = r.cacheWrite ?? r.input;
	const reasoning = Math.min(u.reasoning ?? 0, u.output);
	const outCost = r.reasoning != null && reasoning ? (u.output - reasoning) * r.output + reasoning * r.reasoning : u.output * r.output;
	const c = { input: (u.input * r.input) / 1e6, output: outCost / 1e6, cacheRead: (u.cacheRead * cr) / 1e6, cacheWrite: (u.cacheWrite * cw) / 1e6 };
	return { ...c, total: c.input + c.output + c.cacheRead + c.cacheWrite, saved: Math.max(0, (u.cacheRead * (r.input - cr)) / 1e6) };
}
