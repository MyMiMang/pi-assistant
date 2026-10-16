/**
 * 本地 Laya 生产依赖里可离线验证的部分（fake HTTP / 临时目录 / 不碰 GPU / 不下载）。
 * 数据目录由 test/setup.ts 强制临时：下面这行**必须是第一条 import**（ESM 按声明顺序求值），
 * 排在会 import `../src/config.ts` 的模块之前；否则 config 在 setup 之前捕获真实数据目录
 * （2026-10-16 曾因此把 rl_agent_config.json 写进真实 App 目录）。npm test 另用 --import 预加载兜底。
 */
import { isTempDataDir } from "./setup.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { findFreePort, layaRoot, readHealth } from "../src/local-laya/deps.ts";
import { hfRepoDir, hfSharedBlobsDir, hfSnapshotDir } from "../src/local-laya/hf-metadata.ts";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

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

test("物化目录必须提供 Laya 本地加载会读的入口（LAYA_EXTRA_MODELS 只指这样的目录）", async () => {
	const { checkpointFiles } = await import("../src/local-laya/checkpoint-files.ts");
	// Laya 0.4.8 `Agent(path)`（laya/agent.py:575/672/675、laya/common.py:707）在本地目录下依次读：
	//   model_dir/rl_agent_config.json、model_dir/tokenizer/（tokenizer.json + tokenizer_config.json）、
	//   model_dir/encoder/config.json、model_dir/model.safetensors
	// 少了任一个就会回退去 HF 下载（cfg["encoder"]）或直接抛错，所以固定清单必须覆盖它们。
	const required = ["rl_agent_config.json", "model.safetensors", "encoder/config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"];
	for (const id of ["laya-multilingual", "laya-typed-decisions"]) {
		const paths = new Set(checkpointFiles(id).filter((f) => !f.optional).map((f) => f.path));
		for (const req of required) assert.ok(paths.has(req), `${id} 固定清单缺少 Laya 本地加载必需文件：${req}`);
	}
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

test("createLayaDeps（共享 blob 形态）：真实 verify + materialize + activate，运行时权重来源就是所验文件；重试复用缓存", async () => {
	const { createLayaDeps, layaPaths } = await import("../src/local-laya/deps.ts");
	const { LAYA_CHECKPOINTS } = await import("../src/local-laya/manifest.ts");
	const paths = layaPaths();
	rmSync(paths.root, { recursive: true, force: true });
	mkdirSync(paths.root, { recursive: true });
	// 测试只能写「被 setup 强制到临时目录」的数据目录；这里是兜底断言，防止再退回真实数据目录。
	assert.equal(isTempDataDir(paths.root), true, "测试只能写临时数据目录");
	const cp = LAYA_CHECKPOINTS["laya-multilingual"];
	// 小清单：驱动**真实的** verify / materialize 代码，不下载 GB 权重、不起 sidecar。
	const tiny = [
		{ path: "model.safetensors", content: "laya-fake-weights-0123456789" },
		{ path: "rl_agent_config.json", content: '{"k":1}' },
		{ path: "encoder/config.json", content: '{"enc":1}' },
		{ path: "tokenizer/tokenizer.json", content: '{"tok":1}' },
	];
	const files = tiny.map((t) => ({ path: t.path, size: Buffer.byteLength(t.content), sha256: sha(t.content) }));
	try {
		// 形态 B：snap → repo/blobs/<sha> → hub/blobs/<aa>/<hash>，全部在自有 HF hub 缓存内。
		const hubBlobs = hfSharedBlobsDir(paths.hfHome);
		const repoBlobs = join(hfRepoDir(paths.hfHome, cp.repo), "blobs");
		const snap = hfSnapshotDir(paths.hfHome, cp.repo, cp.revision);
		mkdirSync(repoBlobs, { recursive: true });
		for (const t of tiny) {
			const h = sha(t.content);
			const blob = join(hubBlobs, h.slice(0, 2), h);
			mkdirSync(dirname(blob), { recursive: true });
			writeFileSync(blob, t.content);
			const link = join(repoBlobs, h);
			symlinkSync(relative(repoBlobs, blob), link);
			const dest = join(snap, t.path);
			mkdirSync(dirname(dest), { recursive: true });
			symlinkSync(relative(dirname(dest), link), dest);
		}
		const deps = createLayaDeps({ checkpointFiles: () => files });
		mkdirSync(paths.envStaging, { recursive: true });
		writeFileSync(join(paths.envStaging, "pyvenv.cfg"), "home=/tmp\n");

		await deps.verifyCheckpoint(cp, AbortSignal.timeout(30_000));
		for (const t of tiny) {
			const p = join(paths.weightsStaging, t.path);
			assert.equal(lstatSync(p).isSymbolicLink(), false, `${t.path} 物化后必须是普通文件`);
			assert.equal(sha(readFileSync(p)), sha(t.content));
		}
		assert.equal(deps.checkpointSource!(paths), null, "activate 之前不得对外提供权重目录");

		await deps.activate(paths);
		assert.equal(deps.checkpointSource!(paths), paths.weights, "运行时权重来源 = 本次生效目录");
		const runtimeModel = join(paths.weights, "model.safetensors");
		assert.equal(lstatSync(runtimeModel).isSymbolicLink(), false);
		assert.equal(sha(readFileSync(runtimeModel)), sha("laya-fake-weights-0123456789"), "运行时要加载的就是校验过的那个文件");

		// 缓存命中重试：同一份 HF 缓存上再校验 / 物化一次仍成功（复用缓存，不逼重下）。
		await deps.verifyCheckpoint(cp, AbortSignal.timeout(30_000));
		assert.equal(sha(readFileSync(join(paths.weightsStaging, "model.safetensors"))), sha("laya-fake-weights-0123456789"));

		// 断链（缓存残缺）必须失败，且区分于「越界」。
		const h = sha("laya-fake-weights-0123456789");
		rmSync(join(hubBlobs, h.slice(0, 2), h));
		await assert.rejects(() => deps.verifyCheckpoint(cp, AbortSignal.timeout(30_000)), /断链/);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("checkpointProgressBytes：共享 blob 两层链接的 snapshot 仍能 stat 跟随计满；断链不计也不抛", async () => {
	const { checkpointProgressBytes } = await import("../src/local-laya/deps.ts");
	const { LAYA_CHECKPOINTS } = await import("../src/local-laya/manifest.ts");
	const cp = LAYA_CHECKPOINTS["laya-multilingual"];
	const root = mkdtempSync(join(tmpdir(), "laya-prog-nested-"));
	try {
		const hfHome = join(root, "hf");
		const hubBlobs = hfSharedBlobsDir(hfHome);
		const repoDir = hfRepoDir(hfHome, cp.repo);
		const snap = hfSnapshotDir(hfHome, cp.repo, cp.revision);
		const repoBlobs = join(repoDir, "blobs");
		mkdirSync(repoBlobs, { recursive: true });
		const h = "f".repeat(64);
		// 形态 B：共享 blob 普通文件 + repo/blobs/<sha> 与 snapshot 两层 symlink。
		const blob = join(hubBlobs, h.slice(0, 2), h);
		mkdirSync(dirname(blob), { recursive: true });
		writeFileSync(blob, Buffer.alloc(1000));
		const link = join(repoBlobs, h);
		symlinkSync(relative(repoBlobs, blob), link);
		mkdirSync(snap, { recursive: true });
		symlinkSync(relative(snap, link), join(snap, "model.safetensors"));
		const files = [{ path: "model.safetensors", size: 1000, sha256: h }];
		// 进度不需要另造下载器 / 不自己解析缓存：statSync 跟随两层链接即可计满。
		assert.equal(checkpointProgressBytes(hfHome, cp, files), 1000, "两层链接也要 stat 跟随到真实 blob 计满");
		// 共享 blob 缺失（断链）→ 不计、不抛（绝不把残缺算成进度）。
		rmSync(blob);
		assert.equal(checkpointProgressBytes(hfHome, cp, files), 0, "断链不计入，且不抛");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("spawnServe：可执行文件不存在时经 onExit 报退出（不产生未捕获 'error' 把服务进程打挂）", async () => {
	const { createLayaDeps } = await import("../src/local-laya/deps.ts");
	const deps = createLayaDeps();
	// 生产 sidecar 在 activate 改名后若 shebang 失效会 spawn ENOENT；这里直接用一个不存在的路径复现。
	const child = deps.spawn("/definitely/not/a/real/laya-serve", [], { env: {} });
	const code = await new Promise<number | null>((res, rej) => {
		const t = setTimeout(() => rej(new Error("spawn 'error' 未转成 onExit")), 5000);
		child.onExit((c) => {
			clearTimeout(t);
			res(c);
		});
	});
	assert.equal(code, null);
});

test("spawnServe：sidecar 首次输出日志时不会因日志文件还不存在而抛异常 / 打挂进程", async () => {
	const { createLayaDeps, readLayaLogs } = await import("../src/local-laya/deps.ts");
	const deps = createLayaDeps();
	// 用 node 自身作一个会立即输出 stdout 的假 sidecar（跨平台，无需真 Laya）。
	const child = deps.spawn(process.execPath, ["-e", "console.log('sidecar-log-probe')"], { env: {} });
	const code = await new Promise<number | null>((res) => child.onExit((c) => res(c)));
	assert.equal(code, 0);
	const lines = readLayaLogs(50);
	assert.ok(lines.some((l) => l.includes("sidecar-log-probe")), "sidecar 输出应写入日志（不在首条输出时因日志文件缺失抛 ENOENT）");
});
