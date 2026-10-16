// 统一升级 Pi 依赖：三个 @earendil-works 包一起升 + 同步全部版本记录。
// 用法：
//   node scripts/pi-update.mjs [版本|latest]   升级依赖，并把 third-party / NOTICES 同步到目标版本；
//                                              compat.json 只记 target（预期版本），不动 testedWith。
//   node scripts/pi-update.mjs finalize        测试通过后，把 compat.json 的 testedWith 提升到已安装版本。
//
// 关键约定：compat.json 的 testedWith 是「已经跑过测试」的声明。只有 finalize（在 pi-latest 工作流里
// 排在「测试」步骤之后、且仅当测试通过时才执行）能改写它。升级脚本在刚下载完依赖时就改写 testedWith，
// 等于没验证就宣称测过——所以 bump 阶段顶多写 target，真正的基线必须由 finalize 落。
//
// 手动升级和 .github/workflows/pi-latest.yml 共用这一条路径，避免出现
// 「代码升了、third-party.json / THIRD_PARTY_NOTICES.md 没升」的不一致。
// 只改依赖与版本记录，不碰业务代码；Pi API 变化仍由 packages/server/src/pi-adapter 与各扩展适配。
//
// 版本用**精确 pin**（--save-exact），与上游 1.3.0 起对内部 Pi 依赖的精确 pin 政策一致
// （上游 #10865：避免 fresh install 静默混入不兼容的小版本）。没有 lock 时 caret 会解析到下一个
// minor，等于把没测过的版本装进来，所以这里不再写 `^`。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PI_PACKAGES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-mcp"];
const COMPAT = "packages/server/src/pi-adapter/compat.json";
const RI = (p) => new URL(`../${p}`, import.meta.url);
const read = (p) => readFileSync(RI(p), "utf8");
const write = (p, s) => writeFileSync(RI(p), s);
const npm = (args) => execFileSync("npm", args, { cwd: RI("."), stdio: "inherit" });
const view = (spec) => execFileSync("npm", ["view", spec, "version"], { cwd: RI("."), encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const readJson = (p) => JSON.parse(read(p));
/** compat.json 保持原样的单行风格，方便人直接读。 */
const compatLine = ({ testedWith, target }) => (target ? `{ "testedWith": "${testedWith}", "target": "${target}" }\n` : `{ "testedWith": "${testedWith}" }\n`);

/** 已安装的 Pi 版本（升级脚本与 finalize 的唯一事实来源）。 */
export function installedVersion() {
	return readJson("node_modules/@earendil-works/pi-coding-agent/package.json").version;
}

/** 依赖记录（第三方清单、分发说明）反映实际安装的版本；compat.json 只记 target，testedWith 保持不变。 */
export function syncVersionRecords(target, { quiet = false } = {}) {
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
	const compat = readJson(COMPAT);
	write(COMPAT, compatLine({ testedWith: compat.testedWith, target: compat.testedWith === target ? undefined : target }));
	if (!quiet) console.log(`依赖记录已同步到 ${target}：third-party.json / THIRD_PARTY_NOTICES.md；compat.json testedWith 仍为 ${compat.testedWith}（等 finalize）`);
}

/** 测试通过后把兼容基线提升到 target（默认已安装版本）。只有这一步会改 testedWith。 */
export function finalizeCompat(target = installedVersion(), { quiet = false } = {}) {
	const compat = readJson(COMPAT);
	if (compat.testedWith === target && compat.target === undefined) {
		if (!quiet) console.log(`Pi 兼容基线已经是 ${target}，无需改动`);
		return false;
	}
	write(COMPAT, compatLine({ testedWith: target }));
	if (!quiet) console.log(`Pi 兼容基线 ${compat.testedWith} → ${target}（testedWith 只在测试通过后由 finalize 记录）`);
	return true;
}

// 命令行入口（被 import 时不执行）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const arg = process.argv[2] ?? "latest";
	if (arg === "finalize") {
		finalizeCompat(process.argv[3] ?? installedVersion());
		console.log("请确认 typecheck、npm test、Pi 兼容性测试与 E2E 都已通过后再提交。");
	} else {
		const before = installedVersion();
		const target = arg === "latest" || !/^\d/.test(arg) ? view(`${PI_PACKAGES[0]}@${arg}`) : arg;
		if (target === before && process.argv[3] !== "--force") {
			console.log(`Pi 已经是 ${target}，只同步依赖记录`);
		} else {
			npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "-w", "@pi-assistant/server", ...PI_PACKAGES.map((p) => `${p}@${target}`)]);
		}
		syncVersionRecords(target);
		console.log(`Pi ${before} → ${target}；请接着跑 npm run typecheck、npm test、npm run check:pi，全通过后运行 \`node scripts/pi-update.mjs finalize\` 再提交。`);
	}
}
