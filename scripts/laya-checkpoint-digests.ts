/**
 * 复核本地 Laya checkpoint 的固定文件清单（大小 + SHA256）是否仍与公开 HF 元数据一致。
 *
 * 只读 HF 元数据 JSON（几 KB，公开无需 Key）+ 下载**非 LFS 小文件**（config / tokenizer_config，最多几十 KB）
 * 本地算 SHA256；大文件（model.safetensors / tokenizer.json）直接用元数据里的 LFS oid，**不下载 GB 权重**。
 *
 * 用法：npx tsx scripts/laya-checkpoint-digests.ts
 * 退出码：0 = 清单与 HF 一致；1 = 有漂移（需人工确认 revision / 重算清单，绝不用 main 哈希套旧 revision）。
 */
import { createHash } from "node:crypto";
import { LAYA_CHECKPOINTS } from "../packages/server/src/local-laya/manifest.ts";
import { checkpointFiles, type LayaCheckpointFile } from "../packages/server/src/local-laya/checkpoint-files.ts";
import { fetchHfSiblings } from "../packages/server/src/local-laya/hf-metadata.ts";

const MAX_INLINE = 50 * 1024 * 1024; // 非 LFS 文件超过此大小拒绝下载（防误拉权重）

async function sha256OfRemote(repo: string, revision: string, path: string): Promise<string> {
	const url = `https://huggingface.co/${repo}/resolve/${revision}/${path}`;
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok) throw new Error(`下载小文件失败：${url} HTTP ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length > MAX_INLINE) throw new Error(`${path} 超过 ${MAX_INLINE} 字节且不是 LFS，拒绝下载`);
	return createHash("sha256").update(buf).digest("hex");
}

function same(a: LayaCheckpointFile[], b: LayaCheckpointFile[]): boolean {
	if (a.length !== b.length) return false;
	const byPath = new Map(b.map((f) => [f.path, f]));
	return a.every((f) => {
		const o = byPath.get(f.path);
		return !!o && o.size === f.size && o.sha256 === f.sha256;
	});
}

let drift = false;
for (const [id, cp] of Object.entries(LAYA_CHECKPOINTS)) {
	const siblings = await fetchHfSiblings(cp.repo, cp.revision);
	const actual: LayaCheckpointFile[] = [];
	for (const s of siblings) {
		const digest = s.lfsSha256 ?? (await sha256OfRemote(cp.repo, cp.revision, s.path));
		actual.push({ path: s.path, size: s.size, sha256: digest });
	}
	const pinned = checkpointFiles(id);
	const ok = same(pinned, actual);
	drift = drift || !ok;
	console.log(`${ok ? "✅" : "❌"} ${id}@${cp.revision.slice(0, 12)} 文件 ${actual.length}（pin ${pinned.length}）`);
	if (!ok) {
		console.log(JSON.stringify(actual, null, 2));
	}
}
if (drift) {
	console.error("清单与 HF 元数据不一致：请确认 revision 是否仍是被审核的快照，再手动更新 checkpoint-files.ts");
	process.exit(1);
}
console.log("全部 checkpoint 与公开 HF 元数据一致。");
