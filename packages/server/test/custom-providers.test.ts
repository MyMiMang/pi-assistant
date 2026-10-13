import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { startMockOpenAI } from "../../../e2e/mock-openai.mjs";
import { config } from "../src/config.ts";
import { customProviders, initModels, models } from "../src/models.ts";
import { supportedApis } from "../src/pi-adapter/custom-providers.ts";

const relay = await startMockOpenAI({ port: 18081, key: "sk-unit", requiredHeader: ["x-team", "t1"] });
after(() => relay.close());
await initModels();

test("API 类型来自 pi-ai 注册表", () => {
	const ids = supportedApis().map((a) => a.id);
	assert.ok(ids.includes("openai-completions") && ids.includes("anthropic-messages"));
});

test("自定义服务：自动获取模型 → 保存到 Pi models.json → 测试连接 → 编辑 → 删除", async () => {
	const fetched = await customProviders.fetchModels({ api: "openai-completions", baseUrl: relay.url, apiKey: "sk-unit", headers: [{ name: "x-team", value: "t1" }] });
	assert.deepEqual(fetched.map((m) => m.id), ["relay-chat", "relay-pro"]);
	assert.deepEqual(fetched[0], { id: "relay-chat", contextWindow: 65536, maxTokens: 4096, limitsSource: "detected" });
	assert.deepEqual(fetched[1], { id: "relay-pro", contextWindow: 128_000, maxTokens: 8192, limitsSource: "default" });
	const meta = await customProviders.save(null, {
		name: "Relay",
		api: "openai-completions",
		baseUrl: relay.url,
		apiKey: "sk-unit",
		headers: [{ name: "x-team", value: "t1" }],
		models: [{ id: "relay-chat" }],
	});
	assert.equal(meta.id, "custom-relay");
	const file = readFileSync(join(config.dataDir, "models.json"), "utf8");
	assert.ok(file.includes('"custom-relay"') && !file.includes("sk-unit") && !file.includes('"t1"'), "Key 和请求头值不应明文写入 models.json");
	assert.ok(models.listProviders().find((p) => p.id === "custom-relay")?.configured);
	const r = await models.test("custom-relay", "relay-chat");
	assert.ok(r.ok, r.message);
	assert.match(r.message, /中转站回复/);
	// 编辑：留空 Key 与请求头值 = 保持不变，新增一个模型
	await customProviders.save("custom-relay", { name: "Relay 2", api: "openai-completions", baseUrl: relay.url, headers: [{ name: "x-team" }], models: [{ id: "relay-chat" }, { id: "relay-pro" }] });
	assert.equal(models.listModels("custom-relay").length, 2);
	assert.ok((await models.test("custom-relay", "relay-pro")).ok);
	assert.ok(await customProviders.remove("custom-relay"));
	assert.equal(models.listProviders().some((p) => p.id === "custom-relay"), false);
});

test("错误的 Key 会在测试连接时如实报错", async () => {
	await customProviders.save(null, { name: "Bad", api: "openai-completions", baseUrl: relay.url, apiKey: "sk-wrong", models: [{ id: "relay-chat" }] });
	const r = await models.test("custom-bad", "relay-chat");
	assert.equal(r.ok, false);
	await customProviders.remove("custom-bad");
});

test("多个自定义服务（含中文名、同名）各有独立 id，不会互相覆盖；模型列表带用户起的服务名", async () => {
	const base = { api: "openai-completions", baseUrl: relay.url, apiKey: "sk-unit", headers: [{ name: "x-team", value: "t1" }] };
	const a = await customProviders.save(null, { ...base, name: "灯灯国产", models: [{ id: "relay-chat" }] });
	const b = await customProviders.save(null, { ...base, name: "另一家中转", models: [{ id: "relay-chat" }] });
	const c = await customProviders.save(null, { ...base, name: "灯灯国产", models: [{ id: "relay-pro" }] });
	assert.notEqual(a.id, "custom-provider");
	assert.equal(new Set([a.id, b.id, c.id]).size, 3, `${a.id} ${b.id} ${c.id}`);
	const list = customProviders.list();
	for (const m of [a, b, c]) assert.ok(list.some((x) => x.id === m.id), `${m.id} 被覆盖了`);
	assert.equal(list.find((x) => x.id === b.id)?.name, "另一家中转");
	const { providerNames, withProviderName } = await import("../src/models.ts");
	const names = providerNames();
	const ms = models.listModels().map((m) => withProviderName(m, names));
	assert.equal(ms.find((m) => m.provider === a.id)?.providerName, "灯灯国产");
	assert.equal(ms.find((m) => m.provider === b.id)?.providerName, "另一家中转");
	for (const m of [a, b, c]) await customProviders.remove(m.id);
});

