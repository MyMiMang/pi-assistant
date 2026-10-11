import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
	assert.deepEqual(fetched, ["relay-chat", "relay-pro"]);
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
