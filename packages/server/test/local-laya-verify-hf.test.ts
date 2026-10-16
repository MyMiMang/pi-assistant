/**
 * 真实 HuggingFace 缓存形状回归：`snapshots/<rev>/<file>` 是指向 `../../blobs/<sha>` 的 symlink。
 *
 * 复现 beta.25 用户实报失败「权重校验未通过：符号链接越界：.gitattributes / README.md / encoder/config.json」：
 * 旧实现把受信根设成 snapshot 目录本身，把自控 cache 的合法 blob 链接误判为越界 → 每个文件都失败。
 * 这里用本地临时目录 + 相对 symlink 模拟两级 layout，证明：合法 blob 链接通过、逃出 cache 根 / 篡改大小哈希均拒。
 *
 * 全部临时目录 + 小文件，**不下载任何真实权重、不联网、不碰 GPU / 钥匙串 / 用户数据**。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { hfRepoDir, hfSnapshotDir } from "../src/local-laya/hf-metadata.ts";
import { verifyCheckpointFiles } from "../src/local-laya/verify.ts";
import { materializePinnedFiles, type PinnedFile } from "../src/managed-weights/verify.ts";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

interface Fixture {
	root: string;
	hfHome: string;
	repo: string;
	revision: string;
	snap: string;
	repoDir: string;
}

/** 按 HF 缓存真实布局落盘：blobs/<sha> 普通文件 + snapshots/<rev>/<path> → ../../blobs/<sha> 相对 symlink。 */
function makeHfCache(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "laya-hf-"));
	const hfHome = join(root, "hf");
	const repo = "convaiinnovations/laya-multilingual";
	const revision = "e4e9ddf21a7b1903b7acffd8814ad4307bf63a67";
	const repoDir = hfRepoDir(hfHome, repo);
	const snap = hfSnapshotDir(hfHome, repo, revision);
	const blobs = join(repoDir, "blobs");
	mkdirSync(blobs, { recursive: true });
	const entries: Array<[string, Buffer]> = [
		["model.safetensors", Buffer.from("fake-weights-0123456789")],
		["tokenizer/tokenizer.json", Buffer.from("fake-tokenizer")],
		["encoder/config.json", Buffer.from("{}")],
		[".gitattributes", Buffer.from("*.safetensors filter=lfs\n")],
		["README.md", Buffer.from("# fake card\n")],
	];
	for (const [rel, content] of entries) {
		const blob = join(blobs, sha(content));
		writeFileSync(blob, content);
		const dest = join(snap, rel);
		mkdirSync(dirname(dest), { recursive: true });
		symlinkSync(relative(dirname(dest), blob), dest); // ../../blobs/<sha>
	}
	return { root, hfHome, repo, revision, snap, repoDir };
}

function manifestOf(f: Fixture): PinnedFile[] {
	const read = (rel: string) => readFileSync(join(f.snap, rel), "utf8");
	return [
		{ path: ".gitattributes", size: read(".gitattributes").length, sha256: sha(read(".gitattributes")), optional: true },
		{ path: "README.md", size: read("README.md").length, sha256: sha(read("README.md")), optional: true },
		{ path: "encoder/config.json", size: read("encoder/config.json").length, sha256: sha(read("encoder/config.json")) },
		{ path: "model.safetensors", size: read("model.safetensors").length, sha256: sha(read("model.safetensors")) },
		{ path: "tokenizer/tokenizer.json", size: read("tokenizer/tokenizer.json").length, sha256: sha(read("tokenizer/tokenizer.json")) },
	];
}