test("上下文长度：保存时补齐（已知模型 / 默认）、用户填写优先；写进 Pi 的模型（会话的上下文用量和自动压缩用它），不带我们自己的字段", async () => {
	const base = { api: "openai-completions", baseUrl: relay.url, apiKey: "sk-unit", headers: [{ name: "x-team", value: "t1" }] };
	const m = await customProviders.save(null, {
		...base,
		name: "长度测试",
		models: [{ id: "deepseek-v4.1-flash" }, { id: "my-private-model" }, { id: "relay-chat", contextWindow: 32000, maxTokens: 2000, limitsSource: "user" }, { id: "Qwen/Qwen3-235B-A22B" }],
	});
	const by = Object.fromEntries(m.models.map((x) => [x.id, x]));
	assert.equal(by["deepseek-v4.1-flash"].limitsSource, "known");
	assert.ok(by["deepseek-v4.1-flash"].contextWindow! >= 128_000, "用 Pi 内置目录里的真实长度");
	assert.deepEqual([by["my-private-model"].contextWindow, by["my-private-model"].maxTokens, by["my-private-model"].limitsSource], [128_000, 8192, "default"]);
	assert.deepEqual([by["relay-chat"].contextWindow, by["relay-chat"].maxTokens, by["relay-chat"].limitsSource], [32000, 2000, "user"]);
	assert.equal(by["Qwen/Qwen3-235B-A22B"].limitsSource, "known");
	const cfg = JSON.parse(readFileSync(join(config.dataDir, "models.json"), "utf8"));
	const rc = cfg.providers[m.id].models.find((x: { id: string }) => x.id === "relay-chat");
	assert.equal(rc.contextWindow, 32000);
	assert.equal(rc.limitsSource, undefined, "Pi 的 models.json 不写我们自己的字段");
	const live = models.listModels(m.id).find((x) => x.id === "relay-chat")!;
	assert.equal(live.contextWindow, 32000);
	assert.equal(live.maxTokens, 2000);
	await customProviders.remove(m.id);
});

test("旧数据没有上下文长度：启动时补齐并写回", async () => {
	const base = { api: "openai-completions", baseUrl: relay.url, apiKey: "sk-unit", headers: [{ name: "x-team", value: "t1" }] };
	const m = await customProviders.save(null, { ...base, name: "旧数据", models: [{ id: "glm-4.6" }] });
	// 模拟旧版本：元数据和 models.json 都没有长度
	const { getSetting, setSetting } = await import("../src/db.ts");
	const metas = getSetting<{ id: string; models: Record<string, unknown>[] }[]>("customProviders", []);
	setSetting("customProviders", metas.map((x) => (x.id === m.id ? { ...x, models: [{ id: "glm-4.6" }] } : x)));
	const p = join(config.dataDir, "models.json");
	const cfg = JSON.parse(readFileSync(p, "utf8"));
	cfg.providers[m.id].models = [{ id: "glm-4.6" }];
	writeFileSync(p, JSON.stringify(cfg));
	await models.reloadConfig();
	assert.ok((await customProviders.backfillLimits()) >= 1);
	const live = models.listModels(m.id).find((x) => x.id === "glm-4.6")!;
	assert.ok(live.contextWindow! >= 128_000);
	assert.equal(customProviders.list().find((x) => x.id === m.id)!.models[0].limitsSource, "known");
	await customProviders.remove(m.id);
});
