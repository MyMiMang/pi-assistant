/**
 * 真实 deps 回归：**直接跑 `createAsrDeps()` 的生产实现**（只把 fetch 指向本地 HTTP fixture），
 * 覆盖「按所选模型 repo/revision 下载 → 真实 SHA 校验 → 取消 / 缓存 → activate → 元数据 → 卸载一个不碰另一个」。
 *
 * 为什么必须跑具体 deps：此前多模型 manager 已经接受多模型，但具体 deps 仍硬编码 SenseVoice 的
 * 权重仓库 / 路径（假 deps 的 16 项测试根本跑不到真实实现，所以「通过」不代表新模型装得上）。
 * 这里**不 mock downloadWeights**，走的就是共享的 `downloadFile`（Range 续传 / `.part` / 摘要 / 原子改名）。
 * 权重内容是本文件生成的小 fixture（真实权重由人工 smoke 验证），但路径 / 仓库 / revision / 校验全是真的。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { TEST_DATA_DIR, isTempDataDir } from "./setup.ts";
import { config } from "../src/config.ts";
import { createAsrDeps, hfResolveUrl, type AsrDepsOverrides } from "../src/local-asr/deps.ts";
import type { AsrWeightFile } from "../src/local-asr/manifest.ts";

process.env.PIA_TEST_FAST = "1";

const REPO_A = "pia-test/asr-alpha";
const REPO_B = "pia-test/asr-beta";
const REV_A = "a".repeat(40);
const REV_B = "b".repeat(40);
const ID_A = "test-alpha-int8";
const ID_B = "test-beta-int8";

interface Fixture {
	path: string;
	bytes: Buffer;
	file: AsrWeightFile;
}

function fixture(path: string, size: number, fill: number): Fixture {
	const bytes = Buffer.alloc(size, fill);
	return { path, bytes, file: { path, size, sha256: createHash("sha256").update(bytes).digest("hex") } };
}

const A: Fixture[] = [fixture("model.int8.onnx", 5000, 1), fixture("tokens.txt", 128, 2)];
const B: Fixture[] = [fixture("encoder.int8.onnx", 4096, 3), fixture("decoder.int8.onnx", 3072, 4), fixture("tokens.txt", 128, 5)];

/** 本地 fixture 服务器：按 `/<repo>/resolve/<rev>/<file>` 提供字节，支持 Range（验证续传）。 */
function startFixtureServer(): Promise<{ base: string; requests: { url: string; range: string | null }[]; close: () => Promise<void>; slow: boolean; failHash: boolean }> {
	const table = new Map<string, Buffer>();
	for (const f of A) table.set(`${REPO_A}/resolve/${REV_A}/${f.path}`, f.bytes);
	for (const f of B) table.set(`${REPO_B}/resolve/${REV_B}/${f.path}`, f.bytes);
	const state = { base: "", requests: [] as { url: string; range: string | null }[], slow: false, failHash: false };
	const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = req.url ?? "";
		const range = req.headers.range ?? null;
		state.requests.push({ url, range });
		const body = table.get(url.replace(/^\//, ""));
		if (!body) {
			res.writeHead(404, { "content-length": "0" });
			res.end();
			return;
		}
		const send = (buf: Buffer, code = 200, headers: Record<string, string> = {}) => {
			res.writeHead(code, { "content-length": String(buf.length), ...headers });
			if (!state.slow) {
				res.end(buf);
				return;
			}
			// 分块慢发：给取消 / 续传留出窗口。
			const chunk = Math.max(1, Math.ceil(buf.length / 8));
			let off = 0;
			const tick = () => {
				if (off >= buf.length) {
					res.end();
					return;
				}
				res.write(buf.subarray(off, off + chunk));
				off += chunk;
				setTimeout(tick, 5);
			};
			tick();
		};
		if (range) {
			const m = /^bytes=(\d+)-/.exec(range);
			const start = m ? Number(m[1]) : 0;
			if (start >= body.length) {
				res.writeHead(416, { "content-range": `bytes */${body.length}`, "content-length": "0" });
				res.end();
				return;
			}
			send(body.subarray(start), 206, { "content-range": `bytes ${start}-${body.length - 1}/${body.length}` });
			return;
		}
		send(body);
	});
	return new Promise((resolve) => {
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			state.base = `http://127.0.0.1:${port}`;
			resolve({ ...state, close: () => new Promise((r) => srv.close(() => r())) });
		});
	});
}

/** 每个用例前清掉自己模型的本地目录（同一进程里用例共享数据目录，避免互相看到对方的 staging）。 */
function resetModel(id: string): void {
	for (const sub of ["weights", "weights.new", "weights.old"]) rmSync(join(TEST_DATA_DIR, "local-asr", "models", id, sub), { recursive: true, force: true });
}

function makeDeps(server: { base: string; requests: { url: string; range: string | null }[] }): { deps: ReturnType<typeof createAsrDeps>; requested: string[] } {
	const requested: string[] = [];
	const overrides: AsrDepsOverrides = {
		hfEndpoint: server.base,
		fetchImpl: ((input: string | URL | Request, init?: RequestInit) => {
			requested.push(String(input));
			return fetch(input as string, init);
		}) as typeof fetch,
	};
	return { deps: createAsrDeps(overrides), requested };
}

