#!/usr/bin/env node
/**
 * 生成内置的模型上限快照 packages/server/model-db.json（数据来自 models.dev，MIT 许可）。
 * 只保留每个服务商每个模型的 [上下文, 最大输出, 识图?(1)]，运行时每周再联网刷新一次。
 * 用法：node scripts/gen-model-db.mjs [api.json 本地路径]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function trimModelsDev(j) {
	const providers = {};
	for (const [pid, p] of Object.entries(j)) {
		const ms = {};
		for (const [mid, m] of Object.entries(p?.models ?? {})) {
			const c = m?.limit?.context, o = m?.limit?.output;
			if (typeof c === "number" && c > 0) { const out = typeof o === "number" && o > 0 ? o : 0; ms[m.id ?? mid] = m?.modalities?.input?.includes("image") ? [c, out, 1] : [c, out]; }
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
