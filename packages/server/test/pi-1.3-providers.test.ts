/**
 * Pi 1.3.0 provider / 协议面回归（不连真实云）。
 *
 * 1. `kimi-coding` 在 1.3.0 从 Anthropic Messages 改成 OpenAI Chat Completions（upstream #10720）。
 *    我们的 provider / 协议全部来自 Pi 目录 metadata（`getApiProviders` / `runtime.getProviders`），
 *    所以只做「跟随 Pi 目录」的断言，不硬编码、不改用户配置。
 * 2. 我们写进 Pi models.json 的自定义服务 baseUrl 原样保留：不因为 1.3 的新要求（kimi-coding 覆盖要带 /v1）
 *    去给所有自定义中转补 /v1（只对官方 kimi-coding 目录生效，用户私有 relay 一律不动）。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { config } from "../src/config.ts";
import { customProviders, initModels, models } from "../src/models.ts";
import { PiModels } from "../src/pi-adapter/index.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

await initModels(memoryCredentialStore());

test("1.3 跟随 Pi 目录：kimi-coding 全部为 openai-completions（协议变更自动生效，不硬编码）", async () => {
	const models0 = models.listModels("kimi-coding");
	assert.ok(models0.length > 0, "Pi 目录应有 kimi-coding");
	for (const m of models0) assert.equal(m.api, "openai-completions", `${m.id} 应为 openai-completions（来自 Pi 目录）`);
	// 我们只用 Pi 目录暴露的协议列表，不自己写死 Anthropic
	const protocols = ["openai-completions", "anthropic-messages", "google-generative-ai", "openai-responses"];
	assert.ok(protocols.includes(models0[0].api ?? ""), "协议取自 Pi 的注册表");
});

test("1.3 不误伤私有中转：自定义服务 baseUrl 原样写入 models.json（不补 /v1）", async () => {
	const baseUrl = "https://relay.example.invalid/api"; // 故意不带 /v1
	const meta = await customProviders.save(null, { name: "1.3 中转", api: "openai-completions", baseUrl, apiKey: "sk-fake-1.3", models: [{ id: "relay-chat" }] });
	try {
		const file = readFileSync(join(config.dataDir, "models.json"), "utf8");
		assert.ok(!file.includes("sk-fake-1.3"), "Key 不写进 models.json");
		const entry = JSON.parse(file).providers[meta.id];
		assert.equal(entry.baseUrl, baseUrl, `自定义 baseUrl 应原样保留，实际：${entry.baseUrl}`);
		assert.ok(!/\/v1$/.test(entry.baseUrl), "不因为 1.3 给私有中转追加 /v1");
	} finally {
		await customProviders.remove(meta.id);
	}
});

test("1.3 自定义服务仍由 Pi 解析（无 Key 只影响调用，不影响目录）", async () => {
	const baseUrl = "https://relay.example.invalid/v1";
	const meta = await customProviders.save(null, { name: "1.3 直连", api: "openai-completions", baseUrl, apiKey: "sk-fake-1.3b", models: [{ id: "relay-chat-2" }] });
	try {
		const noKey = await PiModels.create({ credentials: memoryCredentialStore(), modelsPath: join(config.dataDir, "models.json"), allowNetwork: false });
		assert.ok(noKey.listModels(meta.id).some((m) => m.id === "relay-chat-2"), "无凭据仍能解析目录");
	} finally {
		await customProviders.remove(meta.id);
	}
});
