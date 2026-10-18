// 升级 Hindsight（高级记忆）：Python 包（hindsight-embed / hindsight-api-slim）与 npm 包（hindsight-all / hindsight-client）一起升，
// 并同步全部版本记录（pyproject、package.json、third-party.json、THIRD_PARTY_NOTICES.md）。与 scripts/pi-update.mjs 同一套思路：
//   node scripts/hindsight-update.mjs [版本|latest]   升级并同步记录（exclude-newer 推到今天，换镜像也解析出同一套依赖）
//   node scripts/hindsight-update.mjs check           只看上游有没有新版本（输出 JSON，不改文件）
// 只改依赖与版本记录，不碰 Hindsight 本身、也不碰业务代码；适配只在 packages/server/src/memory/hindsight 与 llm-proxy.ts。
// 用户那边：App 更新后，sidecar 发现 pyproject 变了会自动用 uv 重新安装同一版本（见 sidecar.ts install），不需要用户操作。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PY = ["hindsight-embed", "hindsight-api-slim"];
const NPM = ["@vectorize-io/hindsight-all", "@vectorize-io/hindsight-client"];
const PYPROJECT = "packages/server/hindsight/pyproject.toml";
const RI = (p) => new URL(`../${p}`, import.meta.url);
const read = (p) => readFileSync(RI(p), "utf8");
const write = (p, s) => writeFileSync(RI(p), s);

/** pyproject 里当前 pin 的版本（hindsight-api-slim 为准） */
export const pinnedVersion = (text = read(PYPROJECT)) => text.match(/"hindsight-api-slim(?:\[[^\]]*\])?==([^"]+)"/)?.[1] ?? null;

/** 改 pyproject：两个 Python 包换成 version，exclude-newer 换成 excludeNewer（ISO 时间） */
export function bumpPyproject(text, version, excludeNewer) {
	let out = text;
	for (const name of PY) {
		const re = new RegExp(`("${name}(?:\\[[^\\]]*\\])?==)[^"]+(")`);
		if (!re.test(out)) throw new Error(`pyproject 里找不到 ${name}`);
		out = out.replace(re, `$1${version}$2`);
	}
	return out.replace(/exclude-newer = "[^"]+"/, `exclude-newer = "${excludeNewer}"`);
}

/** third-party.json / THIRD_PARTY_NOTICES.md 同步到 version */
export function syncRecords(version, excludeNewer) {
	const third = JSON.parse(read("third-party.json"));
	for (const c of third.components) {
		if (c.name === "hindsight") {
			for (const k of Object.keys(c.packages)) if (PY.some((n) => k.startsWith(n))) c.packages[k] = version;
			c.excludeNewer = excludeNewer;
		}
		if (NPM.includes(c.name)) c.version = version;
	}
	write("third-party.json", `${JSON.stringify(third, null, 2)}\n`);
	const notices = read("THIRD_PARTY_NOTICES.md").replace(/(\[Hindsight\]\([^)]*\)[^|]*\| )[^|]+(\|)/, `$1${version} $2`).replace(/(\[@vectorize-io\/hindsight-all\][^|]*\| )[^|]+(\|)/, `$1${version} $2`);
	write("THIRD_PARTY_NOTICES.md", notices);
}

/** 上游最新版（PyPI 为准；npm 包与之同版本发布） */
export async function latestVersion() {
	const r = await fetch("https://pypi.org/pypi/hindsight-api-slim/json", { signal: AbortSignal.timeout(15_000) });
	if (!r.ok) throw new Error(`PyPI HTTP ${r.status}`);
	return (await r.json()).info.version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const arg = process.argv[2] ?? "latest";
	const before = pinnedVersion();
	if (arg === "check") {
		const latest = await latestVersion();
		console.log(JSON.stringify({ pinned: before, latest, update: latest !== before }));
	} else {
		const target = arg === "latest" ? await latestVersion() : arg;
		if (target === before && process.argv[3] !== "--force") console.log(`Hindsight 已经是 ${target}`);
		else {
			const excludeNewer = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
			write(PYPROJECT, bumpPyproject(read(PYPROJECT), target, excludeNewer));
			execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "-w", "@pi-assistant/server", ...NPM.map((p) => `${p}@${target}`)], { cwd: RI("."), stdio: "inherit" });
			syncRecords(target, excludeNewer);
			console.log(`Hindsight ${before} → ${target}；接着跑 npm run typecheck、npm test、真机冒烟 packages/server/test/hindsight.smoke.ts，全通过再提交。`);
		}
	}
}
