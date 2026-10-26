/**
 * 用量系统（DESIGN §「用量与费用」）：每次模型调用记一行（usage_calls），费用在发生时按当时价格算好并存价格快照。
 *  - 明细保留 90 天，更早的按 天 × 助理 × 群 × 服务 × 模型 汇总进 usage_daily 再删明细（housekeeping 调 rollupUsage）；
 *  - 价格未知：cost 为 NULL（界面「—」），用户补了价格后可以 recomputeUnknown() 重算；
 *  - 旧的 usage 表（按天汇总，只有 input/output/cost）保留不动，不再写入。
 */
import { db, uid } from "../db.ts";
import { models } from "../models.ts";
import { CLI_PROVIDER_IDS } from "../pi-adapter/cli-models/provider.ts";
import { computeCost, getFx, getOverrides, type Price, type PriceSource, resolvePriceFrom, type TokenUsage } from "./prices.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS usage_calls (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, day TEXT NOT NULL,
  agent_id TEXT NOT NULL, room_id TEXT, conversation_id TEXT, message_id TEXT,
  provider TEXT NOT NULL, model TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0,
  cost REAL, saved REAL, price TEXT, price_source TEXT NOT NULL DEFAULT 'unknown');
CREATE INDEX IF NOT EXISTS usage_calls_ts ON usage_calls(ts);
CREATE INDEX IF NOT EXISTS usage_calls_room ON usage_calls(room_id, ts);
CREATE INDEX IF NOT EXISTS usage_calls_msg ON usage_calls(message_id);
CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL, agent_id TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL, model TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0, saved REAL NOT NULL DEFAULT 0, unknown_calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, agent_id, room_id, provider, model));
`);

if (!(db.prepare("PRAGMA table_info(usage_calls)").all() as { name: string }[]).some((c) => c.name === "subagent_id")) db.exec("ALTER TABLE usage_calls ADD COLUMN subagent_id TEXT");

export const DETAIL_DAYS = 90;
const DAY = 86_400_000;
export const dayOf = (ts: number) => new Date(ts).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });

export function resolvePrice(provider: string, id: string) {
	const m = models?.getModel(provider, id) as { cost?: never } | undefined;
	// 本地测试用的 mock 服务不去 models.dev 按名字找（“echo”会撞上别家的同名模型）；本机命令行渠道同理（见 CLI_PROVIDER_IDS）
	return resolvePriceFrom({ provider, id, piCost: m?.cost, overrides: getOverrides(), fx: getFx(), ...(provider === "mock" || CLI_PROVIDER_IDS.includes(provider) ? { db: [] } : {}) });
}

export interface RecordInput extends TokenUsage {
	agentId: string;
	provider: string;
	model: string;
	conversationId?: string | null;
	messageId?: string | null;
	subagentId?: string | null;
	roomId?: string | null;
	ts?: number;
}
export interface UsageSummaryRow {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	cost: number | null;
	saved: number | null;
	priceSource: PriceSource;
}

/** 记一次调用，返回给消息 meta 用的摘要 */
export function recordUsage(r: RecordInput): UsageSummaryRow {
	const ts = r.ts ?? Date.now();
	const u: TokenUsage = { input: r.input || 0, output: r.output || 0, cacheRead: r.cacheRead || 0, cacheWrite: r.cacheWrite || 0, reasoning: r.reasoning || 0 };
	const roomId = r.roomId !== undefined ? r.roomId : r.conversationId ? roomOfConversation(r.agentId, r.conversationId) : null;
	const rp = resolvePrice(r.provider, r.model);
	const c = rp.price ? computeCost(u, rp.price) : null;
	db.prepare(
		"INSERT INTO usage_calls(id, ts, day, agent_id, room_id, conversation_id, message_id, provider, model, input, output, cache_read, cache_write, reasoning, cost, saved, price, price_source, subagent_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(uid("u"), ts, dayOf(ts), r.agentId, roomId ?? null, r.conversationId ?? null, r.messageId ?? null, r.provider, r.model, u.input, u.output, u.cacheRead, u.cacheWrite, u.reasoning ?? 0, c ? c.total : null, c ? c.saved : null, rp.price ? JSON.stringify(rp.price) : null, rp.source, r.subagentId ?? null);
	return { ...u, reasoning: u.reasoning ?? 0, cost: c ? c.total : null, saved: c ? c.saved : null, priceSource: rp.source };
}

function roomOfConversation(agentId: string, conversationId: string): string | null {
	try {
		const r = db.prepare("SELECT room_id FROM room_members WHERE agent_id = ? AND conversation_id = ?").get(agentId, conversationId) as { room_id: string } | undefined;
		return r?.room_id ?? null;
	} catch {
		return null;
	}
}

/** 价格未知的记录按现在的价格重算（用户补了价格后） */
export function recomputeUnknown(): number {
	const rows = db.prepare("SELECT id, provider, model, input, output, cache_read, cache_write, reasoning FROM usage_calls WHERE cost IS NULL").all() as { id: string; provider: string; model: string; input: number; output: number; cache_read: number; cache_write: number; reasoning: number }[];
	let n = 0;
	const cache = new Map<string, ReturnType<typeof resolvePrice>>();
	const upd = db.prepare("UPDATE usage_calls SET cost = ?, saved = ?, price = ?, price_source = ? WHERE id = ?");
	for (const r of rows) {
		const k = `${r.provider}/${r.model}`;
		if (!cache.has(k)) cache.set(k, resolvePrice(r.provider, r.model));
		const rp = cache.get(k)!;
		if (!rp.price) continue;
		const c = computeCost({ input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_write, reasoning: r.reasoning }, rp.price);
		upd.run(c.total, c.saved, JSON.stringify(rp.price), rp.source, r.id);
		n++;
	}
	return n;
}

/** 90 天前的明细汇总进 usage_daily 再删 */
export function rollupUsage(nowTs = Date.now(), keepDays = DETAIL_DAYS): number {
	const cut = nowTs - keepDays * DAY;
	const tx = db.prepare("SELECT COUNT(*) n FROM usage_calls WHERE ts < ?").get(cut) as { n: number };
	if (!tx.n) return 0;
	db.exec("BEGIN");
	try {
		db.prepare(
			`INSERT INTO usage_daily(day, agent_id, room_id, provider, model, calls, input, output, cache_read, cache_write, reasoning, cost, saved, unknown_calls)
			 SELECT day, agent_id, COALESCE(room_id, ''), provider, model, COUNT(*), SUM(input), SUM(output), SUM(cache_read), SUM(cache_write), SUM(reasoning), COALESCE(SUM(cost), 0), COALESCE(SUM(saved), 0), SUM(cost IS NULL)
			 FROM usage_calls WHERE ts < ? GROUP BY day, agent_id, COALESCE(room_id, ''), provider, model
			 ON CONFLICT(day, agent_id, room_id, provider, model) DO UPDATE SET calls = calls + excluded.calls, input = input + excluded.input, output = output + excluded.output,
			   cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write, reasoning = reasoning + excluded.reasoning,
			   cost = cost + excluded.cost, saved = saved + excluded.saved, unknown_calls = unknown_calls + excluded.unknown_calls`,
		).run(cut);
		db.prepare("DELETE FROM usage_calls WHERE ts < ?").run(cut);
		db.exec("COMMIT");
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}
	return tx.n;
}

// ---------------------------------------------------------------- 查询
export type Range = "today" | "7d" | "30d" | "90d" | "all";
const fromDay = (range: Range, nowTs: number) => {
	if (range === "all") return "0000-00-00";
	const n = { today: 0, "7d": 6, "30d": 29, "90d": 89 }[range];
	return dayOf(nowTs - n * DAY);
};

/** 明细 + 汇总合在一起（同一组列） */
const UNION = (where: string) => `
	SELECT day, agent_id, COALESCE(room_id, '') room_id, provider, model, 1 calls, input, output, cache_read, cache_write, reasoning, COALESCE(cost, 0) cost, COALESCE(saved, 0) saved, (cost IS NULL) unknown_calls FROM usage_calls WHERE ${where}
	UNION ALL
	SELECT day, agent_id, room_id, provider, model, calls, input, output, cache_read, cache_write, reasoning, cost, saved, unknown_calls FROM usage_daily WHERE ${where}`;
const SUMS = "SUM(calls) calls, SUM(input) input, SUM(output) output, SUM(cache_read) cacheRead, SUM(cache_write) cacheWrite, SUM(reasoning) reasoning, SUM(cost) cost, SUM(saved) saved, SUM(unknown_calls) unknownCalls";

export interface Totals {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	cost: number;
	saved: number;
	unknownCalls: number;
	/** 缓存命中率：读缓存 /（新输入 + 读缓存 + 写缓存） */
	hitRate: number | null;
}
const fin = (r: Partial<Totals> | undefined): Totals => {
	const t = { calls: r?.calls ?? 0, input: r?.input ?? 0, output: r?.output ?? 0, cacheRead: r?.cacheRead ?? 0, cacheWrite: r?.cacheWrite ?? 0, reasoning: r?.reasoning ?? 0, cost: r?.cost ?? 0, saved: r?.saved ?? 0, unknownCalls: r?.unknownCalls ?? 0 };
	const den = t.input + t.cacheRead + t.cacheWrite;
	return { ...t, hitRate: den ? t.cacheRead / den : null };
};

export function usageSummary(o: { range?: Range; roomId?: string; agentId?: string; now?: number } = {}) {
	const nowTs = o.now ?? Date.now();
	const range = o.range ?? "7d";
	const conds = ["day >= ?"];
	const args: (string | number)[] = [fromDay(range, nowTs)];
	if (o.roomId) (conds.push("COALESCE(room_id, '') = ?"), args.push(o.roomId));
	if (o.agentId) (conds.push("agent_id = ?"), args.push(o.agentId));
	const w = conds.join(" AND ");
	const q = (sql: string) => db.prepare(sql).all(...args, ...args) as Record<string, unknown>[];
	const totals = fin(q(`SELECT ${SUMS} FROM (${UNION(w)})`)[0] as Partial<Totals>);
	const group = (cols: string) => q(`SELECT ${cols}, ${SUMS} FROM (${UNION(w)}) GROUP BY ${cols} ORDER BY cost DESC, input + output DESC`).map((r) => ({ ...r, ...fin(r as Partial<Totals>) }) as Totals & Record<string, string | number | null>);
	return {
		range,
		from: fromDay(range, nowTs),
		totals,
		daily: group("day").sort((a, b) => String(a.day).localeCompare(String(b.day))),
		byModel: group("provider, model"),
		byAgent: group("agent_id"),
		byRoom: group("room_id").filter((r) => r.room_id),
		fx: getFx(),
		hasAny: totals.calls > 0,
	};
}

export const usageSettings = () => ({ fx: getFx(), prices: getOverrides(), detailDays: DETAIL_DAYS });
export type { Price };
