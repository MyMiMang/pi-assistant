/**
 * Laya 权重完整性校验：用临时目录里的**假文件**（bitflip / 缺文件 / 大小不符 / symlink 逃逸）与本地 HTTP fixture，
 * 不下载任何真实权重、不装 venv、不碰 GPU / 钥匙串。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertSafeManifest, checkpointFiles, type LayaCheckpointFile } from "../src/local-laya/checkpoint-files.ts";
import { parseHfSiblings, fetchHfSiblings, hfSnapshotDir } from "../src/local-laya/hf-metadata.ts";
import { verifyCheckpointFiles } from "../src/local-laya/verify.ts";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function file(path: string, content: Buffer | string): LayaCheckpointFile {
	const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
	return { path, size: buf.length, sha256: sha(buf) };
}

function makeDir(): string {
	return mkdtempSync(join(tmpdir(), "laya-verify-"));
}

test("verifyCheckpointFiles：全部匹配 → ok，且大小 / 哈希都对", async () => {
	const d = makeDir();
	try {
		mkdirSync(join(d, "encoder"), { recursive: true });
		mkdirSync(join(d, "tokenizer"), { recursive: true });
		const files = [file("encoder/config.json", "{}"), file("model.safetensors", "weights-1"), file("tokenizer/tokenizer.json", "tok")];
		for (const f of files) writeFileSync(join(d, f.path), f.path === "model.safetensors" ? "weights-1" : f.path.endsWith("config.json") ? "{}" : "tok");
		const res = await verifyCheckpointFiles(d, files);
		assert.equal(res.ok, true);
		assert.equal(res.checked, 3);
		assert.equal(res.bytes, files.reduce((n, f) => n + f.size, 0));
		assert.deepEqual(res.problems, []);
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});

test("verifyCheckpointFiles：bitflip / 缺文件 / 大小不符 → 全部判失败，不 ok", async () => {
	const d = makeDir();
	try {
		mkdirSync(join(d, "encoder"), { recursive: true });
		mkdirSync(join(d, "tokenizer"), { recursive: true });
		const good = [file("encoder/config.json", "{}"), file("model.safetensors", "weights-1"), file("tokenizer/tokenizer.json", "tok")];
		writeFileSync(join(d, "encoder/config.json"), "[]"); // 与 "{}" 同大小但内容不同 → SHA256 不符
		writeFileSync(join(d, "model.safetensors"), "weights-1X"); // 大小不符
		// tokenizer/tokenizer.json 故意不写 → 缺文件
		const res = await verifyCheckpointFiles(d, good);
		assert.equal(res.ok, false);
		assert.ok(res.problems.some((p) => p.includes("SHA256 不符：encoder/config.json")));
		assert.ok(res.problems.some((p) => p.includes("大小不符：model.safetensors")));
		assert.ok(res.problems.some((p) => p.includes("缺少文件：tokenizer/tokenizer.json")));
		assert.equal(res.checked, 0);
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});

test("verifyCheckpointFiles：symlink 指向目录外 → 拒绝；指向目录内 → 允许", async () => {
	const d = makeDir();
	const outside = makeDir();
	try {
		writeFileSync(join(outside, "evil.bin"), "x");
		// 越界 symlink
		symlinkSync(join(outside, "evil.bin"), join(d, "model.safetensors"));
		const escape = [file("model.safetensors", "x"), file("tokenizer/tokenizer.json", "tok")];
		const bad = await verifyCheckpointFiles(d, escape);
		assert.equal(bad.ok, false);
		assert.ok(bad.problems.some((p) => p.includes("符号链接越界")), JSON.stringify(bad.problems));

		// 目录内 symlink（HF 缓存快照就是这种）→ 允许
		rmSync(join(d, "model.safetensors"));
		mkdirSync(join(d, "blobs"), { recursive: true });
		mkdirSync(join(d, "tokenizer"), { recursive: true });
		writeFileSync(join(d, "blobs", "real"), "hello");
		writeFileSync(join(d, "tokenizer", "tokenizer.json"), "tok");
		symlinkSync(join(d, "blobs", "real"), join(d, "model.safetensors"));
		const ok = await verifyCheckpointFiles(d, [file("model.safetensors", "hello"), file("tokenizer/tokenizer.json", "tok")]);
		assert.equal(ok.ok, true, JSON.stringify(ok.problems));
	} finally {
		rmSync(d, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("assertSafeManifest：拒绝越界路径 / 可执行文件 / 缺 tokenizer / 非法摘要", () => {
	const bad: LayaCheckpointFile[] = [
		{ path: "../escape.json", size: 1, sha256: "a".repeat(64) },
		{ path: "run.py", size: 1, sha256: "b".repeat(64) },
		{ path: "weights.bin", size: 1, sha256: "not-a-digest" },
	];
	const problems = assertSafeManifest(bad);
	assert.ok(problems.some((p) => p.includes("不安全的相对路径")));
	assert.ok(problems.some((p) => p.includes("可执行")));
	assert.ok(problems.some((p) => p.includes("SHA256 形状非法")));
	assert.ok(problems.some((p) => p.includes("缺少 safetensors")));
	assert.ok(problems.some((p) => p.includes("缺少 tokenizer")));
	// 真实清单必须自洽且只含 safetensors / tokenizer
	for (const id of ["laya-multilingual", "laya-typed-decisions"]) {
		assert.deepEqual(assertSafeManifest(checkpointFiles(id)), [], id);
		assert.ok(checkpointFiles(id).some((f) => f.path.endsWith(".safetensors")), id);
	}
});

test("verifyCheckpointFiles：清单里越界路径被跳过，不读盘也不 ok", async () => {
	const d = makeDir();
	try {
		const res = await verifyCheckpointFiles(d, [{ path: "../outside.json", size: 0, sha256: "0".repeat(64) }]);
		assert.equal(res.ok, false);
		assert.ok(res.problems.some((p) => p.includes("不安全的相对路径")));
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});

test("HF 元数据：本地 fixture 解析出路径 / 大小 / LFS oid；非 200 直接抛错", async () => {
	const payload = {
		siblings: [
			{ rfilename: "encoder/config.json", size: 1938 },
			{ rfilename: "model.safetensors", size: 643835514, lfs: { sha256: "9d628fd9" + "0".repeat(56) } },
			{ rfilename: "", size: 1 },
		],
	};
	const parsed = parseHfSiblings(payload);
	assert.equal(parsed.length, 2);
	assert.deepEqual(parsed[0], { path: "encoder/config.json", size: 1938, lfsSha256: null });
	assert.equal(parsed[1].lfsSha256?.length, 64);
	assert.deepEqual(parseHfSiblings({}), []);
	assert.equal(hfSnapshotDir("/hf", "convaiinnovations/laya-multilingual", "abc"), "/hf/hub/models--convaiinnovations--laya-multilingual/snapshots/abc");

	const srv = createServer((req, res) => {
		if (String(req.url).includes("good")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(payload));
		} else {
			res.writeHead(404);
			res.end("nope");
		}
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const port = (srv.address() as { port: number }).port;
	const fakeFetch = ((url: string) => fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`)) as unknown as typeof fetch;
	const got = await fetchHfSiblings("convaiinnovations/laya-multilingual", "good", fakeFetch);
	assert.equal(got.length, 2);
	await assert.rejects(() => fetchHfSiblings("convaiinnovations/laya-multilingual", "bad", fakeFetch), /HTTP 404/);
	srv.close();
});
