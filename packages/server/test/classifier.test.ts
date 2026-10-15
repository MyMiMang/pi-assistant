/**
 * classifier（System One / Jev）受限入口的集成测试。
 *
 * 用本地 HTTP mock 验证 pi-adapter 经 Pi `ModelRuntime.classify` 发出的真实请求：
 * 1) 只列 classifier 类型、只含安全元数据（无 baseUrl / headers / 凭据）；
 * 2) 每个 provider 按自己的凭据解析鉴权，绝不串用别的 provider 的 key；
 * 3) 返回中性结果，不含 headers / key；错误信息脱敏。
 *
 * 凭据只用临时 PIA_DATA_DIR + setRuntimeApiKey 写假值，不读任何真实配置。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
// 官方公开子路径导出：给自定义 fixture provider 接上真实的 System One 传输实现，
// 这样测试跑的是 Pi 真实的 HTTP 请求 / 鉴权解析，而不是桩。
import { classify as systemOneClassify } from "@earendil-works/pi-ai/api/typesafe-system-one";
import { PiModels, type ClassifierContext } from "../src/pi-adapter/index.ts";
import { EncryptedCredentialStore } from "../src/secrets.ts";

interface SeenRequest {
	url: string;
	method: string;
	authorization?: string;
	body: Record<string, unknown>;
}

const seen: SeenRequest[] = [];
let failWith: { status: number; body: string } | null = null;
let omitUsage = false;

const server = createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (c) => chunks.push(c as Buffer));
	req.on("end", () => {
		let body: Record<string, unknown> = {};
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
		} catch {
			/* 非 JSON 请求不关心 */
		}
		seen.push({ url: req.url ?? "", method: req.method ?? "", authorization: req.headers.authorization, body });
		if (failWith) {
			res.writeHead(failWith.status, { "content-type": "application/json" });
			res.end(failWith.body);
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				answers: {
					intent: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.9 },
					risky: { type: "noul", noul: 0.8 },
					urgency: { type: "score", score: 0.4, confidence: 0.7 },
				},
				...(omitUsage ? {} : { usage: { input_tokens: 12, output_tokens: 3 } }),
			}),
		);
	});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
after(() => {
	server.closeAllConnections();
	server.close();
});

const KEY_A = "sk-test-key-aaaa-0123456789abcdef";
const KEY_B = "sk-test-key-bbbb-0123456789abcdef";

const models = await PiModels.create({ credentials: new EncryptedCredentialStore(), modelsPath: null, allowNetwork: false });

