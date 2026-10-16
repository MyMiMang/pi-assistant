/**
 * 共享的「固定清单权重」下载后完整性校验（local-laya 与 local-asr 共用）。
 *
 * 为什么抽出来：两个本地模型的校验逻辑完全同构（流式 SHA256 + 大小 + 路径安全 + symlink 越界防护），
 * 差别只在「清单自检规则」。这里保留一份实现，各调用方传自己的 `assertManifest`。
 *
 * 设计约束（沿用 local-laya 原实现的验收）：
 *  - 只有清单里每个文件都存在、大小与 SHA256 都对，才算通过 → 才允许 activate；
 *  - 只读调用方给的目录与受信根；路径必须相对、不得越界；
 *  - **symlink 的 realpath 必须落在受信根（trustRoot）内**：HuggingFace 缓存里
 *    `snapshots/<rev>/<file>` 合法地指向同 cache 根下的 `../../blobs/<sha>`，所以受信根是
 *    `models--org--repo/` 这一级，而不是 snapshot 目录本身（旧实现把根设成 snapshot 目录，
 *    把自控 cache 的合法 blob 链接误判成「符号链接越界」）；跨到任意用户目录仍拒绝。
 *  - `optional` 文件（README / .gitattributes 等辅助元数据）：缺失不算失败；存在则仍校验大小 / SHA256。
 *  - 纯文件系统操作，不执行任何脚本。
 */
import { createHash } from "node:crypto";
import { constants, copyFileSync, createReadStream, linkSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface PinnedFile {
	/** 相对根目录的路径（POSIX 分隔符） */
	path: string;
	size: number;
	sha256: string;
	/** 辅助文件：缺失不算失败（存在则仍要大小 / SHA256 一致） */
	optional?: boolean;
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

/** 该路径（可能是 symlink）realpath 后是否仍落在 root 内；越界 / 不存在返回 false。 */
export function pathInsideRoot(root: string, target: string): boolean {
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
export interface VerifyOptions {
	hashFile?: (p: string) => Promise<string>;
	assertManifest?: (files: PinnedFile[]) => string[];
	/**
	 * 受信根：清单文件的 realpath 必须落在它里面。默认 = dir（快照目录本身）。
	 * HuggingFace 缓存请传 `models--org--repo/`（snapshot 的 symlink 合法指向同根的 blobs）。
	 */
	trustRoot?: string;
}

export async function verifyPinnedFiles(dir: string, files: PinnedFile[], opts: VerifyOptions = {}): Promise<VerifyResult> {
	const hash = opts.hashFile ?? sha256File;
	const problems: string[] = [...(opts.assertManifest ? opts.assertManifest(files) : []), ...assertSafePinnedFiles(files)];
	let checked = 0;
	let bytes = 0;
	const root = resolve(dir);
	const trust = resolve(opts.trustRoot ?? dir);

	for (const f of files) {
		const rel = String(f.path).replace(/\\/g, "/");
		// 清单已判过不安全路径的跳过，避免越界读盘
		if (!rel || rel.startsWith("/") || rel.split("/").some((s) => s === "" || s === "." || s === "..")) continue;
		const full = join(root, rel);
		let st: ReturnType<typeof statSync>;
		try {
			const ls = lstatSync(full);
			// realpath 必须落在受信根内（HF 快照 symlink → 同 cache 根的 blobs 合法；跨到用户目录拒绝）
			if (!pathInsideRoot(trust, full)) {
				problems.push(`${ls.isSymbolicLink() ? "符号链接" : "路径"}越界：${rel}`);
				continue;
			}
			st = statSync(full); // 跟随 symlink 取真实大小
		} catch {
			if (f.optional) continue; // 辅助元数据缺失不算失败
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

export interface MaterializeResult {
	ok: boolean;
	written: string[];
	problems: string[];
}

/**
 * 把已校验的清单文件**物化成 staging 里的普通文件**（优先硬链接到真实 blob，同一磁盘不占额外空间；
 * 跨设备 / 不支持时退回复制）。这样激活后的权重不再依赖 symlink，随后可原子 rename 到生效目录。
 * 只处理**必需文件**（optional 辅助文件跳过）；物化后再对普通文件算一次大小 / SHA256，任一不符即不 ok。
 */
export async function materializePinnedFiles(
	srcDir: string,
	destDir: string,
	files: PinnedFile[],
	opts: { trustRoot?: string; hashFile?: (p: string) => Promise<string> } = {},
): Promise<MaterializeResult> {
	const hash = opts.hashFile ?? sha256File;
	const trust = resolve(opts.trustRoot ?? srcDir);
	const root = resolve(srcDir);
	const destRoot = resolve(destDir);
	const problems: string[] = [];
	const written: string[] = [];
	for (const f of files) {
		if (f.optional) continue;
		const rel = String(f.path).replace(/\\/g, "/");
		if (!rel || rel.startsWith("/") || rel.split("/").some((s) => s === "" || s === "." || s === "..")) {
			problems.push(`不安全的相对路径：${f.path}`);
			continue;
		}
		const src = join(root, rel);
		const dest = join(destRoot, rel);
		let real: string;
		try {
			if (!pathInsideRoot(trust, src)) {
				problems.push(`路径越界：${rel}`);
				continue;
			}
			real = realpathSync(src); // 跟到同 cache 根内的真实 blob，之后只链接普通文件，不再跟随 symlink
		} catch {
			problems.push(`缺少文件：${rel}`);
			continue;
		}
		try {
			mkdirSync(dirname(dest), { recursive: true });
			rmSync(dest, { force: true });
			try {
				linkSync(real, dest);
			} catch {
				copyFileSync(real, dest, constants.COPYFILE_FICLONE); // 跨设备 / 不支持硬链接时：写普通文件副本
			}
		} catch {
			problems.push(`物化失败：${rel}`);
			continue;
		}
		// 物化后只认普通文件：大小 + SHA256 再核一次，任一不符即判失败。
		let st: ReturnType<typeof statSync>;
		try {
			st = lstatSync(dest);
		} catch {
			problems.push(`物化文件不存在：${rel}`);
			continue;
		}
		if (!st.isFile()) {
			problems.push(`物化结果不是普通文件：${rel}`);
			continue;
		}
		if (st.size !== f.size) {
			problems.push(`物化后大小不符：${rel}`);
			continue;
		}
		try {
			if ((await hash(dest)).toLowerCase() !== f.sha256.toLowerCase()) {
				problems.push(`物化后 SHA256 不符：${rel}`);
				continue;
			}
		} catch {
			problems.push(`物化后读取失败：${rel}`);
			continue;
		}
		written.push(rel);
	}
	return { ok: problems.length === 0, written, problems };
}
