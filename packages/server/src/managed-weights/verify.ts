/**
 * 共享的「固定清单权重」下载后完整性校验（local-laya 与 local-asr 共用）。
 *
 * 为什么抽出来：两个本地模型的校验逻辑完全同构（流式 SHA256 + 大小 + 路径安全 + symlink 越界防护），
 * 差别只在「清单自检规则」。这里保留一份实现，各调用方传自己的 `assertManifest`。
 *
 * 设计约束（沿用 local-laya 原实现的验收）：
 *  - 只有清单里每个文件都存在、大小与 SHA256 都对，才算通过 → 才允许 activate；
 *  - 只读调用方给的目录；路径必须相对、不得越界；symlink 必须仍指向该目录内；
 *  - 纯文件系统操作，不执行任何脚本。
 */
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export interface PinnedFile {
	/** 相对根目录的路径（POSIX 分隔符） */
	path: string;
	size: number;
	sha256: string;
}

export interface VerifyResult {
	ok: boolean;
	checked: number;
	bytes: number;
	problems: string[];
}

/** 流式计算文件 SHA256（默认实现；测试可注入假哈希函数）。 */
export function sha256File(path: string): Promise<string> {
	return new Promise((res, rej) => {
		const h = createHash("sha256");
		const s = createReadStream(path);
		s.on("data", (b) => h.update(b));
		s.on("error", rej);
		s.on("end", () => res(h.digest("hex")));
	});
}

/** 该路径（可能是 symlink）是否仍落在 root 内；越界 / 不存在返回 false。 */
function staysInside(root: string, target: string): boolean {
	try {
		const real = realpathSync(target);
		const rootReal = realpathSync(root);
		const rel = relative(rootReal, real);
		return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`) && !rel.includes(`${sep}..${sep}`));
	} catch {
		return false;
	}
}

/** 通用清单自检：路径必须安全、digest 形状正确、无重复（更严的规则由调用方追加）。 */
export function assertSafePinnedFiles(files: PinnedFile[]): string[] {
	const problems: string[] = [];
	if (!files.length) problems.push("文件清单为空");
	const seen = new Set<string>();
	for (const f of files) {
		const rel = String(f.path).replace(/\\/g, "/");
		if (!rel || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel) || rel.split("/").some((s) => s === "" || s === "." || s === "..")) {
			problems.push(`不安全的相对路径：${f.path}`);
			continue;
		}
		if (seen.has(rel)) problems.push(`重复路径：${rel}`);
		seen.add(rel);
		if (!Number.isInteger(f.size) || f.size < 0) problems.push(`大小非法：${rel}`);
		if (!/^[a-f0-9]{64}$/.test(f.sha256)) problems.push(`SHA256 形状非法：${rel}`);
	}
	return problems;
}

/**
 * 校验目录是否符合固定清单。返回问题列表；`ok` 仅在零问题时为 true。
 * `assertManifest` 用于额外的清单自检（如 local-laya 要求 safetensors-only）。
 */
export async function verifyPinnedFiles(
	dir: string,
	files: PinnedFile[],
	opts: { hashFile?: (p: string) => Promise<string>; assertManifest?: (files: PinnedFile[]) => string[] } = {},
): Promise<VerifyResult> {
	const hash = opts.hashFile ?? sha256File;
	const problems: string[] = [...(opts.assertManifest ? opts.assertManifest(files) : []), ...assertSafePinnedFiles(files)];
	let checked = 0;
	let bytes = 0;
	const root = resolve(dir);

	for (const f of files) {
		const rel = String(f.path).replace(/\\/g, "/");
		// 清单已判过不安全路径的跳过，避免越界读盘
		if (!rel || rel.startsWith("/") || rel.split("/").some((s) => s === "" || s === "." || s === "..")) continue;
		const full = join(root, rel);
		let st: ReturnType<typeof statSync>;
		try {
			const ls = lstatSync(full);
			if (ls.isSymbolicLink() && !staysInside(root, full)) {
				problems.push(`符号链接越界：${rel}`);
				continue;
			}
			st = statSync(full); // 跟随 symlink 取真实大小
		} catch {
			problems.push(`缺少文件：${rel}`);
			continue;
		}
		if (!st.isFile()) {
			problems.push(`不是普通文件：${rel}`);
			continue;
		}
		if (st.size !== f.size) {
			problems.push(`大小不符：${rel}（期望 ${f.size}，实际 ${st.size}）`);
			continue;
		}
		let got: string;
		try {
			got = (await hash(full)).toLowerCase();
		} catch {
			problems.push(`读取失败：${rel}`);
			continue;
		}
		if (got !== f.sha256.toLowerCase()) {
			problems.push(`SHA256 不符：${rel}`);
			continue;
		}
		checked += 1;
		bytes += f.size;
	}
	return { ok: problems.length === 0, checked, bytes, problems };
}
