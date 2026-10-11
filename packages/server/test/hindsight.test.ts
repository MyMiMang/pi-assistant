/**
 * Hindsight 后端（离线）：用一个假的 Hindsight HTTP 服务（远程模式，跳过安装）测
 * 同步队列、断线回退 basic、恢复后补写、遗忘/编辑、导出导入、向量模型变更后重建、自动挑选记忆模型、附属进程环境隔离。
 */
process.env.PIA_MOCK = "1";
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
const { db, setSetting } = await import("../src/db.ts");
const modelsMod = await import("../src/models.ts");
await modelsMod.initModels();
const { sidecar, sidecarEnv, paths } = await import("../src/memory/hindsight/sidecar.ts");
const { flush, pendingCount, resyncAll } = await import("../src/memory/hindsight/provider.ts");
const settings = await import("../src/memory/hindsight/settings.ts");
const { memory } = await import("../src/memory/index.ts");
const { config } = await import("../src/config.ts");

// @ts-expect-error 测试夹具是 .mjs
const { fakeHindsight } = await import("../../../e2e/fixtures/fake-hindsight.mjs");

const agentId = "hs1";
db.prepare("INSERT OR IGNORE INTO agents(id, name, avatar, color, persona, created_at, memory_provider) VALUES(?,?,?,?,?,?,?)").run(agentId, "测试", "🧪", "#888", "", Date.now(), "hindsight");

test("Hindsight 后端：同步队列、回退、恢复补写、编辑/遗忘、导出导入、重建", async () => {
	const fake = fakeHindsight("rk");
	const port = await fake.start();
	// 先在 Hindsight 不可用时写入：进队列，检索回退到 basic
	settings.saveHindsightSettings({ mode: "remote", remoteUrl: `http://127.0.0.1:1`, remoteKey: "rk" });
	const a = await memory.remember(agentId, null, { content: "我住在杭州西湖边", kind: "fact", scope: "agent" });
	assert.ok(pendingCount() >= 1, "不可用时写入应排队");
	const fb = await memory.recall(agentId, null, "杭州西湖", 5);
	assert.ok(fb.some((x) => x.id === a.id && x.text === "我住在杭州西湖边"), "回退 basic 全文检索");
	// 恢复（指向假服务）→ 补写
	settings.saveHindsightSettings({ remoteUrl: `http://127.0.0.1:${port}` });
	await sidecar.restart();
	assert.equal(sidecar.status.state, "ready", sidecar.status.detail);
	await flush();
	assert.equal(pendingCount(), 0);
	assert.equal(fake.banks.get(`agent_${agentId}`)?.get(a.id), "我住在杭州西湖边");
	const hits = await memory.recall(agentId, null, "杭州", 5);
	assert.equal(hits[0].id, a.id);
	assert.equal(hits[0].text, "【抽取】我住在杭州西湖边", "检索结果来自 Hindsight，映射回账本 id");
	// 编辑 = 同一 documentId 重新写入
	await memory.update(agentId, a.id, { text: "我住在杭州滨江" });
	await flush();
	assert.equal(fake.banks.get(`agent_${agentId}`)?.get(a.id), "我住在杭州滨江");
	// 注入：账本事实 + 心智模型
	const ctx = await memory.context(agentId, null, "你好");
	assert.match(ctx, /杭州滨江/);
	assert.match(ctx, /用户偏好简洁/);
	// 遗忘
	assert.ok(await memory.forget(agentId, a.id));
	await flush();
	assert.ok(!fake.banks.get(`agent_${agentId}`)?.has(a.id));
	assert.ok(!(await memory.recall(agentId, null, "杭州", 5)).some((x) => x.id === a.id));
	// 导入（统一格式）→ 账本 + Hindsight 都有
	const n = await memory.importAgent(agentId, { format: "pi-assistant-memory/1", bank: "x", items: [{ id: "old", text: "我养了一只猫叫咪咪", createdAt: new Date().toISOString(), meta: { kind: "fact" } }] });
	assert.equal(n, 1);
	await flush();
	assert.ok([...fake.banks.get(`agent_${agentId}`)!.values()].includes("我养了一只猫叫咪咪"));
	const exp = await memory.exportAgent(agentId);
	assert.deepEqual(exp.agent.items.map((i) => i.text), ["我养了一只猫叫咪咪"]);
	// 换向量模型 → 删库重建，用账本原文重新写入
	const before = fake.calls.filter((c: string) => c === `DELETE /v1/default/banks/agent_${agentId}`).length;
	settings.saveHindsightSettings({ embedding: { kind: "local", model: "BAAI/bge-m3" } });
	await resyncAll();
	assert.equal(fake.calls.filter((c: string) => c === `DELETE /v1/default/banks/agent_${agentId}`).length, before + 1);
	assert.ok([...fake.banks.get(`agent_${agentId}`)!.values()].includes("我养了一只猫叫咪咪"));
	// 崩溃：健康检查连续失败 → down，读走 basic，写入排队；恢复后补写
	await fake.stop();
	await sidecar.tick();
	await sidecar.tick();
	assert.equal(sidecar.status.state, "down");
	await memory.remember(agentId, null, { content: "明天下午三点开会", kind: "note", scope: "agent" });
	assert.ok(pendingCount() >= 1);
	assert.ok((await memory.recall(agentId, null, "下午三点开会", 5)).length >= 1, "down 时检索走 basic");
	await sidecar.stop();
});

