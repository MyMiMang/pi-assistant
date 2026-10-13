#!/usr/bin/env node
/**
 * 生成内置的模型上限快照 packages/server/model-db.json（数据来自 models.dev，MIT 许可）。
 * 只保留每个服务商每个模型的 [上下文, 最大输出, 标记?, 价格?]，运行时每周再联网刷新一次。
 * 用法：node scripts/gen-model-db.mjs [api.json 本地路径]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const n = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v * 1e4) / 1e4 : null);
function trimCost(c) {
	if (!c) return null;
	const o = c.context_over_200k;
	const arr = [n(c.input), n(c.output), n(c.cache_read), n(c.cache_write), n(c.reasoning), n(o?.input), n(o?.output), n(o?.cache_read)];
	while (arr.length && arr[arr.length - 1] === null) arr.pop();
	return arr.length && (arr[0] !== null || arr[1] !== null) ? arr : null;
}
/** 见 packages/server/src/model-db.ts：[上下文, 最大输出, 标记(1 识图 2 推理 4 工具 8 图片输出)?, 价格?] */
export function trimModelsDev(j) {
	const providers = {};
	for (const [pid, p] of Object.entries(j)) {
		const ms = {};
		for (const [mid, m] of Object.entries(p?.models ?? {})) {
			const c = m?.limit?.context, o = m?.limit?.output;
			if ((typeof c === "number" && c > 0) || m?.modalities?.output?.includes("image")) {
				const out = typeof o === "number" && o > 0 ? o : 0;
				const flags = (m?.modalities?.input?.includes("image") ? 1 : 0) | (m?.reasoning ? 2 : 0) | (m?.tool_call ? 4 : 0) | (m?.modalities?.output?.includes("image") ? 8 : 0);
				const cost = trimCost(m?.cost);
				const e = [c ?? 0, out];
				if (flags || cost) e.push(flags);
				if (cost) e.push(cost);
				ms[m.id ?? mid] = e;
			}
		}
		if (Object.keys(ms).length) providers[pid] = ms;
	}
	return { source: "https://models.dev/api.json", generatedAt: new Date().toISOString(), providers };
}
if (import.meta.url === `file://${process.argv[1]}`) {
	const src = process.argv[2];
	const j = src ? JSON.parse(readFileSync(src, "utf8")) : await (await fetch("https://models.dev/api.json")).json();
	const out = join(import.meta.dirname, "..", "packages", "server", "model-db.json");
	writeFileSync(out, JSON.stringify(trimModelsDev(j)));
	console.log("wrote", out);
}
