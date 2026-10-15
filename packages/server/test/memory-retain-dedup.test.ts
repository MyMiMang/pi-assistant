/**
 * retain 入队去重：同一条目已有未处理的 retain 不重复排；即使之前失败过（attempts>0）也不重复入队。
 * 只连本地账本 / 内存凭据，不启 Hindsight（sidecar 未 ready，flush 直接返回）。
 */
process.env.PIA_MOCK = "1";
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
const { memoryCredentialStore } = await import("./in-memory-credentials.ts");
const { db } = await import("../src/db.ts");
const modelsMod = await import("../src/models.ts");
await modelsMod.initModels(memoryCredentialStore());
const { basicMemory } = await import("../src/memory/basic.ts");
const { enqueue, pendingCount } = await import("../src/memory/hindsight/provider.ts");

test("retain 入队按 bank+item 去重（失败重试后也不重复）", async () => {
	const bank = "agent_dedup";
	const r = await basicMemory.remember(bank, { content: "去重测试条目" });
	const id = r.ids![0];
	const jobsFor = () => (db.prepare("SELECT COUNT(*) AS n FROM memory_sync WHERE bank = ? AND item_id = ? AND op = 'retain'").get(bank, id) as { n: number }).n;

	enqueue(bank, "retain", id);
	enqueue(bank, "retain", id);
	assert.equal(jobsFor(), 1, "重复入队应去重");

	// 模拟一次失败（attempts>0）：旧实现这里会重复入队
	db.prepare("UPDATE memory_sync SET attempts = 1, last_error = 'boom' WHERE bank = ? AND item_id = ?").run(bank, id);
	enqueue(bank, "retain", id);
	assert.equal(jobsFor(), 1, "失败重试后仍不重复入队");
	assert.ok(pendingCount() >= 1, "队列里仍有待处理项");
});
