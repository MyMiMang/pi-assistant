/**
 * Pi 1.2.0 的自定义模型服务验证：真实本地 HTTP 中转（loopback）+ 假 Key。
 *
 * 1. 自定义 provider 的结构由 Pi 自己解析 / 校验（models.json，不写 Key）；Key 只进凭据存储。
 * 2. 「进程重启」= 用同一份 models.json + 同一份内存凭据新建 PiModels，模型目录能重建，
 *    request-time 才解析假 Key（不 fork SDK、不加私有补丁）。
 * 3. 即使没有任何 Key，Pi 也能解析 models.json 的 schema（模型列表照常出现）——
 *    证明解析不需要真实凭据，调用所需的 Key 全部来自注入的假凭据。
 *
 * 不连真实云服务 / 不用真实 Key / 数据目录是临时目录。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { startMockOpenAI } from "../../../e2e/mock-openai.mjs";
import { config } from "../src/config.ts";
import { customProviders, initModels, models } from "../src/models.ts";
import { PiModels } from "../src/pi-adapter/index.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

const relay = await startMockOpenAI({ key: "sk-fake-1.2" });
after(() => relay.close());
const store = memoryCredentialStore();
await initModels(store);

test("自定义 provider：假 Key 只进凭据存储，结构写进 Pi 的 models.json 且由 Pi 解析", async () => {
	const meta = await customProviders.save(null, { name: "1.2 验证", api: "openai-completions", baseUrl: relay.url, apiKey: "sk-fake-1.2", models: [{ id: "relay-chat" }] });
	const file = readFileSync(join(config.dataDir, "models.json"), "utf8");
	assert.ok(!file.includes("sk-fake-1.2"), "models.json 不能有 Key");
	const p = JSON.parse(file).providers[meta.id];
	assert.ok(p, "models.json 里应有这个 provider");
	assert.equal(p.baseUrl, relay.url);
	assert.equal(p.api, "openai-completions");
	const entry = p.models.find((m: { id: string }) => m.id === "relay-chat");
	assert.ok(entry, "模型写在 models.json 里");
	assert.equal(entry.limitsSource, undefined, "我们自己的元数据字段不写进 Pi 的 models.json");
	// 模型目录来自 Pi 自己的 registry（读的就是这份 models.json）
	assert.ok(models.listModels(meta.id).some((m) => m.id === "relay-chat"));
});

test("重启 reload：新 PiModels 从同一 models.json 重建目录，假 Key 在 request-time 解析", async () => {
	const id = customProviders.list()[0].id;
	// 模拟进程重启：同一 models.json + 同一份内存凭据，全新 runtime
	const fresh = await PiModels.create({ credentials: store, modelsPath: join(config.dataDir, "models.json"), allowNetwork: false });
	assert.ok(fresh.listModels(id).some((m) => m.id === "relay-chat"), "重启后模型目录仍在");
	const r = await fresh.test(id, "relay-chat");
	assert.ok(r.ok, r.message);
	assert.match(r.message, /中转站回复/, "真的是走本地 HTTP 中转拿到回复");
	// 生产里的 reload 路径：再跑一次 initModels（复用注入的凭据后端）也不丢
	await initModels();
	assert.ok(models.listModels(id).some((m) => m.id === "relay-chat"));
});

test("没有 Key 也能解析 models.json（schema 不依赖凭据）；调用失败只因为凭据是假的", async () => {
	const id = customProviders.list()[0].id;
	const noKey = await PiModels.create({ credentials: memoryCredentialStore(), modelsPath: join(config.dataDir, "models.json"), allowNetwork: false });
	assert.ok(noKey.listModels(id).some((m) => m.id === "relay-chat"), "无凭据仍能解析 schema 与列出模型");
	const bad = await noKey.test(id, "relay-chat");
	assert.equal(bad.ok, false, "没有凭据时调用失败（说明 Key 只来自注入的凭据存储）");
	await customProviders.remove(id);
});
