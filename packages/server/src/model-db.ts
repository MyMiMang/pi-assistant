/**
 * 模型参数库（上下文长度 / 最大输出）：数据来自 models.dev（MIT 许可，https://models.dev），
 * 安装包里带一份精简快照（packages/server/model-db.json，由 scripts/gen-model-db.mjs 生成），
 * 运行时每周联网刷新一次缓存到数据目录（走统一的下载管理，设置 › 下载与组件可见），离线时用快照。
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { fetchWithProgress, registerDownload, trackDownload } from "./downloads.ts";
import { type DbEntry, indexModelDb } from "./pi-adapter/model-limits.ts";

const URL_ = "https://models.dev/api.json";
const WEEK = 7 * 24 * 3600_000;
const SNAPSHOT = join(import.meta.dirname, "..", "model-db.json");
const cacheFile = () => join(config.dataDir, "model-db.v3.json"); // v3：多了推理 / 工具调用标记和价格

/**
 * 精简条目：[上下文, 最大输出, 标记?, 价格?]
 *  标记（位）：1 识图、2 推理、4 工具调用（旧快照里第三位是 1 = 识图，兼容）
 *  价格：美元 / 百万 token [输入, 输出, 读缓存, 写缓存, 推理输出, 超 200K 输入, 超 200K 输出, 超 200K 读缓存]，缺的项为 null，末尾的 null 省略
 */
export type TrimmedEntry = (number | (number | null)[])[];
type Trimmed = { generatedAt?: string; providers: Record<string, Record<string, TrimmedEntry>> };
type RawCost = { input?: number; output?: number; cache_read?: number; cache_write?: number; reasoning?: number; context_over_200k?: { input?: number; output?: number; cache_read?: number } };
type RawModel = { id?: string; limit?: { context?: number; output?: number }; modalities?: { input?: string[] }; reasoning?: boolean; tool_call?: boolean; cost?: RawCost };

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v * 1e4) / 1e4 : null);
export function trimCost(c: RawCost | undefined): (number | null)[] | null {
	if (!c) return null;
	const o = c.context_over_200k;
	const arr = [n(c.input), n(c.output), n(c.cache_read), n(c.cache_write), n(c.reasoning), n(o?.input), n(o?.output), n(o?.cache_read)];
	while (arr.length && arr[arr.length - 1] === null) arr.pop();
	return arr.length && (arr[0] !== null || arr[1] !== null) ? arr : null;
}

/** models.dev 原始数据 → 精简格式（与 scripts/gen-model-db.mjs 相同） */
export function trimModelsDev(j: Record<string, { models?: Record<string, RawModel> }>): Trimmed {
	const providers: Trimmed["providers"] = {};
	for (const [pid, p] of Object.entries(j)) {
		const ms: Record<string, TrimmedEntry> = {};
		for (const [mid, m] of Object.entries(p?.models ?? {})) {
			const c = m?.limit?.context;
			const o = m?.limit?.output;
			if (typeof c === "number" && c > 0) {
				const out = typeof o === "number" && o > 0 ? o : 0;
				const flags = (m?.modalities?.input?.includes("image") ? 1 : 0) | (m?.reasoning ? 2 : 0) | (m?.tool_call ? 4 : 0);
				const cost = trimCost(m?.cost);
				const e: TrimmedEntry = [c, out];
				if (flags || cost) e.push(flags);
				if (cost) e.push(cost);
				ms[m.id ?? mid] = e;
			}
		}
		if (Object.keys(ms).length) providers[pid] = ms;
	}
	return { generatedAt: new Date().toISOString(), providers };
}

let entries: DbEntry[] | null = null;
function load(): DbEntry[] {
	if (entries) return entries;
	let t: Trimmed | null = null;
	for (const f of [cacheFile(), SNAPSHOT]) {
		try {
			if (existsSync(f)) {
				t = JSON.parse(readFileSync(f, "utf8"));
				if (t?.providers) break;
			}
		} catch {
			/* 坏的缓存：用下一个 */
		}
	}
	entries = indexModelDb((t?.providers ?? {}) as never);
	return entries;
}
export const modelDb = () => load();

let running: Promise<void> | null = null;
/** 刷新（缓存超过一周或 force）；失败不影响使用快照 */
export function refreshModelDb(force = false): Promise<void> {
	try {
		if (!force && existsSync(cacheFile()) && Date.now() - statSync(cacheFile()).mtimeMs < WEEK) return Promise.resolve();
	} catch {
		/* 继续刷新 */
	}
	running ??= trackDownload("model-db", async (p) => {
		const buf = await fetchWithProgress(URL_, p, { timeoutMs: 60_000 });
		const t = trimModelsDev(JSON.parse(buf.toString("utf8")));
		if (Object.keys(t.providers).length < 10) throw new Error("模型参数库数据不完整");
		const tmp = `${cacheFile()}.part`;
		writeFileSync(tmp, JSON.stringify(t));
		renameSync(tmp, cacheFile());
		entries = null;
	}).finally(() => (running = null));
	return running;
}

registerDownload({
	id: "model-db",
	name: "模型参数库（models.dev）",
	group: "模型",
	size: 5_600_000,
	installed: () => existsSync(cacheFile()) || existsSync(SNAPSHOT),
	start: () => refreshModelDb(true),
});
