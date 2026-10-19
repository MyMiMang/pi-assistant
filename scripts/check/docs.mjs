// 文档卫生：指针文件只指向 AGENTS.md；HANDOFF 不超过 120 行；MODULES.md 登记了每个模块；ROADMAP 一行一事；设计文档写状态；npm 脚本不指向不存在的文件。
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, read, exists } from "./lib.mjs";

const POINTERS = ["CLAUDE.md", "GEMINI.md", ".cursor/rules/project.mdc", ".github/copilot-instructions.md"];
/** MODULES.md 里「## `目录`」小节必须登记该目录下的每个顶层文件 / 子目录 */
const MAPPED = ["packages/server/src", "apps/web/src", "apps/web/src/components", "e2e/fixtures"];
export function checkDocs() {
	const errors = [];
	for (const p of POINTERS) {
		if (!exists(p)) { errors.push(`${p} 缺失：它应是指向 AGENTS.md 的指针文件`); continue; }
		const s = read(p);
		if (s.split("\n").length > 10 || !s.includes("AGENTS.md")) errors.push(`${p}：只能是指向 AGENTS.md 的指针（≤10 行），规则只写在 AGENTS.md`);
	}
	const handoff = read("docs/HANDOFF.md").split("\n").length;
	if (handoff > 120) errors.push(`docs/HANDOFF.md：${handoff} 行，超过 120 行。只写当前状态，历史移到 docs/history/`);
	const modules = read("docs/MODULES.md");
	const tops = new Set(readdirSync(join(ROOT, "packages")).concat(readdirSync(join(ROOT, "apps"))).filter((n) => !n.startsWith(".")));
	for (const t of tops) if (!modules.includes(`\`${t}\``)) errors.push(`docs/MODULES.md 没登记 packages/apps 下的「${t}」`);
	for (const dir of MAPPED) {
		const m = modules.split(/^## /m).find((sec) => sec.startsWith(`\`${dir}\``));
		if (!m) { errors.push(`docs/MODULES.md 缺少小节「## \`${dir}\`」`); continue; }
		for (const name of readdirSync(join(ROOT, dir))) {
			if (name.startsWith(".") || (dir === "apps/web/src" && name === "components")) continue;
			if (!m.includes(`\`${name}\``) && !m.includes(`\`${name}/\``)) errors.push(`${dir}/${name} 没登记到 docs/MODULES.md 的「${dir}」小节（新增文件要写一行它负责什么）`);
		}
	}
	read("docs/ROADMAP.md").split("\n").forEach((l, i) => {
		if (/^\s*[-|]/.test(l) && [...l].length > 220) errors.push(`docs/ROADMAP.md 第 ${i + 1} 行太长（${[...l].length} 字）：一行一事，细节写进设计文档`);
	});
	for (const f of readdirSync(join(ROOT, "docs/design"))) {
		if (!f.endsWith(".md")) continue;
		if (!read(`docs/design/${f}`).split("\n").slice(0, 6).some((l) => l.includes("状态"))) errors.push(`docs/design/${f}：前 6 行要写「状态：草稿 / 已批准 / 已实现 / 已废弃」`);
	}
	const pkgs = ["package.json", ...["apps", "packages"].flatMap((d) => readdirSync(join(ROOT, d)).map((x) => `${d}/${x}/package.json`))].filter(exists);
	for (const p of pkgs) {
		const base = p.replace(/package\.json$/, "");
		for (const [k, cmd] of Object.entries(JSON.parse(read(p)).scripts ?? {}))
			for (const m of cmd.matchAll(/(?:^|\s)((?:\.\.\/)*(?:scripts|e2e|test|src)\/[\w./-]+\.(?:mjs|ts|js|py|sh))/g))
				if (!m[1].includes("*") && !exists(join(base, m[1]))) errors.push(`${p} 的脚本「${k}」指向不存在的 ${m[1]}`);
	}
	return { errors };
}
