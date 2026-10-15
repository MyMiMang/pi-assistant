/**
 * 本地 Laya checkpoint 的**固定文件清单**（路径 / 大小 / SHA256），用于下载后完整性校验。
 *
 * 供应链原则：
 *  - 每个 checkpoint 的 revision 必须是 Laya 审核快照 `PINNED_REVISIONS` 里的 commit（见 manifest.ts）。
 *  - 大文件（`model.safetensors` / `tokenizer/tokenizer.json`）的 SHA256 直接取 HuggingFace **LFS oid**
 *    （`/api/models/<repo>/revision/<sha>?blobs=true` 的 `lfs.sha256`，公开、无需 Key、无需下载权重）；
 *  - 小文件（config / tokenizer_config / rl_agent_config 等）在**同一 revision** 下取回（几 KB）后本地算 SHA256。
 *  - 绝不用 `main` / `latest` 的哈希去套旧 revision；升级 revision 必须重算本表（测试会拦住不一致）。
 *  - 只允许 safetensors + tokenizer/config：清单里出现 `.py` / `.bin` / `.pt` / `.pth` 等一律判不安全，
 *    下载也只按本清单 `allow_patterns` 取文件，不执行 repo 内任何脚本（trust_remote_code=false）。
 *
 * 生成 / 复核：`npx tsx scripts/laya-checkpoint-digests.ts`（只读 HF 元数据 + 小文件，不下 GB 权重）。
 */

export interface LayaCheckpointFile {
	/** 相对 checkpoint 根目录的路径（POSIX 分隔符） */
	path: string;
	size: number;
	sha256: string;
}

/** 单个 checkpoint 的固定文件清单（顺序即校验顺序）。 */
export const LAYA_CHECKPOINT_FILES: Record<string, LayaCheckpointFile[]> = {
	"laya-multilingual": [
		{ path: ".gitattributes", size: 1580, sha256: "caf3ca02d5e883f643e939cbed54f94237f94c171797f0dfea5e25c7e33315b3" },
		{ path: "README.md", size: 9346, sha256: "e85d16c3fe35fe7094ef51a7cfa81144a5cc07558e5faddcff753a8153e38a0b" },
		{ path: "encoder/config.json", size: 1938, sha256: "83f6916d13ef0f556ac461f28308dc2bffa7ebeadee8ec9e2db5812020ea5bb4" },
		{ path: "model.safetensors", size: 643_835_514, sha256: "9d628fd971b700382ac6f65920a86f149777b2e748e0c955fb3b19695aa8f204" },
		{ path: "rl_agent_config.json", size: 472, sha256: "25061739243b617ad88d1219ba6f8a9c86c5881ca28df024fa2d9b3b2fcc30c6" },
		{ path: "tokenizer/tokenizer.json", size: 34_363_188, sha256: "609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f" },
		{ path: "tokenizer/tokenizer_config.json", size: 502, sha256: "424b69444bf7b5809dc2cd2e36d0bd71b8055124dd24274d6db3c655d38205e7" },
	],
	"laya-typed-decisions": [
		{ path: ".gitattributes", size: 1519, sha256: "11ad7efa24975ee4b0c3c3a38ed18737f0658a5f75a0a96787b576a78a023361" },
		{ path: "README.md", size: 6343, sha256: "83e67a995a70a9a9ef6cc1f8c68da654f11eee081c9bb14de07c37b08fcc3113" },
		{ path: "encoder/config.json", size: 2084, sha256: "5268d24ad3b77c8151de5dcb0762ba4391619aad9ab0bda33e36fb083cfeae6d" },
		{ path: "model.safetensors", size: 842_609_220, sha256: "4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e" },
		{ path: "rl_agent_config.json", size: 847, sha256: "ebf0cd524d92342a6be5e48e9fca3d7c2babfb5a56ccd79d2171ef5d8c7f7be8" },
		{ path: "tokenizer/tokenizer.json", size: 3_583_228, sha256: "6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30" },
		{ path: "tokenizer/tokenizer_config.json", size: 337, sha256: "08d4cf3ac4dca381759441b85b91a6d40e688471dcd33d15d6649eb0a9a854d1" },
	],
};

/** 取某个 checkpoint 的固定文件清单；未登记返回空数组（调用方应视为不可校验）。 */
export function checkpointFiles(id: string): LayaCheckpointFile[] {
	return LAYA_CHECKPOINT_FILES[id] ?? [];
}

/** 从文件清单算出 checkpoint 的期望总字节（界面显示 / 下载进度用）。 */
export function checkpointBytes(id: string): number {
	return checkpointFiles(id).reduce((n, f) => n + f.size, 0);
}

const FORBIDDEN_EXT = /\.(py|pyc|pth|pt|bin|ckpt|onnx|h5|pkl|pickle|so|dylib|dll|exe|sh|bat|ps1)$/i;

/**
 * 清单自检（不碰磁盘）：路径必须安全、digest 形状正确、不得含可执行 / 非 safetensors 权重文件。
 * 返回问题列表（空 = 安全）。纯函数，测试可直接构造非法清单验证。
 */
export function assertSafeManifest(files: LayaCheckpointFile[]): string[] {
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
		if (FORBIDDEN_EXT.test(rel)) problems.push(`清单含非 safetensors / 可执行文件：${rel}`);
		if (!Number.isInteger(f.size) || f.size < 0) problems.push(`大小非法：${rel}`);
		if (!/^[a-f0-9]{64}$/.test(f.sha256)) problems.push(`SHA256 形状非法：${rel}`);
	}
	if (!files.some((f) => f.path.endsWith(".safetensors"))) problems.push("缺少 safetensors 权重文件");
	if (!files.some((f) => /(^|\/)tokenizer(_config)?\.json$/.test(f.path))) problems.push("缺少 tokenizer 配置");
	return problems;
}
