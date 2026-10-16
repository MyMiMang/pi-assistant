/**
 * 共享的「固定清单权重」下载后完整性校验（local-laya 与 local-asr 共用）。
 *
 * 为什么抽出来：两个本地模型的校验逻辑完全同构（流式 SHA256 + 大小 + 路径安全 + symlink 越界防护），
 * 差别只在「清单自检规则」。这里保留一份实现，各调用方传自己的 `assertManifest`。
 *
 * 设计约束（沿用 local-laya 原实现的验收）：
 *  - 只有清单里每个文件都存在、大小与 SHA256 都对，才算通过 → 才允许 activate；
 *  - 只读调用方给的目录与受信根；路径必须相对、不得越界（POSIX 与 Windows 规则都在 `isSafeRelPath` 收口）；
 *  - **symlink 的 realpath 必须落在受信根内**：HuggingFace 缓存里 `snapshots/<rev>/<file>` 合法地
 *    symlink 到同 cache 根下的 `blobs/<sha>`，所以受信根是 `models--org--repo/` 这一级，而不是 snapshot
 *    目录本身（旧实现把根设成 snapshot 目录，把自控 cache 的合法 blob 链接误判成「符号链接越界」）；
 *  - **受信根可以不止一个**（`extraTrustRoots`）：本机已观察到的 HF 缓存里，较大的 LFS 文件会被放到
 *    **同一个自有 hub 缓存**下的共享 `blobs/<xx>/<hash>` 普通文件，snapshot 的链接经 `repo/blobs/<sha>`
 *    再指向它。这不是某个用户的特殊部署，而是真实的缓存落盘形态之一，产品校验必须承认它；同时用
 *    `trustRootBase` 约束「所有受信根本身也必须在自有缓存内」，防止某个根被换成指向外部的 symlink。
 *    跨到任意用户目录 / 兄弟同前缀目录（如 `blobs-evil/`）仍然拒绝。
 *  - **断链与真外跳分开报**：symlink 目标缺失（缺 blob / 缓存残缺）报「符号链接断链」，跳过受信根的
 *    真外跳才报「越界」，便于用户与日志区分「没下完」和「有东西想读缓存外」。
 *  - `optional` 文件（README / .gitattributes 等辅助元数据）：缺失不算失败；存在则仍校验大小 / SHA256。
 *  - 纯文件系统操作，不执行任何脚本。
 *
 * 说明：Windows 路径规则（盘符 / UNC / `\`）按 `node:path` 的 win32 语义实现并可离线单测；
 * **当前发布只覆盖 Apple 芯片 macOS arm64，不宣称 Windows / Intel 实机已跑过本链路**。
 */