test("HF 缓存真实布局：受信根=repo 缓存根 → 快照 symlink 全部通过（beta.25 回归）", async () => {
	const f = makeHfCache();
	try {
		const files = manifestOf(f);
		// 旧行为（受信根=snapshot 目录）：全部误报「符号链接越界」——这就是用户看到的失败。
		const legacy = await verifyCheckpointFiles(f.snap, files);
		assert.equal(legacy.ok, false);
		assert.ok(legacy.problems.some((p) => p.includes("符号链接越界")), JSON.stringify(legacy.problems));

		// 修复后（受信根=同 cache 根的 repo 目录）：合法 blob 链接通过。
		const fixed = await verifyCheckpointFiles(f.snap, files, { trustRoot: f.repoDir });
		assert.equal(fixed.ok, true, JSON.stringify(fixed.problems));
		assert.equal(fixed.checked, files.length);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("HF 布局下 symlink 逃出 cache 根 → 拒绝（不因放行 blob 链接而放开任意路径）", async () => {
	const f = makeHfCache();
	const outside = mkdtempSync(join(tmpdir(), "laya-outside-"));
	try {
		writeFileSync(join(outside, "secret.bin"), "user-secret");
		rmSync(join(f.snap, "model.safetensors"));
		symlinkSync(join(outside, "secret.bin"), join(f.snap, "model.safetensors")); // 绝对路径跳出 cache
		const files = manifestOf(f).map((x) => (x.path === "model.safetensors" ? { ...x, size: "user-secret".length, sha256: sha("user-secret") } : x));
		const res = await verifyCheckpointFiles(f.snap, files, { trustRoot: f.repoDir });
		assert.equal(res.ok, false);
		assert.ok(res.problems.some((p) => p.includes("符号链接越界：model.safetensors")), JSON.stringify(res.problems));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("HF 布局下篡改内容（大小 / SHA256）→ 拒绝", async () => {
	const f = makeHfCache();
	try {
		const files = manifestOf(f);
		// 换掉 model.safetensors 的 blob 内容（仍指向 blob，但摘要不符）→ SHA256 不符
		const blobDir = join(f.repoDir, "blobs");
		const bad = Buffer.from("tampered-weights-XXXXXX");
		writeFileSync(join(blobDir, sha(bad)), bad);
		rmSync(join(f.snap, "model.safetensors"));
		symlinkSync(relative(f.snap, join(blobDir, sha(bad))), join(f.snap, "model.safetensors"));
		const badHash = await verifyCheckpointFiles(f.snap, files, { trustRoot: f.repoDir });
		assert.equal(badHash.ok, false);
		assert.ok(badHash.problems.some((p) => p.includes("大小不符：model.safetensors") || p.includes("SHA256 不符：model.safetensors")), JSON.stringify(badHash.problems));

		// 恢复到正确内容后只改期望大小 → 大小不符
		const good = Buffer.from("fake-weights-0123456789");
		rmSync(join(f.snap, "model.safetensors"));
		symlinkSync(relative(f.snap, join(blobDir, sha(good))), join(f.snap, "model.safetensors"));
		const wrongSize = files.map((x) => (x.path === "model.safetensors" ? { ...x, size: x.size + 7 } : x));
		const res = await verifyCheckpointFiles(f.snap, wrongSize, { trustRoot: f.repoDir });
		assert.equal(res.ok, false);
		assert.ok(res.problems.some((p) => p.includes("大小不符：model.safetensors")), JSON.stringify(res.problems));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("辅助文件（README / .gitattributes）缺失不算失败；必需文件仍逐个校验", async () => {
	const f = makeHfCache();
	try {
		const files = manifestOf(f);
		rmSync(join(f.snap, "README.md"));
		rmSync(join(f.snap, ".gitattributes"));
		// 缺失的 optional 被跳过，必需文件齐全 → ok
		const okRes = await verifyCheckpointFiles(f.snap, files, { trustRoot: f.repoDir });
		assert.equal(okRes.ok, true, JSON.stringify(okRes.problems));
		assert.equal(okRes.checked, 3, "只计入存在的必需文件（也含存在的辅助文件）");

		// 必需文件缺失 → 仍失败（matter 的是 encoder/config.json 与权重逐个校验，不放弃）
		rmSync(join(f.snap, "encoder/config.json"));
		const missingRequired = await verifyCheckpointFiles(f.snap, files, { trustRoot: f.repoDir });
		assert.equal(missingRequired.ok, false);
		assert.ok(missingRequired.problems.some((p) => p.includes("缺少文件：encoder/config.json")), JSON.stringify(missingRequired.problems));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("物化 staging：只写必需文件为普通文件，哈希 / 大小复核通过；篡改源则失败", async () => {
	const f = makeHfCache();
	const staging = mkdtempSync(join(tmpdir(), "laya-stage-"));
	try {
		const files = manifestOf(f);
		const mat = await materializePinnedFiles(f.snap, staging, files, { trustRoot: f.repoDir });
		assert.equal(mat.ok, true, JSON.stringify(mat.problems));
		// 只物化必需文件（optional 跳过）
		assert.deepEqual([...mat.written].sort(), ["encoder/config.json", "model.safetensors", "tokenizer/tokenizer.json"]);
		// 物化结果是普通文件（不是 symlink），内容与哈希一致
		const st = lstatSync(join(staging, "model.safetensors"));
		assert.equal(st.isSymbolicLink(), false, "物化后必须是普通文件");
		assert.equal(sha(readFileSync(join(staging, "model.safetensors"))), sha("fake-weights-0123456789"));

		// 篡改期望摘要 → 物化复核不通过，不产生半成品
		const bad = files.map((x) => (x.path === "model.safetensors" ? { ...x, sha256: "0".repeat(64) } : x));
		const matBad = await materializePinnedFiles(f.snap, staging, bad, { trustRoot: f.repoDir });
		assert.equal(matBad.ok, false);
		assert.ok(matBad.problems.some((p) => p.includes("物化后 SHA256 不符：model.safetensors")), JSON.stringify(matBad.problems));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
		rmSync(staging, { recursive: true, force: true });
	}
});
