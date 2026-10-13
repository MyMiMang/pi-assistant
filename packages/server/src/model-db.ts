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
const cacheFile = () => join(config.dataDir, "model-db.json");

type Trimmed = { generatedAt?: string; providers: Record<string, Record<string, [number, number]>> };

/** models.dev 原始数据 → 精简格式（与 scripts/gen-model-db.mjs 相同） */
export function trimModelsDev(j: Record<string, { models?: Record<string, { id?: string; limit?: { context?: number; output?: number } }> }>): Trimmed {
	const providers: Trimmed["providers"] = {};
	for (const [pid, p] of Object.entries(j)) {
		const ms: Record<string, [number, number]> = {};
		for (const [mid, m] of Object.entries(p?.models ?? {})) {
			const c = m?.limit?.context;
			const o = m?.limit?.output;
			if (typeof c === "number" && c > 0) ms[m.id ?? mid] = [c, typeof o === "number" && o > 0 ? o : 0];
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
	entries = indexModelDb(t?.providers ?? {});
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
