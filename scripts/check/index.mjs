#!/usr/bin/env node
// 规范检查入口（npm run check:static）。规则来源：AGENTS.md。
//   --staged          只查暂存区（pre-commit 用，跳过重复检测）
//   --update-baseline 把基线收紧到当前值（只会变小，不会放宽）
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, repoFiles, stagedFiles, loadBaseline, baselinePath } from "./lib.mjs";
import { checkSize } from "./size.mjs";
import { checkBoundaries } from "./boundaries.mjs";
import { checkDup } from "./dup.mjs";
import { checkDocs } from "./docs.mjs";
import { checkHygiene } from "./hygiene.mjs";

const staged = process.argv.includes("--staged");
const update = process.argv.includes("--update-baseline");
const baseline = loadBaseline();
const all = repoFiles();
const files = staged ? stagedFiles() : all;
const results = [
	["文件行数", checkSize(files, baseline)],
	["依赖边界", checkBoundaries(files, baseline)],
	["文档", checkDocs()],
	["仓库卫生", checkHygiene(staged ? stagedFiles("A") : files)],
];
if (!staged) results.push(["重复代码", checkDup(baseline)]);

let failed = 0;
for (const [name, r] of results) {
	for (const n of r.notes ?? []) console.log(`ℹ️ [${name}] ${n}`);
	for (const e of r.errors) console.error(`❌ [${name}] ${e}`);
	failed += r.errors.length;
	console.log(r.errors.length ? `✗ ${name}：${r.errors.length} 个问题` : `✓ ${name}`);
}
if (update && !staged) {
	const size = checkSize(all, baseline).next, sel = checkBoundaries(all, baseline).next.nativeSelect;
	const dup = results.find(([n]) => n === "重复代码")[1].count;
	const next = { ...baseline, size, nativeSelect: sel, dupClones: Math.min(baseline.dupClones, dup ?? baseline.dupClones) };
	writeFileSync(join(ROOT, baselinePath), JSON.stringify(next, null, "\t") + "\n");
	console.log("已收紧基线：scripts/check/baseline.json");
}
if (failed) {
	console.error(`\n规范检查失败：${failed} 个问题。规则见 AGENTS.md；先复用已有代码（docs/MODULES.md），不要放宽基线。`);
	process.exit(1);
}