function register(id: string, path: string) {
	models.registerProvider(id, {
		name: id,
		api: "typesafe-system-one",
		baseUrl: `http://127.0.0.1:${port}/${path}`,
		classifiers: { "typesafe-system-one": { classify: systemOneClassify } },
		models: [
			{ id: `${id}-jev`, name: `${id} Jev`, type: "classifier", api: "typesafe-system-one", input: ["text"], contextWindow: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
			{ id: `${id}-chat`, name: `${id} chat`, type: "chat", api: "openai-completions", input: ["text"], reasoning: false, contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
		],
	});
}
register("jevtest-a", "prov-a");
register("jevtest-b", "prov-b");
await models.setRuntimeApiKey("jevtest-a", KEY_A);
await models.setRuntimeApiKey("jevtest-b", KEY_B);
// Pi 的 provider 可用性检查是异步的，等它落定后再断言 configured。
await models.reloadConfig();

const context: ClassifierContext = {
	state: { text: "你好" },
	questions: {
		intent: { type: "choice", instructions: "意图", criteria: { a: "闲聊", b: "任务" } },
		risky: { type: "bool", instructions: "是否危险", criteria: { true: "危险", false: "安全" } },
		urgency: { type: "score", instructions: "紧急度", criteria: ["低", "高"] },
	},
};

test("listClassifierModels 只列 classifier，且只含安全元数据", () => {
	const list = models.listClassifierModels();
	const a = list.find((m) => m.id === "jevtest-a-jev");
	assert.ok(a, "自定义 classifier 模型应出现在目录里");
	assert.equal(a.provider, "jevtest-a");
	assert.equal(a.api, "typesafe-system-one");
	assert.equal(a.contextWindow, 8192);
	assert.equal(a.configured, true);
	assert.deepEqual(Object.keys(a).sort(), ["api", "configured", "contextWindow", "id", "input", "name", "provider"], "不得带 baseUrl / headers / 凭据");
	assert.ok(!list.some((m) => m.id === "jevtest-a-chat"), "chat 模型不应混进 classifier 目录");
	assert.ok(list.some((m) => m.id === "jevtest-b-jev"));
	assert.equal(models.listClassifierModels("jevtest-b").every((m) => m.provider === "jevtest-b"), true);
});

test("classify 经本地 mock 发请求：按 provider 解析鉴权、不混用，返回中性结果", async () => {
	seen.length = 0;
	const resA = await models.classify("jevtest-a", "jevtest-a-jev", context);
	assert.equal(resA.stopReason, "stop");
	assert.equal(resA.provider, "jevtest-a");
	assert.equal(resA.model, "jevtest-a-jev");
	assert.equal(resA.api, "typesafe-system-one");
	assert.deepEqual(resA.answers.intent, { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.9 });
	assert.deepEqual(resA.answers.risky, { type: "bool", probability: 0.8 }, "bool 问题按官方 noul 协议解析");
	assert.deepEqual(resA.answers.urgency, { type: "score", score: 0.4, confidence: 0.7 });
	assert.equal(resA.usage?.input, 12);
	assert.equal(resA.usage?.output, 3);
	assert.deepEqual(Object.keys(resA).sort(), ["answers", "api", "model", "provider", "stopReason", "timestamp", "usage"], "对外结果只有中性字段，不含 headers / key");

	const resB = await models.classify("jevtest-b", "jevtest-b-jev", context);
	assert.equal(resB.stopReason, "stop");

	assert.equal(seen.length, 2);
	assert.equal(seen[0].method, "POST");
	assert.equal(seen[0].url, "/prov-a/systemone");
	assert.equal(seen[1].url, "/prov-b/systemone");
	assert.equal(seen[0].authorization, `Bearer ${KEY_A}`, "A 用 A 的 key");
	assert.equal(seen[1].authorization, `Bearer ${KEY_B}`, "B 用 B 的 key，不混用");
	assert.equal(seen[0].body.model, "jevtest-a-jev", "SDK 带上模型 id");
	assert.equal((seen[0].body.questions as Record<string, { type: string }>).risky.type, "noul", "bool 在线上映射为 noul");
});

test("401 错误脱敏：不回显 key / 请求头，也不抛异常", async () => {
	failWith = { status: 401, body: JSON.stringify({ error: "unauthorized", authorization: `Bearer ${KEY_A}`, apiKey: KEY_A }) };
	try {
		const res = await models.classify("jevtest-a", "jevtest-a-jev", context);
		assert.equal(res.stopReason, "error");
		assert.ok(res.errorMessage, "应带上错误信息");
		assert.match(res.errorMessage!, /401/, "状态码仍可见");
		assert.ok(res.errorMessage!.includes("已隐藏"), `响应体被带出来但已脱敏：${res.errorMessage}`);
		assert.ok(!res.errorMessage!.includes(KEY_A), `错误信息不得含 key：${res.errorMessage}`);
		assert.ok(!/Bearer\s+sk-/i.test(res.errorMessage!), `错误信息不得含 Bearer 凭据：${res.errorMessage}`);
	} finally {
		failWith = null;
	}
});

test("models.json 不能注册 classifier（真实 SDK 限制）：classifier 目录为空，模型被当 chat", async () => {
	// 真实 API fixture：把 type=classifier 写进 Pi 的 models.json，Pi 只按 chat 解析（不生成 classifier 模型）。
	const dir = mkdtempSync(join(tmpdir(), "pia-mj-"));
	const modelsPath = join(dir, "models.json");
	writeFileSync(
		modelsPath,
		JSON.stringify({ providers: { "custom-cls": { name: "C", baseUrl: `http://127.0.0.1:${port}`, api: "typesafe-system-one", models: [{ id: "jev-x", name: "Jev X", type: "classifier", api: "typesafe-system-one", input: ["text"], contextWindow: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }),
	);
	const mj = await PiModels.create({ credentials: new EncryptedCredentialStore(), modelsPath, allowNetwork: false });
	assert.deepEqual(mj.listClassifierModels("custom-cls"), [], "models.json 里的 classifier 条目不会进 classifier 目录（真实 SDK 限制）");
	assert.ok(mj.listModels("custom-cls").some((x) => x.id === "jev-x"), "它被 Pi 当成 chat 模型，不能用于 classify");
});

test("自定义 provider（models.json 只有 chat）经公开入口补 SystemOne classifier：复用已存凭据、保留 chat", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pia-relay-"));
	const modelsPath = join(dir, "models.json");
	const relayBase = `http://127.0.0.1:${port}/relay`;
	writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				"custom-relay": {
					name: "自建中转",
					baseUrl: relayBase,
					api: "openai-completions",
					models: [{ id: "relay-chat", name: "Relay Chat", api: "openai-completions", input: ["text"], reasoning: false, contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
				},
			},
		}),
	);
	const KEY_C = "sk-relay-key-cccc-0123456789abcdef";
	const mj = await PiModels.create({ credentials: new EncryptedCredentialStore(), modelsPath, allowNetwork: false });
	await mj.setRuntimeApiKey("custom-relay", KEY_C);
	await mj.reloadConfig();
	assert.deepEqual(mj.listClassifierModels("custom-relay"), [], "models.json 自定义 provider 本身没有 classifier");

	mj.registerSystemOneClassifier("custom-relay", "jev-relay");
	await mj.reloadConfig();
	const list = mj.listClassifierModels("custom-relay");
	assert.ok(list.some((m) => m.id === "jev-relay"), "公开入口应把 SystemOne classifier 加进目录");
	assert.equal(list.find((m) => m.id === "jev-relay")?.configured, true, "复用该 provider 已保存的凭据");
	assert.ok(mj.listModels("custom-relay").some((m) => m.id === "relay-chat"), "原有 chat 模型必须保留");

	seen.length = 0;
	const res = await mj.classify("custom-relay", "jev-relay", context);
	assert.equal(res.stopReason, "stop");
	assert.equal(seen.length, 1);
	assert.equal(seen[0].url, "/relay/systemone", "按该 provider 的 baseUrl 发 System One 请求");
	assert.equal(seen[0].authorization, `Bearer ${KEY_C}`, "复用该 provider 已存凭据，不串用别的 provider");
});

test("服务不报 usage 时 → usage 缺失（未知），不捏造 0 / 免费", async () => {
	omitUsage = true;
	try {
		const res = await models.classify("jevtest-a", "jevtest-a-jev", context);
		assert.equal(res.stopReason, "stop");
		assert.equal(res.usage, undefined, "没有真实 usage 就不写，不能当 0 记账");
	} finally {
		omitUsage = false;
	}
});

test("找不到 classifier 模型时返回错误结果，不抛异常", async () => {
	const res = await models.classify("jevtest-a", "不存在的模型", context);
	assert.equal(res.stopReason, "error");
	assert.match(res.errorMessage ?? "", /找不到分类模型/);
});
