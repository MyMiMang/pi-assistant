/**
 * Hindsight 真机冒烟（需要联网，首次约下载 1 GB；不在默认 npm test 里）：
 *   PIA_HS_SMOKE_DIR=/tmp/pia-hs-smoke node --import tsx test/hindsight.smoke.ts
 * 用 Mock 模型（经本机网关）跑通：安装 → 启动 → 握手 → 写入 → 抽取 → 检索 → 反思 → 编辑/遗忘 → 导出/导入 → 重启后仍在 → 停止
 */
process.env.PIA_MOCK = "1";
process.env.PIA_DATA_DIR = process.env.PIA_HS_SMOKE_DIR ?? "/tmp/pia-hs-smoke";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const { config } = await import("../src/config.ts");
const { setSetting, db } = await import("../src/db.ts");
const modelsMod = await import("../src/models.ts");
await modelsMod.initModels();
const { sidecar, paths, setChatDefault } = await import("../src/memory/hindsight/sidecar.ts");
const { flush, pendingCount } = await import("../src/memory/hindsight/provider.ts");
const { memory } = await import("../src/memory/index.ts");
setChatDefault(modelsMod.defaultModel);
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const homeBefore = new Set(readdirSync(homedir()));

const agentId = "smoke";
db.prepare("INSERT OR IGNORE INTO agents(id, name, avatar, color, persona, created_at, memory_provider) VALUES(?,?,?,?,?,?,?)").run(agentId, "冒烟", "🧪", "#888", "", Date.now(), "hindsight");
setSetting("hindsight", { reranker: { kind: "off" } });

let last = "";
const { bus } = await import("../src/bus.ts");
bus.on((e) => {
	if (e.type === "memory.hindsight") {
		const s = e.status as { state: string; detail: string };
		const l = `${s.state}: ${s.detail}`;
		if (l !== last && !/^starting: (INFO|\d{4}-)/.test(l)) log(l);
		last = l;
	}
});
await sidecar.ensure();
assert.equal(sidecar.status.state, "ready", sidecar.status.detail);
log(`就绪 ${sidecar.baseUrl}`);
assert.notEqual(sidecar.status.port, 8888);
// 不带密钥访问必须被拒
assert.equal((await fetch(`${sidecar.baseUrl}/v1/default/banks`)).status, 401);

const r = await memory.remember(agentId, null, { content: "我叫张伟，住在杭州。我喜欢简洁的回答。", kind: "fact", scope: "agent" });
log(`写入 ${r.id}`);
await flush();
assert.equal(pendingCount(), 0, "队列应清空");
// 等 Hindsight 异步抽取完成
let hits: { id: string; text: string }[] = [];
for (let i = 0; i < 60 && !hits.some((h) => /杭州/.test(h.text) && h.id === r.id); i++) {
	await new Promise((ok) => setTimeout(ok, 2000));
	hits = await memory.recall(agentId, null, "用户住在哪里", 5);
}
log(`检索：${JSON.stringify(hits.map((h) => [h.id, h.text]))}`);
assert.ok(hits.some((h) => h.id === r.id && /杭州/.test(h.text)), "Hindsight 检索应返回抽取出的事实，并映射回账本 id");
const ref = await memory.reflect(agentId, "用户喜欢什么样的回答？");
log(`反思：${ref?.answer}`);
assert.ok(ref?.answer);
const ctx = await memory.context(agentId, null, "你好");
assert.match(ctx, /杭州/);
// 编辑 → 同一 documentId 替换
await memory.update(agentId, r.id, { text: "我叫张伟，住在苏州。" });
await flush();
const exp = await memory.exportAgent(agentId);
assert.equal(exp.agent.items.length, 1);
assert.match(exp.agent.items[0].text, /苏州/);
// 遗忘
await memory.forget(agentId, r.id);
await flush();
for (let i = 0; i < 15; i++) {
	hits = await memory.recall(agentId, null, "张伟住在哪里", 5);
	if (!hits.some((h) => h.id === r.id)) break;
	await new Promise((ok) => setTimeout(ok, 1000));
}
assert.ok(!hits.some((h) => h.id === r.id), "遗忘后不应再检索到");
// 导入
const n = await memory.importAgent(agentId, exp);
await flush();
assert.equal(n, 1);
log("编辑 / 遗忘 / 导出 / 导入 OK");
// 重启后仍在
await sidecar.restart();
assert.equal(sidecar.status.state, "ready");
for (let i = 0; i < 60; i++) {
	hits = await memory.recall(agentId, null, "张伟住在苏州", 5);
	if (hits.some((h) => /苏州/.test(h.text) && (h as { meta?: { hindsightType?: string } }).meta?.hindsightType)) break;
	await new Promise((ok) => setTimeout(ok, 2000));
}
assert.ok(hits.some((h) => /苏州/.test(h.text)));
log("重启后检索 OK");
// 隔离：HOME 下没有新东西；数据都在我们的目录
assert.deepEqual(new Set(readdirSync(homedir())), homeBefore);
assert.ok(existsSync(join(paths().home, ".pg0")) && existsSync(join(paths().home, ".hindsight")));
assert.ok(!existsSync(join(homedir(), ".hindsight")) && !existsSync(join(homedir(), ".pg0")));
await sidecar.stop();
log(`完成，数据目录 ${config.dataDir}`);
process.exit(0);
