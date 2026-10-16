/**
 * 本地 SenseVoice 权重的清单自检与校验（基于共享的 `managed-weights/verify.ts`）。
 *
 * SenseVoice 的清单只有 ONNX 模型 + token 表：
 *  - 允许 `.onnx`（与 Laya 的 safetensors-only 规则不同，故这里用自己的 assertManifest）；
 *  - 仍然禁止一切脚本 / 可执行 / 其他权重格式（不执行 repo 内任何脚本，`trust_remote_code` 无关）。
 */
import { assertSafePinnedFiles, verifyPinnedFiles, type PinnedFile, type VerifyResult } from "../managed-weights/verify.ts";
import type { AsrWeightFile } from "./manifest.ts";
import { assertNoExecutableWeights } from "./runner.ts";

/** SenseVoice 清单自检（兼容旧调用）：路径安全 + 只允许 onnx 权重与 tokens 表。 */
export function assertSafeAsrManifest(files: PinnedFile[]): string[] {
	const problems = [...assertSafePinnedFiles(files), ...assertNoExecutableWeights(files)];
	const seen = new Set(files.map((f) => String(f.path).replace(/\\/g, "/")));
	if (![...seen].some((p) => p.endsWith(".onnx"))) problems.push("缺少 onnx 模型文件");
	if (![...seen].some((p) => /(^|\/)tokens\.txt$/.test(p))) problems.push("缺少 tokens.txt");
	return problems;
}

/**
 * 校验权重目录；`ok` 仅在零问题时为 true。
 * `assertManifest` = 运行族自己的规则（见 runner.ts）；不传则回退到 SenseVoice 规则。
 */
export async function verifyAsrWeights(
	dir: string,
	files: AsrWeightFile[],
	opts: { hashFile?: (p: string) => Promise<string>; signal?: AbortSignal; assertManifest?: (files: PinnedFile[]) => string[] } = {},
): Promise<VerifyResult> {
	if (opts.signal?.aborted) throw new Error("已取消");
	return verifyPinnedFiles(dir, files, { hashFile: opts.hashFile, assertManifest: opts.assertManifest ?? assertSafeAsrManifest });
}
