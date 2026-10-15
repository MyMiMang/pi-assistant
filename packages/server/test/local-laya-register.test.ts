/**
 * 本地 Laya classifier 注册集成测试（公开内存 CredentialStore + 内存 models.json）。
 *
 * 证明「一键安装后自动注册 → 快速操作模型能选中」这条链路成立，且：
 *  - 走 Pi 公开 `registerClassifiers`（不新建 chat 模型）；
 *  - token 只在进程内注入（`setRuntimeApiKey`），不写 models.json / 不落用户凭据文件；
 *  - 分类请求打到 loopback `/v1/systemone` 并带该 token；
 *  - 停止时 `removeRuntimeApiKey` + `unregisterProvider` 后目录里消失（fail-closed）。
 *
 * 不起真实 Laya、不下载任何依赖、不碰系统钥匙串。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { PiModels, type ClassifierContext } from "../src/pi-adapter/index.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

const seen: { url: string; authorization?: string }[] = [];
const server = createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (c) => chunks.push(c as Buffer));
	req.on("end", () => {
		seen.push({ url: req.url ?? "", authorization: req.headers.authorization });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ answers: { intent: { type: "choice", choice: "a", probabilities: { a: 0.92, b: 0.08 }, confidence: 0.92 } }, usage: { input_tokens: 3, output_tokens: 1 } }));
	});
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
after(() => {
	server.closeAllConnections();
	server.close();
});

const modelsPath = join(mkdtempSync(join(tmpdir(), "pia-laya-reg-")), "models.json");
const credentialStore = memoryCredentialStore();
const models = await PiModels.create({ credentials: credentialStore, modelsPath, allowNetwork: false });
const TOKEN = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const BASE = `http://127.0.0.1:${port}/v1/`;
const context: ClassifierContext = {
	state: { text: "点那个按钮" },
	questions: { intent: { type: "choice", instructions: "意图", criteria: { a: "点击", b: "取消" } } },
};

test("注册后出现在 classifier 目录，configured=true，且不新建 chat 模型", async () => {
	models.registerClassifiers("local-laya", [{ protocol: "typesafe-system-one", modelId: "multilingual", name: "本地 Laya · multilingual" }], { baseUrl: BASE, chatModels: [] });
	await models.setRuntimeApiKey("local-laya", TOKEN);
	const list = models.listClassifierModels("local-laya");
	const m = list.find((x) => x.id === "multilingual");
	assert.ok(m, "classifier 应进目录");
	assert.equal(m?.api, "typesafe-system-one");
	assert.equal(m?.configured, true);
	assert.equal(models.listModels("local-laya").length, 0, "不得新建 chat 模型");
});

test("分类请求打到 loopback /v1/systemone 并带进程内 token；token 不落 models.json", async () => {
	seen.length = 0;
	const res = await models.classify("local-laya", "multilingual", context);
	assert.equal(res.stopReason, "stop");
	assert.equal(seen.length, 1);
	assert.equal(seen[0].url, "/v1/systemone");
	assert.equal(seen[0].authorization, `Bearer ${TOKEN}`);
	// models.json 与凭据存储都不该出现 token 原文（仅内存 runtime override）
	const { readFileSync, existsSync } = await import("node:fs");
	if (existsSync(modelsPath)) assert.ok(!readFileSync(modelsPath, "utf8").includes(TOKEN), "models.json 不得包含 token");
	const listed = await credentialStore.list();
	assert.ok(!listed.some((c) => c.providerId === "local-laya"), "不得写入持久凭据存储");
});

test("停止：removeRuntimeApiKey + unregisterProvider 后目录里消失", async () => {
	models.unregisterProvider("local-laya");
	await models.removeRuntimeApiKey("local-laya");
	assert.equal(models.listClassifierModels("local-laya").length, 0);
});
