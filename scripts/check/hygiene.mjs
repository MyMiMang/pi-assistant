// 仓库卫生：截图 / 证据 / 进度快照只写 artifacts/（不入库）；不提交大于 2MB 的文件。
import { statSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const BANNED = /^(evidence|progress-snapshots|docs\/screenshots)\//;
export function checkHygiene(files) {
	const errors = [];
	for (const f of files) {
		if (BANNED.test(f)) errors.push(`${f}：截图 / 证据 / 进度记录不入库，写到 artifacts/（见 docs/decisions/0010）`);
		else if (statSync(join(ROOT, f)).size > 2 << 20 && !/package-lock\.json$/.test(f)) errors.push(`${f}：大于 2MB，不要把大文件提交进仓库`);
	}
	return { errors };
}
