// 重复代码：用固定版本的 jscpd（npx 运行，不进依赖）。15 行 / 80 token 以上的重复数超过基线就失败。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

export const JSCPD = "jscpd@4.3.0";
const DIRS = ["packages/server/src", "packages/shared/src", "apps/web/src", "apps/rendezvous/src", ...["approval", "browser", "computer", "connectors", "delivery", "memory", "proactive", "routines", "sandbox", "skills"].map((x) => `packages/ext-${x}/src`)];
export function checkDup(baseline) {
	const out = mkdtempSync(join(tmpdir(), "pia-jscpd-"));
	try {
		execFileSync("npx", ["-y", JSCPD, ...DIRS, "--min-lines", "15", "--min-tokens", "80", "--reporters", "json", "--silent", "--output", out, "--ignore", "**/*.d.ts,**/provider-icons.ts"], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], timeout: 300_000 });
	} catch (e) {
		rmSync(out, { recursive: true, force: true });
		const msg = `jscpd 运行失败（${String(e.message).split("\n")[0]}）`;
		return process.env.CI ? { errors: [msg] } : { errors: [], notes: [`${msg}，本机跳过重复检测（CI 会查）`] };
	}
	const report = JSON.parse(readFileSync(join(out, "jscpd-report.json"), "utf8"));
	rmSync(out, { recursive: true, force: true });
	const clones = report.duplicates ?? [];
	const list = clones.map((c) => `  ${c.firstFile.name}:${c.firstFile.start}-${c.firstFile.end} ≈ ${c.secondFile.name}:${c.secondFile.start}-${c.secondFile.end}（${c.lines} 行）`);
	if (clones.length > baseline.dupClones) return { errors: [`重复代码 ${clones.length} 处，超过基线 ${baseline.dupClones} 处。把新复制的代码改成复用已有实现：\n${list.join("\n")}`], count: clones.length };
	return { errors: [], notes: clones.length < baseline.dupClones ? [`重复代码已减到 ${clones.length} 处，可运行 npm run check:baseline 收紧基线`] : [], count: clones.length };
}