test("环境隔离 fail-closed：真实 deps 的读写目录必须落在本次进程的临时数据目录", () => {
	assert.ok(isTempDataDir(config.dataDir), `必须在临时数据目录运行（当前 ${config.dataDir}），否则真实 createAsrDeps 会写到用户数据目录`);
	const deps = createAsrDeps();
	for (const id of [ID_A, ID_B]) {
		assert.ok(deps.paths(id).weightsStaging.startsWith(TEST_DATA_DIR), `${id} staging 应落在临时数据目录`);
		assert.ok(deps.paths(id).weights.startsWith(TEST_DATA_DIR), `${id} weights 应落在临时数据目录`);
	}
});

test("hfResolveUrl：逐段编码；拒绝非法 revision / 仓库 / 越界路径", () => {
	assert.equal(hfResolveUrl("https://huggingface.co", REPO_A, REV_A, "sub dir/mo del.onnx"), `https://huggingface.co/${REPO_A}/resolve/${REV_A}/sub%20dir/mo%20del.onnx`);
	assert.throws(() => hfResolveUrl("https://x", REPO_A, "main", "a.onnx"), /40 位十六进制/);
	assert.throws(() => hfResolveUrl("https://x", REPO_A, "abc", "a.onnx"), /40 位十六进制/);
	assert.throws(() => hfResolveUrl("https://x", "https://evil.example/repo", REV_A, "a.onnx"), /仓库名不合法/);
	assert.throws(() => hfResolveUrl("https://x", REPO_A, REV_A, "../../etc/passwd"), /路径不合法/);
	assert.throws(() => hfResolveUrl("https://x", REPO_A, REV_A, "/etc/passwd"), /路径不合法/);
});

test("按所选模型的 repo/revision 下载到该模型 staging 并真实校验（不是 SenseVoice 仓库）", async () => {
	const server = await startFixtureServer();
	try {
		resetModel(ID_A);
		const { deps, requested } = makeDeps(server);
		const progress: number[] = [];
		await deps.downloadWeights(A.map((f) => f.file), (r) => progress.push(r), new AbortController().signal, {}, "/nonexistent/python", { repo: REPO_A, revision: REV_A, modelId: ID_A });

		for (const f of A) {
			const dest = join(deps.paths(ID_A).weightsStaging, f.path);
			assert.ok(existsSync(dest), `${f.path} 应下载到该模型 staging`);
			assert.deepEqual(readFileSync(dest), f.bytes);
		}
		// 请求路径必须真的是所选仓库 / revision，且不含 SenseVoice 旧仓。
		assert.ok(requested.length >= A.length);
		for (const u of requested) assert.ok(u.startsWith(`${server.base}/${REPO_A}/resolve/${REV_A}/`), `请求路径应是所选仓库：${u}`);
		assert.ok(!requested.some((u) => u.includes("sense-voice")), "不应再请求 SenseVoice 仓库");
		// 进度按已完成字节累加（单调不减，且末值 = 总字节）。
		const total = A.reduce((n, f) => n + f.file.size, 0);
		for (let i = 1; i < progress.length; i++) assert.ok(progress[i] >= progress[i - 1]);
		assert.equal(progress.at(-1), total);

		// 真实 SHA 校验（走生产 verifyAsrWeights）。
		await deps.verifyWeights(A.map((f) => f.file), new AbortController().signal, { modelId: ID_A });

		// 缺文件 / 坏摘要都必须拒绝。
		writeFileSync(join(deps.paths(ID_A).weightsStaging, "tokens.txt"), Buffer.alloc(128, 9));
		await assert.rejects(deps.verifyWeights(A.map((f) => f.file), new AbortController().signal, { modelId: ID_A }), /权重校验未通过/);
		rmSync(join(deps.paths(ID_A).weightsStaging, "tokens.txt"));
		await assert.rejects(deps.verifyWeights(A.map((f) => f.file), new AbortController().signal, { modelId: ID_A }), /权重校验未通过/);
	} finally {
		await server.close();
	}
});

