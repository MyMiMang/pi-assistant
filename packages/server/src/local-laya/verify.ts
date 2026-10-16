/**
 * 本地 Laya 权重的下载后完整性校验（**薄封装**：实现已抽到 `managed-weights/verify.ts` 共用）。
 *
 * 保留原有导出（`verifyCheckpointFiles` / `sha256File` / `CheckpointVerifyResult`）以免影响既有调用方与测试；
 * Laya 特有的清单规则（safetensors-only + tokenizer 必需）通过 `assertManifest` 注入。
 */
import { assertSafeManifest, type LayaCheckpointFile } from "./checkpoint-files.ts";
import { sha256File, verifyPinnedFiles, type VerifyResult } from "../managed-weights/verify.ts";

export type CheckpointVerifyResult = VerifyResult;
export { sha256File };

/**
 * 校验 checkpoint 目录是否符合固定清单。
 * 返回问题列表；`ok` 仅在零问题时为 true。不抛异常（除 root 完全不存在外由问题列表表达）。
 *
 * `trustRoot`：HF 缓存请传 `models--org--repo/`（同 cache 根）。快照文件是指向同根 `blobs/<sha>`
 * 的 symlink，只有以 repo 缓存根为受信根才能正确判定「合法 blob 链接」而非「符号链接越界」。
 * `extraTrustRoots` / `trustRootBase`：同一自有 hub 缓存内的共享 `blobs/` 目录（见 `hfTrustRoots`）。
 */
export async function verifyCheckpointFiles(
	dir: string,
	files: LayaCheckpointFile[],
	opts: { hashFile?: (p: string) => Promise<string>; trustRoot?: string; extraTrustRoots?: string[]; trustRootBase?: string } = {},
): Promise<CheckpointVerifyResult> {
	return verifyPinnedFiles(dir, files, {
		hashFile: opts.hashFile,
		trustRoot: opts.trustRoot,
		extraTrustRoots: opts.extraTrustRoots,
		trustRootBase: opts.trustRootBase,
		assertManifest: (f) => assertSafeManifest(f as LayaCheckpointFile[]),
	});
}
