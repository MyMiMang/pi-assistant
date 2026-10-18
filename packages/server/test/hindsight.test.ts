/**
 * Hindsight 后端（离线）：用一个假的 Hindsight HTTP 服务（远程模式，跳过安装）测
 * 同步队列、断线回退 basic、恢复后补写、遗忘/编辑、导出导入、向量模型变更后重建、自动挑选记忆模型、附属进程环境隔离。
 */
process.env.PIA_MOCK = "1";
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
const { db, setSetting } = await import("../src/db.ts");
const { memoryCredentialStore } = await import("./in-memory-credentials.ts");
const modelsMod = await import("../src/models.ts");
await modelsMod.initModels(memoryCredentialStore());
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

test("运行中掉线 → 先记进基础记忆、标记待同步、健康报问题；恢复后补写，什么都不丢；召回两个库并行；一轮结束自动写入；测试按钮三步", async () => {
	const { memoryHealth, resetHealth, setNotifier } = await import("../src/memory/hindsight/health.ts");
	const { memorySelfTest } = await import("../src/routes/memory.ts");
	resetHealth();
	const notes: string[] = [];
	setNotifier((n) => notes.push(n.title));
	const id3 = "hs3";
	db.prepare("INSERT OR IGNORE INTO agents(id, name, avatar, color, persona, created_at, memory_provider) VALUES(?,?,?,?,?,?,?)").run(id3, "测试3", "🧪", "#888", "", Date.now(), "hindsight");
	let fake = fakeHindsight("rk");
	const port = await fake.start();
	settings.saveHindsightSettings({ mode: "remote", remoteUrl: `http://127.0.0.1:${port}`, remoteKey: "rk" });
	try {
		await sidecar.restart();
		assert.equal(sidecar.status.state, "ready", sidecar.status.detail);
		await memory.remember(id3, null, { content: "我喜欢喝乌龙茶", kind: "fact", scope: "agent" });
		await flush();
		// 召回：用户库和助理库并行查（两个都发出去）
		fake.calls.length = 0;
		await memory.recall(id3, null, "乌龙茶", 5);
		assert.ok(fake.calls.filter((c: string) => c.endsWith("/memories/recall")).length >= 1);
		// 一轮结束自动写入（群聊头去掉，只记真实用户消息 + 最终回复）
		await memory.retainTurn(id3, "c1", { user: "（群聊「x」）\n【用户】周末去苏州\n——\n说明", assistant: "好的，苏州天气晴" });
		const turn = [...(fake.banks.get(`agent_${id3}`) ?? new Map())].find(([k]) => String(k).startsWith("turn:c1:"));
		assert.ok(turn, "一轮写进助理自己的库");
		assert.match(turn![1], /周末去苏州/);
		assert.doesNotMatch(turn![1], /群聊|说明/);
		assert.ok((fake.docTags.get(`agent_${id3}`)?.get(turn![0]) ?? []).length > 0, "带上分层标签");
		await memory.retainTurn(id3, "c1", { user: "密码：hunter2abc", assistant: "好的" });
		assert.equal([...(fake.banks.get(`agent_${id3}`) ?? new Map()).keys()].filter((k) => String(k).startsWith("turn:")).length, 1, "像密钥的不写");
		// 测试按钮：多轮工具调用 / JSON / 真实召回 三步，每步有耗时
		const steps = await memorySelfTest({ provider: "mock", id: "echo" });
		assert.deepEqual(steps.map((x) => x.name), ["多轮工具调用", "JSON 输出", "真实召回"]);
		assert.ok(steps.every((x) => x.ok && x.ms >= 0), JSON.stringify(steps));
		// 掉线：写入先进账本 + 队列，召回退回基础记忆，健康变 failing 并通知
		await fake.stop();
		const lost = await memory.remember(id3, null, { content: "我下个月搬去成都", kind: "fact", scope: "agent" });
		for (let i = 0; i < 3; i++) {
			const hits = await memory.recall(id3, null, "成都", 5);
			assert.ok(hits.some((x) => x.id === lost.id), "掉线时召回退回基础记忆，刚写的也能找到");
		}
		assert.ok(pendingCount() >= 1, "掉线时写入排队");
		assert.equal(memoryHealth().level, "failing", memoryHealth().summary);
		assert.ok(notes.includes("高级记忆出问题了"));
		// 恢复（同一端口、数据还在）→ 补写，队列清空，Hindsight 里有这条
		fake = fakeHindsight("rk", port);
		const banks0 = fake.banks;
		await fake.start();
		await sidecar.restart();
		assert.equal(sidecar.status.state, "ready", sidecar.status.detail);
		for (let i = 0; i < 60 && pendingCount() > 0; i++) await new Promise((r) => setTimeout(r, 50));
		await flush();
		assert.equal(pendingCount(), 0, "恢复后队列清空");
		assert.equal(banks0.get(`agent_${id3}`)?.get(lost.id), "我下个月搬去成都", "掉线期间写的补进 Hindsight");
		for (let i = 0; i < 3; i++) await memory.recall(id3, null, "成都", 5);
		assert.notEqual(memoryHealth().level, "failing");
		assert.ok(notes.includes("高级记忆已恢复"));
	} finally {
		setNotifier(() => {});
		resetHealth();
		await (await import("../src/llm-proxy.ts")).stopLlmProxy();
		await sidecar.stop();
		await fake.stop().catch(() => {});
	}
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
	assert.equal(env.HINDSIGHT_API_RERANKER_MAX_CANDIDATES, "50", "本地重排序限候选数（官方配置项），CPU 上召回不再动辄几十秒");
	assert.ok(env.HINDSIGHT_API_RERANKER_FLASHRANK_CACHE_DIR!.startsWith(paths().root));
	for (const k of ["PYTHONPATH", "UV_INDEX_URL", "HINDSIGHT_API_LLM_API_KEY", "VIRTUAL_ENV"]) delete process.env[k];
	assert.throws(() => settings.saveHindsightSettings({ embedding: { kind: "openai", baseUrl: "", model: "" } }), /向量接口/);
	setSetting("hindsight", {});
});