test("已下载且摘要正确的缓存不重复请求；两个模型的读写路径互相隔离", async () => {
	const server = await startFixtureServer();
	try {
		resetModel(ID_A);
		resetModel(ID_B);
		const { deps, requested } = makeDeps(server);
		const sig = new AbortController().signal;
		await deps.downloadWeights(A.map((f) => f.file), () => {}, sig, {}, "/nonexistent/python", { repo: REPO_A, revision: REV_A, modelId: ID_A });
		const afterFirst = requested.length;
		await deps.downloadWeights(A.map((f) => f.file), () => {}, sig, {}, "/nonexistent/python", { repo: REPO_A, revision: REV_A, modelId: ID_A });
		assert.equal(requested.length, afterFirst, "缓存命中不应再发请求");

		await deps.downloadWeights(B.map((f) => f.file), () => {}, sig, {}, "/nonexistent/python", { repo: REPO_B, revision: REV_B, modelId: ID_B });
		assert.ok(requested.slice(afterFirst).every((u) => u.startsWith(`${server.base}/${REPO_B}/resolve/${REV_B}/`)));

		// 路径隔离：各自 staging 只含自己的清单文件。
		assert.deepEqual(
			A.map((f) => f.path).filter((p) => existsSync(join(deps.paths(ID_A).weightsStaging, p))).sort(),
			A.map((f) => f.path).sort(),
		);
		assert.ok(!existsSync(join(deps.paths(ID_A).weightsStaging, B[0].path)), "A 的 staging 不应有 B 的文件");
		assert.ok(!existsSync(join(deps.paths(ID_B).weightsStaging, A[0].path)), "B 的 staging 不应有 A 的文件");
	} finally {
		await server.close();
	}
});

test("下载中取消：不落 ready 文件；重试（Range 续传）后能装好", async () => {
	const server = await startFixtureServer();
	try {
		server.slow = true;
		resetModel(ID_A);
		const { deps } = makeDeps(server);
		const ctrl = new AbortController();
		const files = A.map((f) => f.file);
		let aborted = false;
		await assert.rejects(
			deps.downloadWeights(files, () => {
				if (!aborted) {
					aborted = true;
					ctrl.abort();
				}
			}, ctrl.signal, {}, "/nonexistent/python", { repo: REPO_A, revision: REV_A, modelId: ID_A }),
			/已取消/,
		);
		assert.ok(!existsSync(join(deps.paths(ID_A).weightsStaging, "model.int8.onnx")), "取消后不应留下 ready 文件");
		// 重试：已完成的部分应被复用（Range 续传），最终校验通过。
		server.slow = false;
		await deps.downloadWeights(files, () => {}, new AbortController().signal, {}, "/nonexistent/python", { repo: REPO_A, revision: REV_A, modelId: ID_A });
		await deps.verifyWeights(files, new AbortController().signal, { modelId: ID_A });
	} finally {
		await server.close();
	}
});

test("activate 写 per-model 元数据；卸载 B 保留 A 的权重 / 元数据 / 共享 runtime", async () => {
	const server = await startFixtureServer();
	try {
		resetModel(ID_A);
		resetModel(ID_B);
		const { deps } = makeDeps(server);
		const sig = new AbortController().signal;
		const meta = (modelId: string, runner: string, fileRoles: Record<string, string>) => ({
			source: "download" as const,
			engineVersion: "1.13.8",
			revision: modelId === ID_A ? REV_A : REV_B,
			modelId,
			runner,
			fileRoles,
			sampleRate: 16_000,
			maxAudioBytes: 8 * 1024 * 1024,
			engineRequirements: "sherpa-onnx==1.13.8 --hash=sha256:test\n",
		});

		for (const [id, repo, rev, files, runner, roles] of [
			[ID_A, REPO_A, REV_A, A, "sensevoice", { model: "model.int8.onnx", tokens: "tokens.txt" }],
			[ID_B, REPO_B, REV_B, B, "whisper", { encoder: "encoder.int8.onnx", decoder: "decoder.int8.onnx", tokens: "tokens.txt" }],
		] as const) {
			await deps.downloadWeights(files.map((f) => f.file), () => {}, sig, {}, "/nonexistent/python", { repo, revision: rev, modelId: id });
			await deps.verifyWeights(files.map((f) => f.file), sig, { modelId: id });
			// activate 需要 staging venv（真实流程里由 manager 先建好）。
			mkdirSync(deps.paths(id).envStaging, { recursive: true });
			await deps.activate(deps.paths(id), meta(id, runner, roles as Record<string, string>));
		}

		const pa = deps.paths(ID_A);
		const pb = deps.paths(ID_B);
		assert.ok(existsSync(join(pa.weights, "model.int8.onnx")), "A 权重应已生效");
		assert.ok(!existsSync(pa.weightsStaging), "A staging 应已原子改名");
		const metaA = JSON.parse(readFileSync(pa.metaFile, "utf8")) as { modelId: string; revision: string; runner: string };
		assert.equal(metaA.modelId, ID_A);
		assert.equal(metaA.revision, REV_A);
		assert.equal(metaA.runner, "sensevoice");
		assert.ok(existsSync(pa.serve ?? ""), "A 的 sidecar 脚本应写入 per-model 路径");
		assert.notEqual(pa.metaFile, pb.metaFile);

		await deps.uninstall(pb, ID_B);
		assert.ok(!existsSync(pb.weights), "卸载 B 应删掉 B 的权重");
		assert.ok(!existsSync(pb.metaFile), "卸载 B 应删掉 B 的元数据");
		assert.ok(existsSync(join(pa.weights, "model.int8.onnx")), "卸载 B 不能动 A 的权重");
		assert.ok(existsSync(pa.metaFile), "卸载 B 不能动 A 的元数据");
		assert.ok(existsSync(pa.env), "共享 runtime（venv）应保留");
	} finally {
		await server.close();
	}
});
