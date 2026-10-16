/**
 * 本地 Laya 生产依赖里可离线验证的部分（fake HTTP / 临时目录 / 不碰 GPU / 不下载）。
 * 数据目录由 test/setup.ts 强制临时。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { findFreePort, layaRoot, readHealth } from "../src/local-laya/deps.ts";
import { hfRepoDir, hfSnapshotDir } from "../src/local-laya/hf-metadata.ts";

test("readHealth：带 Bearer 读 /health 详细字段；非 200 → ok:false（不抛）", async () => {
	let gotAuth = "";
	const srv = createServer((req, res) => {
		gotAuth = String(req.headers.authorization ?? "");
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ status: "ok", device: "cpu", loaded: ["multilingual"], checkpoint_devices: { multilingual: "cpu" }, cpu_fallbacks: { count: 2, last_reason: "oom" }, revisions: { multilingual: "e4e9" } }));
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const port = (srv.address() as { port: number }).port;
	const h = await readHealth(port, "sometoken");
	assert.equal(gotAuth, "Bearer sometoken");
	assert.equal(h.ok, true);
	assert.equal(h.device, "cpu");
	assert.equal(h.cpuFallbacks?.count, 2);
	assert.equal(h.cpuFallbacks?.lastReason, "oom");
	assert.deepEqual(h.loaded, ["multilingual"]);
	srv.close();
	// 停掉后再读 → 连接失败也必须是 ok:false，不把异常甩给调用方
	const dead = await readHealth(port, "x").catch(() => null);
	assert.ok(dead === null || dead.ok === false);
});

test("findFreePort：返回可用端口且可再次绑定", async () => {
	const port = await findFreePort();
	assert.ok(port > 0 && port < 65536);
	const srv = createServer();
	await new Promise<void>((r, j) => srv.on("error", j).listen(port, "127.0.0.1", r));
	srv.close();
});

test("uninstall：canonical 校验 —— 只删我们自己的 local-laya 目录，越界路径直接拒绝", async () => {
	const { createLayaDeps } = await import("../src/local-laya/deps.ts");
	const deps = createLayaDeps();
	assert.equal(layaRoot().endsWith("local-laya"), true);
	const outside = { ...deps.paths(), root: "/tmp/not-ours" };
	await assert.rejects(() => deps.uninstall(outside), /已拒绝/);
});

/** HF 缓存真实布局小夹具：blobs/<sha> 与 snapshots/<rev>/<path> → ../../blobs/<sha>。 */
function hfFixture(cp: { repo: string; revision: string }) {
	const hfHome = mkdtempSync(join(tmpdir(), "laya-prog-"));
	const repoDir = hfRepoDir(hfHome, cp.repo);
	const snap = hfSnapshotDir(hfHome, cp.repo, cp.revision);
	mkdirSync(join(repoDir, "blobs"), { recursive: true });
	mkdirSync(snap, { recursive: true });
	return { hfHome, repoDir, snap, blobs: join(repoDir, "blobs") };
}

