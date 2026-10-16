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
import { hfHubDir, hfRepoDir, hfSharedBlobsDir, hfSnapshotDir, hfTrustRoots } from "../src/local-laya/hf-metadata.ts";
import { verifyCheckpointFiles } from "../src/local-laya/verify.ts";
import { containedIn, isSafeRelPath, materializePinnedFiles, pathInsideRoot, verifyPinnedFiles, type PinnedFile } from "../src/managed-weights/verify.ts";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

interface Fixture {
	root: string;
	hfHome: string;
	repo: string;
	revision: string;
	snap: string;
	repoDir: string;
	hub: string;
	hubBlobs: string;
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
	return { root, hfHome, repo, revision, snap, repoDir, hub: hfHubDir(hfHome), hubBlobs: hfSharedBlobsDir(hfHome) };
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

/* ============================================================
 * 产品安装会遇到的缓存形态矩阵（离线小文件夹具，不下载 GB 权重）
 * ============================================================ */

const REPO = "convaiinnovations/laya-multilingual";
const REV = "e4e9ddf21a7b1903b7acffd8814ad4307bf63a67";

/** 真实清单里的两类大文件：在本机已观察到的缓存里经两层链接落到自有 hub 共享 blobs。 */
const NESTED_BIG = new Set(["model.safetensors", "tokenizer/tokenizer.json"]);

interface Entry {
	path: string;
	content: string;
	optional?: boolean;
}

const ENTRIES: Entry[] = [
	{ path: "model.safetensors", content: "fake-weights-0123456789" },
	{ path: "tokenizer/tokenizer.json", content: "fake-tokenizer" },
	{ path: "encoder/config.json", content: "{}" },
	{ path: ".gitattributes", content: "*.safetensors filter=lfs\n", optional: true },
	{ path: "README.md", content: "# fake card\n", optional: true },
];

function manifestFrom(entries: Entry[]): PinnedFile[] {
	return entries.map((e) => ({ path: e.path, size: Buffer.byteLength(e.content), sha256: sha(e.content), optional: e.optional }));
}

/** 形态 B：大文件是自有 hub 缓存下的共享 blob（`snap → repo/blobs/<sha> → hub/blobs/<aa>/<hash>`）。 */
function makeHfCacheNested(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "laya-hf-nested-"));
	const hfHome = join(root, "hf");
	const hub = hfHubDir(hfHome);
	const hubBlobs = hfSharedBlobsDir(hfHome);
	const repoDir = hfRepoDir(hfHome, REPO);
	const snap = hfSnapshotDir(hfHome, REPO, REV);
	const repoBlobs = join(repoDir, "blobs");
	mkdirSync(repoBlobs, { recursive: true });
	for (const e of ENTRIES) {
		const h = sha(e.content);
		const dest = join(snap, e.path);
		mkdirSync(dirname(dest), { recursive: true });
		if (NESTED_BIG.has(e.path)) {
			const blob = join(hubBlobs, h.slice(0, 2), h); // hub/blobs/<aa>/<hash> 普通文件
			mkdirSync(dirname(blob), { recursive: true });
			writeFileSync(blob, e.content);
			const link = join(repoBlobs, h);
			symlinkSync(relative(repoBlobs, blob), link); // repo/blobs/<sha> → ../../blobs/<aa>/<hash>
			symlinkSync(relative(dirname(dest), link), dest);
		} else {
			const blob = join(repoBlobs, h);
			writeFileSync(blob, e.content); // 小文件：repo/blobs/<sha> 普通文件
			symlinkSync(relative(dirname(dest), blob), dest);
		}
	}
	return { root, hfHome, repo: REPO, revision: REV, snap, repoDir, hub, hubBlobs };
}

/** 形态 A：新装 / 已解包，snapshot 目录里就是普通文件（无 symlink）。 */
function makeHfCachePlain(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "laya-hf-plain-"));
	const hfHome = join(root, "hf");
	const repoDir = hfRepoDir(hfHome, REPO);
	const snap = hfSnapshotDir(hfHome, REPO, REV);
	for (const e of ENTRIES) {
		const dest = join(snap, e.path);
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, e.content);
	}
	return { root, hfHome, repo: REPO, revision: REV, snap, repoDir, hub: hfHubDir(hfHome), hubBlobs: hfSharedBlobsDir(hfHome) };
}