import { createHash } from "node:crypto";
import { constants, copyFileSync, createReadStream, linkSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";

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

/** 归一化清单路径：反斜杠统一成 `/`（清单约定 POSIX 分隔符）。 */
function normRel(rel: string): string {
	return String(rel).replace(/\\/g, "/");
}

/** 跨平台「绝对路径」：POSIX 绝对、Windows 盘符（含 `C:` 形式）/ UNC 都算。 */
function isAbsoluteAny(p: string): boolean {
	return isAbsolute(p) || win32.isAbsolute(p) || /^[a-zA-Z]:/.test(p);
}

/**
 * 清单里的相对路径是否安全：非空、非绝对（含 Windows 盘符）、不含 `.` / `..` / 空段 / NUL。
 * 纯字符串判断，不碰磁盘 —— Windows 与 POSIX 规则都在这里收口（离线单测，不宣称 Win 实机验证）。
 */
export function isSafeRelPath(rel: string): boolean {
	if (!rel || rel.includes("\0")) return false;
	if (isAbsoluteAny(rel)) return false;
	return rel.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

/** realpath，失败（不存在 / 断链 / 无权限）返回 null。 */
function realpathOrNull(p: string): string | null {
	try {
		return realpathSync(p);
	} catch {
		return null;
	}
}

/** 统一路径分隔符后比较（两边都应是 realpath 结果，不含 `.` / `..`）。 */
function normalizeForCompare(p: string): string {
	return p.replace(/\\/g, "/");
}

/**
 * `targetReal` 是否在 `rootReal` 内（两者都应是已 realpath 的绝对路径，不含 `.` / `..`）。
 * 统一成 `/` 后按**路径边界**比较：`/a/b` 不包含 `/a/blobs-evil`（同前缀兄弟目录），
 * `/a/b/..foo` 仍算在内；Windows 跨盘符（`C:` vs `D:`）直接拒绝。
 * 纯字符串比较，POSIX 与 Windows 规则一致、可离线单测（不宣称 Windows 实机已验证）。
 */
export function containedIn(rootReal: string, targetReal: string): boolean {
	const root = normalizeForCompare(rootReal);
	const target = normalizeForCompare(targetReal);
	const rd = /^([a-zA-Z]):/.exec(root)?.[1]?.toLowerCase();
	const td = /^([a-zA-Z]):/.exec(target)?.[1]?.toLowerCase();
	if (rd && td && rd !== td) return false;
	if (target === root) return true;
	return target.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** 该路径（可能是 symlink）realpath 后是否仍落在 root 内；越界 / 不存在返回 false。 */
export function pathInsideRoot(root: string, target: string): boolean {
	const rootReal = realpathOrNull(root);
	const real = realpathOrNull(target);
	if (!rootReal || !real) return false;
	return containedIn(rootReal, real);
}

/**
 * 受信根策略：允许清单文件（可能经一层或多层 symlink）落在**多个**自有受信根里。
 *  - `trustRoot`：主受信根（默认 = 被校验目录本身）；
 *  - `extraTrustRoots`：额外允许的根（例如同一个自有 HF 缓存 hub 下的共享 `blobs/` 目录）；不存在的根忽略
 *    （旧形态没有共享 blobs，不能因为「目录不存在」就判失败）；
 *  - `trustRootBase`：所有受信根的 realpath 必须落在它内，防止某个根本身被换成指向外部的 symlink；
 *    不传则不施加这条约束。`trustRootBase` 自身解析不到 → fail closed。
 */
export interface TrustRootOptions {
	trustRoot?: string;
	extraTrustRoots?: string[];
	trustRootBase?: string;
}

interface ResolvedTrust {
	roots: string[];
	/** 策略自身的问题（自有缓存根缺失 / 某个根越出自有缓存）：直接判失败，不读取任何权重 */
	problems: string[];
}

function resolveTrust(defDir: string, opts: TrustRootOptions): ResolvedTrust {
	const problems: string[] = [];
	const baseReal = opts.trustRootBase ? realpathOrNull(opts.trustRootBase) : null;
	if (opts.trustRootBase && !baseReal) problems.push(`受信缓存根不存在：${opts.trustRootBase}`);
	const roots: string[] = [];
	for (const cand of [opts.trustRoot ?? defDir, ...(opts.extraTrustRoots ?? [])]) {
		const real = realpathOrNull(cand);
		if (!real) continue; // 不存在 / 断链的根：忽略，交由文件级缺失判定
		if (baseReal && !containedIn(baseReal, real)) {
			problems.push(`受信根越出自有缓存：${cand}`);
			continue;
		}
		if (!roots.includes(real)) roots.push(real);
	}
	return { roots, problems };
}

/** 通用清单自检：路径必须安全、digest 形状正确、无重复（更严的规则由调用方追加）。 */
export function assertSafePinnedFiles(files: PinnedFile[]): string[] {
	const problems: string[] = [];
	if (!files.length) problems.push("文件清单为空");
	const seen = new Set<string>();
	for (const f of files) {
		const rel = normRel(f.path);
		if (!isSafeRelPath(rel)) {
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
export interface VerifyOptions extends TrustRootOptions {
	hashFile?: (p: string) => Promise<string>;
	assertManifest?: (files: PinnedFile[]) => string[];
}

export async function verifyPinnedFiles(dir: string, files: PinnedFile[], opts: VerifyOptions = {}): Promise<VerifyResult> {
	const hash = opts.hashFile ?? sha256File;
	const problems: string[] = [...(opts.assertManifest ? opts.assertManifest(files) : []), ...assertSafePinnedFiles(files)];
	let checked = 0;
	let bytes = 0;
	const root = resolve(dir);
	const trust = resolveTrust(dir, opts);
	problems.push(...trust.problems);

	for (const f of files) {
		const rel = normRel(f.path);
		// 清单已判过不安全路径的跳过，避免越界读盘
		if (!isSafeRelPath(rel)) continue;
		const full = join(root, rel);
		let ls: ReturnType<typeof lstatSync>;
		try {
			ls = lstatSync(full);
		} catch {
			if (f.optional) continue; // 辅助元数据缺失不算失败
			problems.push(`缺少文件：${rel}`);
			continue;
		}
		const real = realpathOrNull(full);
		if (!real) {
			// symlink 目标缺失（缺 blob / 缓存残缺）：与「越界外跳」区分开，用户能看出是没下完还是被拦下。
			if (f.optional) continue;
			problems.push(`${ls.isSymbolicLink() ? "符号链接断链（目标缺失）" : "缺少文件"}：${rel}`);
			continue;
		}
		if (!trust.roots.some((r) => containedIn(r, real))) {
			problems.push(`${ls.isSymbolicLink() ? "符号链接" : "路径"}越界：${rel}`);
			continue;
		}
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(real); // 已 realpath，直接取真实文件大小
		} catch {
			if (f.optional) continue;
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
 * 受信根策略与 `verifyPinnedFiles` 相同（多根 + 自有缓存约束）。
 */
export async function materializePinnedFiles(
	srcDir: string,
	destDir: string,
	files: PinnedFile[],
	opts: TrustRootOptions & { hashFile?: (p: string) => Promise<string> } = {},
): Promise<MaterializeResult> {
	const hash = opts.hashFile ?? sha256File;
	const root = resolve(srcDir);
	const destRoot = resolve(destDir);
	const trust = resolveTrust(srcDir, opts);
	const problems: string[] = [...trust.problems];
	const written: string[] = [];
	for (const f of files) {
		if (f.optional) continue;
		const rel = normRel(f.path);
		if (!isSafeRelPath(rel)) {
			problems.push(`不安全的相对路径：${f.path}`);
			continue;
		}
		const src = join(root, rel);
		const dest = join(destRoot, rel);
		let ls: ReturnType<typeof lstatSync>;
		try {
			ls = lstatSync(src);
		} catch {
			problems.push(`缺少文件：${rel}`);
			continue;
		}
		const real = realpathOrNull(src);
		if (!real) {
			problems.push(`${ls.isSymbolicLink() ? "符号链接断链（目标缺失）" : "缺少文件"}：${rel}`);
			continue;
		}
		if (!trust.roots.some((r) => containedIn(r, real))) {
			problems.push(`路径越界：${rel}`);
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