test("先用 basic 记、后切到 Hindsight（切换时它还没就绪）：就绪后自动补写旧记忆", async () => {
	const id2 = "hs2";
	db.prepare("INSERT OR IGNORE INTO agents(id, name, avatar, color, persona, created_at, memory_provider) VALUES(?,?,?,?,?,?,?)").run(id2, "测试2", "🧪", "#888", "", Date.now(), "basic");
	const old = await memory.remember(id2, null, { content: "我每天早上跑步", kind: "fact", scope: "agent" });
	db.prepare("UPDATE agents SET memory_provider = 'hindsight' WHERE id = ?").run(id2);
	assert.notEqual(sidecar.status.state, "ready");
	await memory.list(id2); // 打开记忆页：此时 Hindsight 未就绪
	const fake = fakeHindsight("rk");
	const port = await fake.start();
	settings.saveHindsightSettings({ mode: "remote", remoteUrl: `http://127.0.0.1:${port}`, remoteKey: "rk" });
	try {
		await sidecar.restart();
		assert.equal(sidecar.status.state, "ready", sidecar.status.detail);
		for (let i = 0; i < 40 && !fake.banks.get(`agent_${id2}`)?.has(old.id); i++) await new Promise((r) => setTimeout(r, 50));
		assert.equal(fake.banks.get(`agent_${id2}`)?.get(old.id), "我每天早上跑步");
	} finally {
		await sidecar.stop();
		await fake.stop();
	}
});

test("自动挑选记忆用模型：同渠道里便宜快速的优先", () => {
	const ms = [
		{ provider: "openai", id: "gpt-5" },
		{ provider: "openai", id: "gpt-5-mini" },
		{ provider: "deepseek", id: "deepseek-v4-flash" },
	];
	assert.deepEqual(settings.pickMemoryModel(ms, { provider: "openai", id: "gpt-5" }), { provider: "openai", id: "gpt-5-mini" });
	assert.deepEqual(settings.pickMemoryModel(ms, { provider: "anthropic", id: "x" }), { provider: "openai", id: "gpt-5-mini" });
	assert.deepEqual(settings.pickMemoryModel([{ provider: "a", id: "big" }], { provider: "a", id: "big" }), { provider: "a", id: "big" });
	assert.equal(settings.pickMemoryModel([], null), null);
});

test("附属进程环境：HOME/缓存/模型都在我们的数据目录；外部 Python/uv/Hindsight 变量被清掉；密钥不进环境", () => {
	process.env.PYTHONPATH = "/evil";
	process.env.UV_INDEX_URL = "https://evil.example/simple";
	process.env.HINDSIGHT_API_LLM_API_KEY = "user-own-key";
	process.env.VIRTUAL_ENV = "/home/u/.venv";
	const env = sidecarEnv({ s: settings.DEFAULTS, sec: { tenantKey: "tk" }, mirror: "china", proxyUrl: "http://127.0.0.1:9/v1", proxyToken: "pt", uvDir: "/x/bin" });
	for (const k of ["HOME", "USERPROFILE", "UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR", "HF_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) assert.ok(env[k]!.startsWith(config.dataDir), `${k}=${env[k]}`);
	assert.equal(env.PYTHONPATH, "");
	assert.equal(env.VIRTUAL_ENV, "");
	assert.equal(env.UV_INDEX_URL, "");
	assert.equal(env.HINDSIGHT_API_LLM_API_KEY, "pt", "模型密钥只是网关的一次性令牌");
	assert.equal(env.HINDSIGHT_API_LLM_BASE_URL, "http://127.0.0.1:9/v1");
	assert.equal(env.UV_DEFAULT_INDEX, "https://pypi.tuna.tsinghua.edu.cn/simple");
	assert.equal(env.HF_ENDPOINT, "https://hf-mirror.com");
	assert.ok(env.PATH!.startsWith("/x/bin"));
	assert.equal(env.HINDSIGHT_API_TENANT_API_KEY, "tk");
	assert.equal(env.HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_ID, "intfloat/multilingual-e5-small");
	assert.equal(env.HINDSIGHT_API_RERANKER_PROVIDER, "flashrank");
	assert.ok(env.HINDSIGHT_API_RERANKER_FLASHRANK_CACHE_DIR!.startsWith(paths().root));
	for (const k of ["PYTHONPATH", "UV_INDEX_URL", "HINDSIGHT_API_LLM_API_KEY", "VIRTUAL_ENV"]) delete process.env[k];
	assert.throws(() => settings.saveHindsightSettings({ embedding: { kind: "openai", baseUrl: "", model: "" } }), /向量接口/);
	setSetting("hindsight", {});
});
