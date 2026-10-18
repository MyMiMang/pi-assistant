// 规范检查共用工具：列文件、读文件、记录问题。纯 Node，无依赖。
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const ROOT = new URL("../../", import.meta.url).pathname;
export const read = (p) => readFileSync(join(ROOT, p), "utf8");
export const exists = (p) => existsSync(join(ROOT, p));
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });

/** 仓库里的文件：已跟踪 + 未跟踪但没被忽略的（还没提交的新文件也要查），去掉已删除的 */
export function repoFiles() {
	return git("ls-files", "-co", "--exclude-standard").split("\n").filter((f) => f && exists(f));
}
/** 暂存区里新增 / 修改的文件（pre-commit 用） */
export function stagedFiles(filter = "ACMR") {
	return git("diff", "--cached", "--name-only", `--diff-filter=${filter}`).split("\n").filter(Boolean);
}
export const lineCount = (p) => read(p).split("\n").length - (read(p).endsWith("\n") ? 1 : 0);
export const CODE = /\.(ts|tsx|mjs|js|cjs|rs|css|py|sh)$/;
/** 生成的 / 第三方的文件，不算行数 */
export const GENERATED = [/^packages\/sandbox-desktop\/.*\/vendor\//, /\.d\.ts$/, /^apps\/web\/dist\//, /^packages\/server\/src\/model-db\.json$/];
export const isGenerated = (f) => GENERATED.some((r) => r.test(f));

export const baselinePath = "scripts/check/baseline.json";
export const loadBaseline = () => JSON.parse(read(baselinePath));
