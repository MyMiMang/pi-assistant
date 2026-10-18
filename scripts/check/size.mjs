// 文件行数：新文件不超过 600 行；baseline.json 里记录的老大文件只许变短。
import { CODE, isGenerated, lineCount } from "./lib.mjs";
export const LIMIT = 600;
export function checkSize(files, baseline) {
	const errors = [], notes = [], next = {};
	for (const f of files) {
		if (!CODE.test(f) || isGenerated(f)) continue;
		const n = lineCount(f);
		const max = baseline.size[f];
		if (max !== undefined) {
			if (n > max) errors.push(`${f}：${n} 行，超过基线 ${max} 行（老大文件只许变短，请拆分或复用已有代码）`);
			else if (n < max) notes.push(`${f}：${max} → ${n} 行，可运行 npm run check:baseline 收紧基线`);
			if (n > LIMIT) next[f] = Math.min(n, max);
		} else if (n > LIMIT) errors.push(`${f}：${n} 行，超过 ${LIMIT} 行上限（按职责拆成小文件，登记到 docs/MODULES.md）`);
	}
	return { errors, notes, next };
}
