// 统一升级 Pi 依赖：三个 @earendil-works 包一起升 + 同步全部版本记录。
// 用法：node scripts/pi-update.mjs [版本|latest]     默认 latest
//
// 手动升级和 .github/workflows/pi-latest.yml 共用这一条路径，避免出现
// 「代码升了、third-party.json / THIRD_PARTY_NOTICES.md / compat.json 没升」的不一致。
// 只改依赖与版本记录，不碰业务代码；Pi API 变化仍由 packages/server/src/pi-adapter 与各扩展适配。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PI_PACKAGES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-mcp"];
const RI = (p) => new URL(`../${p}`, import.meta.url);
const read = (p) => readFileSync(RI(p), "utf8");
const write = (p, s) => writeFileSync(RI(p), s);
const npm = (args) => execFileSync("npm", args, { cwd: RI("."), stdio: "inherit" });
const view = (spec) => execFileSync("npm", ["view", spec, "version"], { cwd: RI("."), encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const readJson = (p) => JSON.parse(read(p));

/** 把版本记录（compat 基线、第三方清单、分发说明）同步到 target */
export function syncVersionRecords(target, { quiet = false } = {}) {
	write("packages/server/src/pi-adapter/compat.json", `{ "testedWith": "${target}" }\n`);
	const third = readJson("third-party.json");
	for (const name of PI_PACKAGES) {
		const c = third.components.find((x) => x.name === name);
		if (c) c.version = target;
	}
	write("third-party.json", `${JSON.stringify(third, null, 2)}\n`);
	let notices = read("THIRD_PARTY_NOTICES.md");
	for (const name of PI_PACKAGES) {
		const re = new RegExp(`(\\[@earendil-works\\/${name.replace("@earendil-works/", "")}\\]\\([^)]*\\) \\| )[^|]+(\\|)`);
		if (!re.test(notices)) throw new Error(`THIRD_PARTY_NOTICES.md 里找不到 ${name} 的版本行`);
		notices = notices.replace(re, `$1${target} $2`);
	}
	write("THIRD_PARTY_NOTICES.md", notices);
	if (!quiet) console.log(`版本记录已同步到 ${target}：compat.json / third-party.json / THIRD_PARTY_NOTICES.md`);
}

// 命令行入口（被 import 时不执行）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const arg = process.argv[2] ?? "latest";
	const before = readJson("node_modules/@earendil-works/pi-coding-agent/package.json").version;
	const target = arg === "latest" || !/^\d/.test(arg) ? view(`${PI_PACKAGES[0]}@${arg}`) : arg;
	if (target === before && process.argv[3] !== "--force") {
		console.log(`Pi 已经是 ${target}，只同步版本记录`);
		syncVersionRecords(target);
	} else {
		npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "-w", "@pi-assistant/server", ...PI_PACKAGES.map((p) => `${p}@${target}`)]);
		syncVersionRecords(target);
	}
	console.log(`Pi ${before} → ${target}；请接着跑 npm run typecheck、npm test、npm run check:pi 再提交。`);
}
