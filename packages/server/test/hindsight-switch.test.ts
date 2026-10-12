/**
 * 回归：在设置里切换向量模型后向量模型坏掉。
 * 原因：Hindsight 的向量列维度整库共享（e5-small 384 维 / bge-m3 1024 维），库里已有数据时换维度它启动直接报错
 * “Cannot change embedding dimension”，而我们只删除/重建单个库（列维度不变），于是一直启动失败、记忆退回 basic。
 * 修复：换向量模型时（本机模式）清掉内嵌数据库并把所有库标为待重建，Hindsight 以新维度起来后按账本原文全部重写。
 */
process.env.PIA_MOCK = "1";
await import("./setup.ts");
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
const { db } = await import("../src/db.ts");
const modelsMod = await import("../src/models.ts");
await modelsMod.initModels();
const { sidecar, paths, resetEmbeddingStore, embeddingInstalled } = await import("../src/memory/hindsight/sidecar.ts");
const { flush, pendingCount, resyncAll } = await import("../src/memory/hindsight/provider.ts");
const settings = await import("../src/memory/hindsight/settings.ts");
const { memory } = await import("../src/memory/index.ts");
const { listDownloads } = await import("../src/downloads.ts");
// @ts-expect-error 测试夹具是 .mjs
const { fakeHindsight } = await import("../../../e2e/fixtures/fake-hindsight.mjs");

const agentId = "hsw";
db.prepare("INSERT OR IGNORE INTO agents(id, name, avatar, color, persona, created_at, memory_provider) VALUES(?,?,?,?,?,?,?)").run(agentId, "切换", "🧪", "#888", "", Date.now(), "hindsight");

test("本机模式换向量模型：清掉旧维度的内嵌数据库（.pg0），所有库标记为待重建", () => {
	settings.saveHindsightSettings({ mode: "local", embedding: { kind: "local", model: "intfloat/multilingual-e5-small" } });
	const pg = join(paths().home, ".pg0", "instances", "pia");
	mkdirSync(pg, { recursive: true });
	writeFileSync(join(pg, "PG_VERSION"), "16");
	db.prepare("INSERT INTO hindsight_banks(bank, signature, created_at) VALUES(?,?,?) ON CONFLICT(bank) DO UPDATE SET signature = excluded.signature").run(`agent_${agentId}`, "local:intfloat/multilingual-e5-small", Date.now());
	settings.saveHindsightSettings({ embedding: { kind: "local", model: "BAAI/bge-m3" } });
	resetEmbeddingStore();
	assert.ok(!existsSync(join(paths().home, ".pg0")), "旧数据库必须删掉，否则 Hindsight 因维度不一致起不来");
	assert.equal((db.prepare("SELECT signature FROM hindsight_banks WHERE bank = ?").get(`agent_${agentId}`) as { signature: string }).signature, "");
});

test("重建后全部原文按新模型重新写入；下载列表只显示选中的向量模型", async () => {
	const fake = fakeHindsight("rk2");
	const port = await fake.start();
	settings.saveHindsightSettings({ mode: "remote", remoteUrl: `http://127.0.0.1:${port}`, remoteKey: "rk2" });
	await sidecar.restart();
	assert.equal(sidecar.status.state, "ready", sidecar.status.detail);
	const a = await memory.remember(agentId, null, { content: "我喜欢喝乌龙茶", kind: "fact", scope: "agent" });
	await flush();
	assert.equal(fake.banks.get(`agent_${agentId}`)?.get(a.id), "我喜欢喝乌龙茶");
	// 模拟“换模型后库被清空”：Hindsight 里什么都没有了，账本还在
	fake.banks.clear();
	resetEmbeddingStore();
	await resyncAll();
	await flush();
	assert.equal(pendingCount(), 0);
	assert.equal(fake.banks.get(`agent_${agentId}`)?.get(a.id), "我喜欢喝乌龙茶", "按账本原文重新写入");
	await sidecar.stop();
	await fake.stop();

	settings.saveHindsightSettings({ mode: "local", embedding: { kind: "local", model: "BAAI/bge-m3" } });
	const ids = listDownloads().map((d) => d.id);
	assert.ok(ids.includes("embedding:BAAI/bge-m3"));
	assert.ok(!ids.includes("embedding:intfloat/multilingual-e5-small"), "没选、也没下载过的不显示");
	assert.ok(!embeddingInstalled("BAAI/bge-m3"));
});