test("形态 A（普通文件，无 symlink）→ 校验通过；不需要任何 symlink 特例", async () => {
	const f = makeHfCachePlain();
	try {
		const files = manifestFrom(ENTRIES);
		const res = await verifyCheckpointFiles(f.snap, files, hfTrustRoots(f.hfHome, REPO));
		assert.equal(res.ok, true, JSON.stringify(res.problems));
		assert.equal(res.checked, ENTRIES.length);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("形态 B（共享 blob 两层 symlink）：只把 repo 当受信根时只有大文件越界；承认自有 hub 缓存后全部通过", async () => {
	const f = makeHfCacheNested();
	const staging = mkdtempSync(join(tmpdir(), "laya-stage-nested-"));
	try {
		const files = manifestFrom(ENTRIES);
		// beta.26 行为（受信根只有 repo 目录）：小文件通过，两个大文件因第二层跳到 hub/blobs 被误报越界 ——
		// 这正是「产品安装校验遗漏了真实可出现的缓存布局」，不是某一台机器的特殊配置。
		const repoOnly = await verifyCheckpointFiles(f.snap, files, { trustRoot: f.repoDir });
		assert.equal(repoOnly.ok, false, JSON.stringify(repoOnly.problems));
		assert.deepEqual([...repoOnly.problems].sort(), ["符号链接越界：model.safetensors", "符号链接越界：tokenizer/tokenizer.json"]);
		// 修后：把自有 hub 缓存内的共享 blobs 也登记成受信根 → 全部通过。
		const trust = hfTrustRoots(f.hfHome, REPO);
		const res = await verifyCheckpointFiles(f.snap, files, trust);
		assert.equal(res.ok, true, JSON.stringify(res.problems));
		assert.equal(res.checked, ENTRIES.length);
		// 物化后是普通文件，内容等于共享 blob 原文（运行时就加载这些文件）。
		const mat = await materializePinnedFiles(f.snap, staging, files, trust);
		assert.equal(mat.ok, true, JSON.stringify(mat.problems));
		assert.deepEqual([...mat.written].sort(), ["encoder/config.json", "model.safetensors", "tokenizer/tokenizer.json"]);
		assert.equal(lstatSync(join(staging, "model.safetensors")).isSymbolicLink(), false);
		assert.equal(readFileSync(join(staging, "model.safetensors"), "utf8"), "fake-weights-0123456789");
	} finally {
		rmSync(f.root, { recursive: true, force: true });
		rmSync(staging, { recursive: true, force: true });
	}
});

test("缓存命中重试：同一份共享 blob 缓存上重复校验 / 物化都成功（复用缓存，不逼重下）", async () => {
	const f = makeHfCacheNested();
	const staging = mkdtempSync(join(tmpdir(), "laya-stage-retry-"));
	try {
		const files = manifestFrom(ENTRIES);
		const trust = hfTrustRoots(f.hfHome, REPO);
		for (let i = 0; i < 2; i += 1) {
			const res = await verifyCheckpointFiles(f.snap, files, trust);
			assert.equal(res.ok, true, `第 ${i + 1} 次校验：${JSON.stringify(res.problems)}`);
			const mat = await materializePinnedFiles(f.snap, staging, files, trust);
			assert.equal(mat.ok, true, `第 ${i + 1} 次物化：${JSON.stringify(mat.problems)}`);
		}
		// 校验 / 物化全程不动缓存：大文件仍是共享 blob 的普通文件。
		assert.equal(lstatSync(join(f.hubBlobs, sha("fake-weights-0123456789").slice(0, 2), sha("fake-weights-0123456789"))).isFile(), true);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
		rmSync(staging, { recursive: true, force: true });
	}
});

test("断链 / 缺 blob：报「符号链接断链（目标缺失）」，与真外跳「越界」分开；optional 断链不算失败", async () => {
	const f = makeHfCacheNested();
	try {
		const files = manifestFrom(ENTRIES);
		const trust = hfTrustRoots(f.hfHome, REPO);
		const bigHash = sha("fake-weights-0123456789");
		// 删掉共享 blob（缓存残缺）→ 两层 symlink 断链，但绝不能被当成「想读缓存外」。
		rmSync(join(f.hubBlobs, bigHash.slice(0, 2), bigHash));
		const dangling = await verifyCheckpointFiles(f.snap, files, trust);
		assert.equal(dangling.ok, false);
		assert.ok(dangling.problems.some((p) => p.includes("符号链接断链（目标缺失）：model.safetensors")), JSON.stringify(dangling.problems));
		assert.ok(!dangling.problems.some((p) => p.includes("越界")), JSON.stringify(dangling.problems));
		// optional 文件断链：跳过，不算失败（恢复必需文件的 blob）。
		writeFileSync(join(f.hubBlobs, bigHash.slice(0, 2), bigHash), "fake-weights-0123456789");
		const readmeHash = sha("# fake card\n");
		rmSync(join(f.repoDir, "blobs", readmeHash));
		const okAfterOptionalGone = await verifyCheckpointFiles(f.snap, files, trust);
		assert.equal(okAfterOptionalGone.ok, true, JSON.stringify(okAfterOptionalGone.problems));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("恶意缓存外跳：snapshot / repo blob / hub blobs 根本身被换到缓存外 → 全部拒绝", async () => {
	const outside = mkdtempSync(join(tmpdir(), "laya-evil-"));
	try {
		writeFileSync(join(outside, "secret.bin"), "user-secret");
		// (1) snapshot 直接绝对路径跳出
		const f1 = makeHfCacheNested();
		try {
			const files = manifestFrom(ENTRIES);
			rmSync(join(f1.snap, "model.safetensors"));
			symlinkSync(join(outside, "secret.bin"), join(f1.snap, "model.safetensors"));
			const res = await verifyCheckpointFiles(f1.snap, files, hfTrustRoots(f1.hfHome, REPO));
			assert.equal(res.ok, false);
			assert.ok(res.problems.some((p) => p.includes("符号链接越界：model.safetensors")), JSON.stringify(res.problems));
		} finally {
			rmSync(f1.root, { recursive: true, force: true });
		}
		// (2) repo/blobs/<sha> 跳到缓存外
		const f2 = makeHfCacheNested();
		try {
			const files = manifestFrom(ENTRIES);
			const h = sha("fake-weights-0123456789");
			rmSync(join(f2.repoDir, "blobs", h));
			symlinkSync(join(outside, "secret.bin"), join(f2.repoDir, "blobs", h));
			const res = await verifyCheckpointFiles(f2.snap, files, hfTrustRoots(f2.hfHome, REPO));
			assert.equal(res.ok, false);
			assert.ok(res.problems.some((p) => p.includes("符号链接越界：model.safetensors")), JSON.stringify(res.problems));
		} finally {
			rmSync(f2.root, { recursive: true, force: true });
		}
		// (3) 共享 blobs 根本身被换成指向缓存外的 symlink → 受信根自身越界，fail closed
		const root3 = mkdtempSync(join(tmpdir(), "laya-evil-root-"));
		try {
			const hfHome = join(root3, "hf");
			const hub = hfHubDir(hfHome);
			mkdirSync(hub, { recursive: true });
			symlinkSync(outside, hfSharedBlobsDir(hfHome));
			const repoDir = hfRepoDir(hfHome, REPO);
			const snap = hfSnapshotDir(hfHome, REPO, REV);
			mkdirSync(snap, { recursive: true });
			const h = sha("fake-weights-0123456789");
			mkdirSync(join(repoDir, "blobs"), { recursive: true });
			writeFileSync(join(outside, h), "fake-weights-0123456789");
			symlinkSync(join(outside, h), join(repoDir, "blobs", h));
			symlinkSync(relative(snap, join(repoDir, "blobs", h)), join(snap, "model.safetensors"));
			const res = await verifyCheckpointFiles(snap, [{ path: "model.safetensors", size: 22, sha256: h }], hfTrustRoots(hfHome, REPO));
			assert.equal(res.ok, false);
			assert.ok(res.problems.some((p) => p.includes("受信根越出自有缓存")), JSON.stringify(res.problems));
			assert.ok(!res.problems.some((p) => p.includes("SHA256 不符")), "不能真的把缓存外文件当合法权重读成功");
		} finally {
			rmSync(root3, { recursive: true, force: true });
		}
	} finally {
		rmSync(outside, { recursive: true, force: true });
	}
});

test("同前缀兄弟路径逃逸：hub/blobs-evil 不能被当成 hub/blobs", async () => {
	const root = mkdtempSync(join(tmpdir(), "laya-sibling-"));
	try {
		const hfHome = join(root, "hf");
		const repoDir = hfRepoDir(hfHome, REPO);
		const snap = hfSnapshotDir(hfHome, REPO, REV);
		mkdirSync(join(repoDir, "blobs"), { recursive: true });
		mkdirSync(snap, { recursive: true });
		const content = "fake-weights-0123456789";
		const h = sha(content);
		// 与 hub/blobs 共享前缀的兄弟目录：只有边界判断正确才会被拒。
		const evil = join(hfHubDir(hfHome), "blobs-evil", h.slice(0, 2));
		mkdirSync(evil, { recursive: true });
		writeFileSync(join(evil, h), content);
		const link = join(repoDir, "blobs", h);
		symlinkSync(relative(join(repoDir, "blobs"), join(evil, h)), link);
		symlinkSync(relative(snap, link), join(snap, "model.safetensors"));
		const res = await verifyCheckpointFiles(snap, [{ path: "model.safetensors", size: Buffer.byteLength(content), sha256: h }], hfTrustRoots(hfHome, REPO));
		assert.equal(res.ok, false);
		assert.ok(res.problems.some((p) => p.includes("符号链接越界：model.safetensors")), JSON.stringify(res.problems));
		assert.ok(!containedIn(join(hfHubDir(hfHome), "blobs"), join(evil, h)), "兄弟前缀目录必须在根边界外");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("坏 SHA / 坏大小（共享 blob 被篡改）→ 拒绝，绝不 activate", async () => {
	const f = makeHfCacheNested();
	try {
		const files = manifestFrom(ENTRIES);
		const trust = hfTrustRoots(f.hfHome, REPO);
		const h = sha("fake-weights-0123456789");
		// 同长度篡改 → SHA256 不符
		writeFileSync(join(f.hubBlobs, h.slice(0, 2), h), "tampered-weights-XXXXXX");
		const badSha = await verifyCheckpointFiles(f.snap, files, trust);
		assert.equal(badSha.ok, false);
		assert.ok(badSha.problems.some((p) => p.includes("SHA256 不符：model.safetensors")), JSON.stringify(badSha.problems));
		// 恢复内容后只改期望大小 → 大小不符
		writeFileSync(join(f.hubBlobs, h.slice(0, 2), h), "fake-weights-0123456789");
		const wrongSize = files.map((x) => (x.path === "model.safetensors" ? { ...x, size: x.size + 7 } : x));
		const res = await verifyCheckpointFiles(f.snap, wrongSize, trust);
		assert.equal(res.ok, false);
		assert.ok(res.problems.some((p) => p.includes("大小不符：model.safetensors")), JSON.stringify(res.problems));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("缺文件（清单必需但缓存里没有）→ 报「缺少文件」，不是越界", async () => {
	const f = makeHfCacheNested();
	try {
		const files = manifestFrom(ENTRIES);
		rmSync(join(f.snap, "encoder/config.json"));
		const res = await verifyCheckpointFiles(f.snap, files, hfTrustRoots(f.hfHome, REPO));
		assert.equal(res.ok, false);
		assert.ok(res.problems.some((p) => p.includes("缺少文件：encoder/config.json")), JSON.stringify(res.problems));
		assert.ok(!res.problems.some((p) => p.includes("越界")), JSON.stringify(res.problems));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

/* ============================================================
 * 跨平台路径规则（纯字符串 / 纯函数，离线；不宣称 Windows 实机跑过）
 * ============================================================ */

test("清单路径安全：POSIX 绝对 + Windows 盘符 / UNC / `..` 段都判不安全；普通相对路径安全", () => {
	for (const bad of ["", "/abs/x", "C:/Windows/System32", "C:x", "\\\\server\\share\\f", "a/../../b", "a//b", "./a", "..", "x/./y", "x/..", "a\0b"]) {
		assert.equal(isSafeRelPath(bad), false, `应判不安全：${JSON.stringify(bad)}`);
	}
	for (const good of ["model.safetensors", "tokenizer/tokenizer.json", "encoder/config.json", "..foo", "a/..b/c"]) {
		assert.equal(isSafeRelPath(good), true, `应判安全：${good}`);
	}
});

test("受信根边界：`..foo` 不算逃逸、兄弟前缀目录算逃逸、跨盘符算逃逸", () => {
	assert.equal(containedIn("/root", "/root/x"), true);
	assert.equal(containedIn("/root", "/root"), true);
	assert.equal(containedIn("/root", "/root2/x"), false);
	assert.equal(containedIn("/root", "/root/..foo/x"), true);
	assert.equal(containedIn("/root/blobs", "/root/blobs-evil/f"), false);
	// Windows：跨盘符时 path.relative 返回绝对路径，绝不能因此被判「在根内」。
	assert.equal(containedIn("C:\\root", "C:\\root\\x"), true);
	assert.equal(containedIn("C:\\root", "D:\\x"), false);
	assert.equal(containedIn("C:\\root", "C:\\root2\\x"), false);
	// pathInsideRoot 对不存在 / 断链路径 fail closed
	assert.equal(pathInsideRoot("/definitely/not/here", "/definitely/not/here/x"), false);
});

test("清单自检拒绝 Windows 绝对路径条目（离线规则，避免把系统文件当成权重去读）", async () => {
	const f = makeHfCacheNested();
	try {
		const files: PinnedFile[] = [...manifestFrom(ENTRIES), { path: "C:\\Windows\\System32\\config", size: 1, sha256: sha("x") }];
		const res = await verifyPinnedFiles(f.snap, files, { trustRoot: f.repoDir });
		assert.equal(res.ok, false);
		assert.ok(res.problems.some((p) => p.includes("不安全的相对路径")), JSON.stringify(res.problems));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});