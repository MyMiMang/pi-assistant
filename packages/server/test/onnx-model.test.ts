/** 向量模型平铺目录：旧 HF 缓存（符号链接指向 blobs/）迁移成真实文件；外部权重缺失的半成品不迁移；环境变量指向平铺路径 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
const { ensureOnnxModel, onnxModelFile, onnxReady, embeddingInstalled, cachedOnnx, paths, sidecarEnv } = await import("../src/memory/hindsight/sidecar.ts");

function fakeCache(id: string, withData: boolean) {
	const hub = join(paths().hf, "hub");
	const repo = join(hub, `models--${id.replace("/", "--")}`);
	const blobs = join(repo, "blobs");
	const snap = join(repo, "snapshots", "rev1", "onnx");
	mkdirSync(blobs, { recursive: true });
	mkdirSync(snap, { recursive: true });
	writeFileSync(join(blobs, "aaa"), "graph");
	symlinkSync(join(blobs, "aaa"), join(snap, "model.onnx"));
	if (withData) {
		writeFileSync(join(blobs, "bbb"), "weights");
		symlinkSync(join(blobs, "bbb"), join(snap, "model.onnx_data"));
	}
	return { blobs, snap };
}

test("旧缓存（符号链接）→ 复制成平铺的真实文件，删掉缓存大文件，写完成标记", async () => {
	const { blobs } = fakeCache("BAAI/bge-m3", true);
	assert.ok(embeddingInstalled("BAAI/bge-m3"), "旧缓存算已下载（启动时迁移）");
	assert.ok(!onnxReady("BAAI/bge-m3"));
	const f = await ensureOnnxModel("BAAI/bge-m3", null, {});
	assert.equal(f, onnxModelFile("BAAI/bge-m3"));
	assert.ok(!lstatSync(f).isSymbolicLink());
	assert.equal(readFileSync(f, "utf8"), "graph");
	assert.equal(readFileSync(join(f, "..", "model.onnx_data"), "utf8"), "weights");
	assert.ok(onnxReady("BAAI/bge-m3"));
	assert.ok(!existsSync(join(blobs, "aaa")) && !existsSync(join(blobs, "bbb")), "缓存里的大文件已释放");
	assert.equal(cachedOnnx("BAAI/bge-m3"), null);
});

test("缓存里只有小图、缺外部权重（没下完）→ 不当作可迁移", () => {
	fakeCache("intfloat/multilingual-e5-small", false);
	assert.equal(cachedOnnx("intfloat/multilingual-e5-small"), null);
});

test("启动环境变量：ONNX 模型路径指向平铺目录，分词器仍按模型 id", () => {
	const env = sidecarEnv({ s: { mode: "local", llm: null, embedding: { kind: "local", model: "BAAI/bge-m3" }, reranker: { kind: "off" }, mirror: "official" }, sec: { tenantKey: "k" }, mirror: "official", proxyUrl: "http://x", proxyToken: "t", uvDir: "/u" } as never);
	assert.equal(env.HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_PATH, onnxModelFile("BAAI/bge-m3"));
	assert.equal(env.HINDSIGHT_API_EMBEDDINGS_ONNX_TOKENIZER_NAME_OR_PATH, "BAAI/bge-m3");
});

test("平铺目录里混进符号链接（onnxruntime 启动会崩）→ 不算就绪；启动前换成真实文件，不重新下载", async () => {
	const id = "BAAI/bge-m3";
	const f = onnxModelFile(id);
	const dir = join(f, "..");
	mkdirSync(dir, { recursive: true });
	const elsewhere = join(paths().root, "elsewhere");
	mkdirSync(elsewhere, { recursive: true });
	writeFileSync(join(elsewhere, "g"), "graph2");
	writeFileSync(join(elsewhere, "w"), "weights2");
	for (const n of ["model.onnx", "model.onnx_data"]) {
		try {
			(await import("node:fs")).rmSync(join(dir, n), { force: true });
		} catch {}
	}
	symlinkSync(join(elsewhere, "g"), f);
	symlinkSync(join(elsewhere, "w"), join(dir, "model.onnx_data"));
	assert.equal(onnxReady(id), false, "有符号链接 → 当作没准备好（完成标记被清掉）");
	await ensureOnnxModel(id, null, {});
	assert.ok(!lstatSync(f).isSymbolicLink() && !lstatSync(join(dir, "model.onnx_data")).isSymbolicLink());
	assert.equal(readFileSync(join(dir, "model.onnx_data"), "utf8"), "weights2");
	assert.ok(onnxReady(id));
});