test("checkpointProgressBytes：只计本 checkpoint 必需文件的 blob（含 .incomplete），不计别的 repo / 无关 blob", async () => {
	const { checkpointProgressBytes } = await import("../src/local-laya/deps.ts");
	const { LAYA_CHECKPOINTS } = await import("../src/local-laya/manifest.ts");
	const cp = LAYA_CHECKPOINTS["laya-multilingual"];
	const f = hfFixture(cp);
	try {
		const files = [
			{ path: "model.safetensors", size: 1000, sha256: "a".repeat(64) },
			{ path: "tokenizer/tokenizer.json", size: 500, sha256: "b".repeat(64) },
			{ path: "encoder/config.json", size: 10, sha256: "c".repeat(64) },
		];
		assert.equal(checkpointProgressBytes(f.hfHome, cp, files), 0, "什么都还没下 → 0");
		// 正在下载的 LF 大文件：blobs/<sha>.incomplete 的部分字节算进度
		writeFileSync(join(f.blobs, `${"a".repeat(64)}.incomplete`), Buffer.alloc(400));
		assert.equal(checkpointProgressBytes(f.hfHome, cp, files), 400);
		// 小文件没有被 `.incomplete` 命名（非 LFS），只算已完成 snapshot
		mkdirSync(join(f.snap, "encoder"), { recursive: true });
		writeFileSync(join(f.snap, "encoder", "config.json"), Buffer.alloc(10));
		assert.equal(checkpointProgressBytes(f.hfHome, cp, files), 410);
		// 完成后 blobs/<sha>（无 .incomplete）也算
		writeFileSync(join(f.blobs, "b".repeat(64)), Buffer.alloc(500));
		assert.equal(checkpointProgressBytes(f.hfHome, cp, files), 910);
		// 别的 repo / 无关 blob 的字节绝不算进本模型
		const other = hfFixture({ repo: "convaiinnovations/other-model", revision: "x" });
		writeFileSync(join(other.blobs, "d".repeat(64)), Buffer.alloc(999_999));
		writeFileSync(join(f.blobs, "e".repeat(64)), Buffer.alloc(88_888));
		assert.equal(checkpointProgressBytes(f.hfHome, cp, files), 910, "别 repo / 无关 blob 不得计入");
		rmSync(other.hfHome, { recursive: true, force: true });
	} finally {
		rmSync(f.hfHome, { recursive: true, force: true });
	}
});

test("checkpointProgressBytes：已缓存 snapshot 计满、`.incomplete` 超出清单大小按清单大小封顶（不报假比例）", async () => {
	const { checkpointProgressBytes } = await import("../src/local-laya/deps.ts");
	const { LAYA_CHECKPOINTS } = await import("../src/local-laya/manifest.ts");
	const cp = LAYA_CHECKPOINTS["laya-multilingual"];
	const f = hfFixture(cp);
	try {
		const files = [{ path: "model.safetensors", size: 1000, sha256: "f".repeat(64) }];
		// 已完成的 snapshot（symlink → blob）直接计满，不从 0 起（避免 0 → 100 的假闪）
		writeFileSync(join(f.blobs, "f".repeat(64)), Buffer.alloc(1000));
		symlinkSync(relative(dirname(join(f.snap, "model.safetensors")), join(f.blobs, "f".repeat(64))), join(f.snap, "model.safetensors"));
		assert.equal(checkpointProgressBytes(f.hfHome, cp, files), 1000);
		// 断点续传的 .incomplete 比清单还大（换源 / 脏文件）也不能超过分母
		rmSync(join(f.snap, "model.safetensors"));
		writeFileSync(join(f.blobs, `${"f".repeat(64)}.incomplete`), Buffer.alloc(2000));
		assert.equal(checkpointProgressBytes(f.hfHome, cp, files), 1000);
	} finally {
		rmSync(f.hfHome, { recursive: true, force: true });
	}
});

test("checkpointSourcePath / watchDirBytes：只认带必需文件的 weights 目录；目录字节可停止（取消 / 结束不留永久 timer）", async () => {
	const { checkpointSourcePath, watchDirBytes } = await import("../src/local-laya/deps.ts");
	const weights = mkdtempSync(join(tmpdir(), "laya-weights-"));
	const dir = mkdtempSync(join(tmpdir(), "laya-watch-"));
	try {
		assert.equal(checkpointSourcePath(weights), null, "没有必需文件 → null（不把 sidecar 指向空目录）");
		writeFileSync(join(weights, "rl_agent_config.json"), "{}");
		assert.equal(checkpointSourcePath(weights), weights);

		const seen: number[] = [];
		const stop = watchDirBytes([dir], (n) => seen.push(n), 20);
		writeFileSync(join(dir, "a.bin"), Buffer.alloc(4096));
		await new Promise((r) => setTimeout(r, 120));
		stop();
		assert.ok(seen.some((n) => n >= 4096), JSON.stringify(seen));
		const after = seen.length;
		writeFileSync(join(dir, "b.bin"), Buffer.alloc(4096));
		await new Promise((r) => setTimeout(r, 120));
		assert.equal(seen.length, after, "停止后不得再报");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(weights, { recursive: true, force: true });
	}
});
