/**
 * 本地 Laya 权重的**下载后完整性校验**（流式 SHA256 + 大小 + 路径安全）。
 *
 * 设计目标（与用户「一键下载安装」的安全验收一致）：
 *  - 只有清单里每个文件都存在、大小与 SHA256 都对，才算校验通过 → 才允许 activate；
 *    缺文件 / 大小或哈希不符 → 抛错，由 manager 回滚 staging 并置 failed（绝不产生半安装 ready）。
 *  - 只读**我们自己的**下载目录；路径必须相对、不得越界；symlink 必须仍指向该目录内（HF 缓存快照就是 symlink → blob）。
 *  - 纯文件系统操作，不执行 checkpoint 内任何脚本（safetensors-only 由清单 + allow_patterns 保证）。
 *
 * 测试用临时目录里的假文件（bitflip / 缺文件 / 大小不符 / symlink 逃逸），不下载任何真实权重。
 */
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { assertSafeManifest, type LayaCheckpointFile } from "./checkpoint-files.ts";

export interface CheckpointVerifyResult {
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

/**
 * 校验 checkpoint 目录是否符合固定清单。
 * 返回问题列表；`ok` 仅在零问题时为 true。不抛异常（除 root 完全不存在外由问题列表表达）。
 */
export async function verifyCheckpointFiles(
	dir: string,
	files: LayaCheckpointFile[],
	opts: { hashFile?: (p: string) => Promise<string> } = {},
): Promise<CheckpointVerifyResult> {
	const hash = opts.hashFile ?? sha256File;
	const problems: string[] = assertSafeManifest(files);
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
