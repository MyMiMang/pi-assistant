/**
 * 推理档位回归：自定义服务的模型若和 Pi 内置目录里的同名模型一致，就照搬 Pi 的 thinkingLevelMap，
 * 让界面档位（getSupportedThinkingLevels）、切换 clamp 和真正发出去的 reasoning 参数三者一致，
 * 含 xhigh / max；认不出来的模型保持 Pi 默认档位，不凭空补。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { startMockOpenAI } from "../../../e2e/mock-openai.mjs";
import { config } from "../src/config.ts";
import { customProviders, initModels, models } from "../src/models.ts";
import { createPiSession, lastAssistantText, promptSession } from "../src/pi-adapter/index.ts";
import { knownThinkingLevelMap } from "../src/pi-adapter/model-limits.ts";

const relay = await startMockOpenAI({ port: 0, key: "sk-unit" });
after(() => relay.close());
await initModels((await import("./in-memory-credentials.ts")).memoryCredentialStore());

test("自定义服务：同名不猜档位，只按渠道明确声明的高档注册", async () => {
	const p = await customProviders.save(null, {
		name: "档位测试",
		api: "openai-completions",
		baseUrl: relay.url,
		apiKey: "sk-unit",
		models: [{ id: "gpt-6.1-sol", reasoning: true }, { id: "my-private-model", reasoning: true }],
		capabilityScope: { api: "openai-completions", baseUrl: relay.url, source: "临时渠道契约", appliesTo: ["my-private-model"], defaults: { levels: { high: "high", xhigh: "documented-xhigh" } } },
	});
	try {
		const by = Object.fromEntries(models.listModels(p.id).map((m) => [m.id, m]));
		assert.equal(by["gpt-6.1-sol"].thinkingLevelMap, undefined, "别的渠道同名不是证据");
		assert.ok(!by["gpt-6.1-sol"].thinking.includes("xhigh") && !by["gpt-6.1-sol"].thinking.includes("max"));
		assert.deepEqual(by["my-private-model"].thinking, ["high", "xhigh"]);
		assert.equal(models.clampThinking(p.id, "my-private-model", "xhigh"), "xhigh");
		const cfg = JSON.parse(readFileSync(join(config.dataDir, "models.json"), "utf8"));
		assert.deepEqual(cfg.providers[p.id].models.find((m: { id: string }) => m.id === "my-private-model").thinkingLevelMap, { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: "documented-xhigh", max: null });
	} finally {
		await customProviders.remove(p.id);
	}
});

test("未知/显式覆盖：用户子集保存、刷新及扩展重注册不丢，恢复自动清除手工 map", async () => {
	const id = "unknown-future-model";
	const base = { name: "用户档位", api: "openai-completions", baseUrl: relay.url, apiKey: "sk-unit" };
	let p = await customProviders.save(null, { ...base, models: [{ id }] });
	try {
		assert.equal(p.models[0].reasoning, undefined);
		assert.deepEqual(models.supportedThinking(p.id, id), ["off"]);
		assert.equal(customProviders.withLimits({ id, reasoning: true, reasoningAuto: true }).reasoning, undefined, "自动旧结果无证据时回到未知");
		const partial = { high: "documented-high" };
		p = await customProviders.save(p.id, { ...base, models: [{ id, reasoning: true, thinkingLevelSource: "user", thinkingLevelMap: partial }], classifiers: [{ protocol: "typesafe-system-one", modelId: "test-classifier" }] });
		assert.deepEqual(models.supportedThinking(p.id, id), ["high"]);
		assert.equal(models.clampThinking(p.id, id, "max"), "high");
		assert.equal(models.clampThinking(p.id, id, "low"), "high");
		assert.equal(models.clampThinking(p.id, id, "off"), "high", "未声明关闭时 SDK 收敛到唯一支持档");
		await customProviders.backfillLimits();
		await models.reloadConfig();
		customProviders.reapplyClassifiers();
		assert.deepEqual(models.supportedThinking(p.id, id), ["high"]);
		assert.equal(customProviders.list().find((m) => m.id === p.id)!.models[0].thinkingLevelSource, "user");
		assert.equal(customProviders.list().find((m) => m.id === p.id)!.models[0].thinkingLevelMap!.high, "documented-high");
		p = await customProviders.save(p.id, { ...base, models: [{ id, reasoning: true, thinkingLevelSource: "user", thinkingLevelMap: { high: "high", max: "documented-max" } }] });
		assert.deepEqual(models.supportedThinking(p.id, id), ["high", "max"]);
		p = await customProviders.save(p.id, { ...base, models: [{ ...p.models[0], reasoning: false }] });
		assert.deepEqual(models.supportedThinking(p.id, id), ["off"]);
		assert.equal(p.models[0].thinkingLevelMap, undefined);
		p = await customProviders.save(p.id, { ...base, models: [{ id, reasoning: true }] });
		assert.equal(p.models[0].reasoningAuto, undefined);
		assert.equal(p.models[0].thinkingLevelMap, undefined);
		assert.deepEqual(models.supportedThinking(p.id, id), ["off", "minimal", "low", "medium", "high"]);
		p = await customProviders.save(p.id, { ...base, models: [{ id }] });
		assert.equal(p.models[0].reasoning, undefined);
		assert.equal(p.models[0].thinkingLevelSource, undefined);
		const cfg = JSON.parse(readFileSync(join(config.dataDir, "models.json"), "utf8"));
		assert.equal(cfg.providers[p.id].models[0].thinkingLevelMap, undefined);
	} finally {
		await customProviders.remove(p.id);
	}
});

test("手工映射优先同名目录，空白/非法协议值和无思考子集拒绝保存", () => {
	const m = customProviders.withLimits({ id: "gpt-6.1-sol", reasoning: true, thinkingLevelSource: "user", thinkingLevelMap: { low: "custom-low" } });
	assert.equal(m.thinkingLevelSource, "user");
	assert.equal(m.thinkingLevelMap!.low, "custom-low");
	assert.equal(m.thinkingLevelMap!.max, null);
	const input = { name: "校验", api: "openai-completions", baseUrl: relay.url, models: [{ id: "unknown-future-model", reasoning: true, thinkingLevelSource: "user", thinkingLevelMap: { high: "" } }] };
	assert.match(customProviders.validate(input)!, /协议值/);
	assert.match(customProviders.validate({ ...input, models: [{ ...input.models[0], thinkingLevelMap: { off: "none" } }] })!, /至少选择一个/);
	assert.match(customProviders.validate({ ...input, models: [{ ...input.models[0], thinkingLevelMap: { invalid: "high" } }] })!, /无效/);
});

test("旧自动目录映射启动后不再算渠道证据，原记录不改写", async () => {
	const p = await customProviders.save(null, { name: "旧档位", api: "openai-completions", baseUrl: relay.url, noKey: true, models: [{ id: "gpt-6.1-sol", reasoning: true }] });
	try {
		// 旧版已保存的同名目录映射，不是用户选择或当前渠道契约。
		const { getSetting, setSetting } = await import("../src/db.ts");
		const metas = getSetting<{ id: string; models: Record<string, unknown>[] }[]>("customProviders", []);
		const previous = { id: "gpt-6.1-sol", reasoning: true, reasoningAuto: true, thinkingLevelSource: "old-catalog", thinkingLevelMap: { xhigh: "xhigh", max: "max" } };
		setSetting("customProviders", metas.map((x) => (x.id === p.id ? { ...x, models: [previous] } : x)));
		const cfgPath = join(config.dataDir, "models.json");
		const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
		cfg.providers[p.id].models = [{ id: "gpt-6.1-sol", reasoning: true }];
		writeFileSync(cfgPath, JSON.stringify(cfg));
		await models.reloadConfig();
		assert.deepEqual(models.listModels(p.id).find((m) => m.id === "gpt-6.1-sol")!.thinking, ["off", "minimal", "low", "medium", "high"], "补齐前是 Pi 默认档位");
		assert.ok((await customProviders.backfillLimits()) >= 1);
		const live = models.listModels(p.id).find((m) => m.id === "gpt-6.1-sol")!;
		assert.deepEqual(live.thinking, ["off"]);
		assert.equal(live.thinkingLevelMap, undefined);
		const retained = customProviders.list().find((x) => x.id === p.id)!.models[0];
		assert.deepEqual(retained.thinkingLevelMap, previous.thinkingLevelMap);
		assert.equal(retained.thinkingLevelSource, previous.thinkingLevelSource);
		const { db } = await import("../src/db.ts");
		const { AgentRuntime } = await import("../src/agent-runtime/agent-runtime.ts");
		const agentId = "old-catalog-fixture-agent";
		db.prepare("INSERT INTO agents(id,name,avatar,color,model_provider,model_id,thinking,thinking_explicit,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(agentId, "目录旧档", "测", "blue", p.id, previous.id, "xhigh", 1, Date.now());
		try {
			const runtime = new AgentRuntime(agentId, "isolated-catalog-fixture");
			const result = await runtime.turn("不可降档的旧选择");
			assert.equal(result.ok, false);
			assert.match(result.error ?? "", /xhigh.*旧目录.*未发送/);
			assert.equal(runtime.session, null, "没有启动 SDK 请求");
			assert.equal((db.prepare("SELECT thinking FROM agents WHERE id=?").get(agentId) as { thinking: string }).thinking, "xhigh");
		} finally { db.prepare("DELETE FROM agents WHERE id=?").run(agentId); }
	} finally {
		await customProviders.remove(p.id);
	}
});

test("多托管商映射不一致：候选有歧义就不补；一致时记录 Pi 目录来源", () => {
	const ambiguous: Parameters<typeof knownThinkingLevelMap>[1] = [
		{ id: "m", provider: "openrouter", thinkingLevelMap: { low: "low", high: "high" } },
		{ id: "m", provider: "together", thinkingLevelMap: { low: "low", high: "high", max: "max" } },
	];
	assert.equal(knownThinkingLevelMap("m", ambiguous, "openai-completions"), undefined, "同协议候选映射不一致 → 保守不补，不按目录顺序假装事实");

	const consistent: Parameters<typeof knownThinkingLevelMap>[1] = [
		{ id: "m", provider: "openai", api: "openai-completions", thinkingLevelMap: { low: "low", high: "high", xhigh: "xhigh" } },
		{ id: "m", provider: "azure", api: "openai-responses", thinkingLevelMap: { low: "low", high: "high", xhigh: "xhigh" } },
	];
	const r = knownThinkingLevelMap("m", consistent, "openai-completions");
	assert.equal(r?.source, "openai:m@openai-completions", "记录 SDK 元数据来源（provider:id@api）");
	assert.equal(r?.map.xhigh, "xhigh");
	assert.equal(knownThinkingLevelMap("unheard-of", consistent, "openai-completions"), undefined, "目录里没有的模型不补");
});

test("两种 OpenAI 协议真实请求：用户映射、关闭、false 与未知均按同一 spec 发出", async () => {
	for (const api of ["openai-completions", "openai-responses"]) {
		const base = { name: `真实请求-${api}`, api, baseUrl: relay.url, apiKey: "sk-unit" };
		const cases = [
			{ id: "unknown-future-supported", reasoning: true, thinkingLevelSource: "user", thinkingLevelMap: { off: "none", high: "documented-high" }, wanted: "high", effort: "documented-high" },
			{ id: "unknown-future-off", reasoning: true, thinkingLevelSource: "user", thinkingLevelMap: { off: "none", high: "high" }, wanted: "off", effort: "none" },
			{ id: "unknown-future-off-default", reasoning: true, wanted: "off", effort: api === "openai-responses" ? "none" : undefined },
			{ id: "unknown-future-disabled", reasoning: false, wanted: "high", effort: undefined },
			{ id: "unknown-future-unrecognized", wanted: "max", effort: undefined },
		];
		const p = await customProviders.save(null, { ...base, models: cases });
		try {
			for (const c of cases) {
				const dir = join(config.workspaceRoot, `${api}-${c.id}`);
				mkdirSync(dir, { recursive: true });
				const level = models.clampThinking(p.id, c.id, c.wanted);
				const session = await createPiSession({ models, cwd: dir, agentDir: dir, sessionDir: join(dir, "sessions"), model: { provider: p.id, id: c.id }, thinking: level, systemPromptAppend: [], extensions: [] });
				try {
					await promptSession(session, "验证本地请求");
					assert.ok(lastAssistantText(session), `${api}/${c.id} 应成功回复`);
				} finally { session.dispose(); }
				const path = api === "openai-responses" ? "/v1/responses" : "/v1/chat/completions";
				const sent = JSON.parse(relay.seen.filter((r) => r.url === path).at(-1)!.body);
				assert.equal(sent.model, c.id);
				assert.equal(api === "openai-responses" ? sent.reasoning?.effort : sent.reasoning_effort, c.effort, `${api}/${c.id}`);
			}
		} finally { await customProviders.remove(p.id); }
	}
});

test("请求参数：选 xhigh 时真的发 reasoning_effort=xhigh，不被 clamp 回 high", async () => {
	const p = await customProviders.save(null, {
		name: "请求参数测试",
		api: "openai-completions",
		baseUrl: relay.url,
		apiKey: "sk-unit",
		models: [{ id: "gpt-6.1-sol", reasoning: true, thinkingLevelSource: "user", thinkingLevelMap: { high: "high", xhigh: "xhigh" } }],
	});
	try {
		const ws = join(config.workspaceRoot, "think-levels");
		mkdirSync(ws, { recursive: true });
		const session = await createPiSession({
			models,
			cwd: ws,
			agentDir: join(config.agentsDir, "think-levels"),
			sessionDir: join(config.agentsDir, "think-levels", "sessions"),
			model: { provider: p.id, id: "gpt-6.1-sol" },
			thinking: models.clampThinking(p.id, "gpt-6.1-sol", "xhigh"),
			systemPromptAppend: [],
			extensions: [],
		});
		assert.equal(session.thinkingLevel, "xhigh", "会话档位保留 xhigh");
		await promptSession(session, "你好");
		assert.ok(lastAssistantText(session));
		session.dispose();
		const chats = relay.seen.filter((r) => r.url === "/v1/chat/completions");
		assert.ok(chats.length >= 1, "应该向中转站发过聊天请求");
		const body = JSON.parse(chats[chats.length - 1].body) as { model?: string; reasoning_effort?: string };
		assert.equal(body.model, "gpt-6.1-sol");
		assert.equal(body.reasoning_effort, "xhigh", "xhigh 必须真的发出去，而不是被 clamp 回 high");
	} finally {
		await customProviders.remove(p.id);
	}
});
