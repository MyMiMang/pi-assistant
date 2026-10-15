/**
 * Pi SDK 边界静态守卫：`pi-coding-agent` / `pi-mcp` 只用公开包入口，不深链内部文件 / node_modules 私有路径。
 * 这样 Pi 升级（内部目录结构变化）不会连带弄坏我们。（`pi-ai` 的 `compat` / `api/*` 是官方公开子路径导出，允许。）
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SKIP = new Set(["node_modules", "dist", ".git", "build", ".vite", "coverage"]);

function* walk(dir: string): Generator<string> {
	for (const n of readdirSync(dir)) {
		if (SKIP.has(n)) continue;
		const p = join(dir, n);
		const st = statSync(p);
		if (st.isDirectory()) yield* walk(p);
		else if (/\.(ts|tsx|mts|cts)$/.test(n)) yield p;
	}
}

test("不深链 Pi SDK 内部文件（只用公开包入口）", () => {
	const offenders: string[] = [];
	for (const base of ["packages", "apps"]) {
		for (const file of walk(join(ROOT, base))) {
			const src = readFileSync(file, "utf8");
			for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
				const spec = m[1];
				// pi-coding-agent / pi-mcp 只用公开包入口；它们的 /dist/... 内部路径属于私有 API
				if (/^@earendil-works\/pi-(coding-agent|mcp)\//.test(spec)) offenders.push(`${relative(ROOT, file)} → ${spec}`);
				if (spec.includes("node_modules/")) offenders.push(`${relative(ROOT, file)} → ${spec}`);
			}
		}
	}
	assert.deepEqual(offenders, [], `发现 Pi SDK 深链 / node_modules 路径导入：\n${offenders.join("\n")}`);
});
