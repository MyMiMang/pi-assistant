/**
 * 云 Jev（原生 System One）自动识别：自定义服务一次配置 → 快速操作模型目录自动出现。
 *
 * 缺口（本次修）：自定义服务的 classifier 之前只能靠用户在表单里**显式声明**（协议 + 模型 id）才注册；
 * 用户把已知 Jev / 官方同 id 的模型配进服务后，快速操作列表里看不到。
 *
 * 规则（可靠来源，不按名字猜）：
 *  1) 对端 `/models` 明确给出 type/api/capabilities=classifier；
 *  2) 模型 id 与 Pi **官方目录**里 canonical classifier id **完全相同**（协议取自官方目录）；
 *  3) 用户显式“能力”标为 classifier（协议仍要能确定，否则 fail-closed 不注册）。
 * 协议无法确定 → 不产出 classifier（不向未知端点乱发 /systemone，也不伪造可调用）。
 *
 * 只用公开内存 CredentialStore + 临时目录 + 本地假 HTTP 服务；不碰真实 key / 钥匙串 / 外网。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { CustomProviders, detectClassifierMetadata, effectiveClassifiers, type CustomProviderMeta, type CustomStorage } from "../src/pi-adapter/custom-providers.ts";
import { PiModels, type ClassifierContext } from "../src/pi-adapter/index.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

interface Seen {
	url: string;
	authorization?: string;
}
const seen: Seen[] = [];
// 一个最小 System One mock：任何路径都回同一份合法应答，只记录 URL 与鉴权头。
const server = createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (c) => chunks.push(c as Buffer));
	req.on("end", () => {
		seen.push({ url: req.url ?? "", authorization: req.headers.authorization });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ answers: { intent: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.9 } }, usage: { input_tokens: 3, output_tokens: 1 } }));
	});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const baseA = `http://127.0.0.1:${port}/relayA`;
const baseB = `http://127.0.0.1:${port}/relayB`;
after(() => {
	server.closeAllConnections();
	server.close();
});

const KEY_A = "sk-discovery-a-0123456789abcdef";
const KEY_B = "sk-discovery-b-0123456789abcdef";

function memoryStorage() {
	let metaList: CustomProviderMeta[] = [];
	const headers = new Map<string, Record<string, string>>();
	const fastRefs = new Map<string, { kind?: string; provider: string; id: string }>();
	const store: CustomStorage = {
		loadMeta: () => metaList,
		saveMeta: (l) => void (metaList = l),
		loadHeaders: (id) => headers.get(id) ?? {},
		saveHeaders: (id, h) => void (h ? headers.set(id, h) : headers.delete(id)),
		readKey: async () => undefined,
		loadFastReferences: () => [...fastRefs.entries()].map(([storageKey, r]) => ({ storageKey, ...r })),
		saveFastReference: (ref, storageKey = "fastComputer") => void fastRefs.set(storageKey, { ...fastRefs.get(storageKey), ...ref }),
	};
	return { store, getMetas: () => metaList, getFast: () => fastRefs.get("fastComputer") ?? null, setFast: (v: { kind?: string; provider: string; id: string }) => void fastRefs.set("fastComputer", v) };
}

const modelsPath = join(mkdtempSync(join(tmpdir(), "pia-discover-")), "models.json");
const models = await PiModels.create({ credentials: memoryCredentialStore(), modelsPath, allowNetwork: false });
const mem = memoryStorage();
const customProviders = new CustomProviders(models, modelsPath, mem.store);

const context: ClassifierContext = { state: { text: "你好" }, questions: { intent: { type: "choice", instructions: "意图", criteria: { a: "闲聊", b: "任务" } } } };

/** 保存一个含「对端元数据 / 官方 canonical id / chat-only / 不支持协议」混合模型的服务。 */
const saveMixed = (name: string, baseUrl: string, apiKey: string) =>
	customProviders.save(null, {
		name,
		api: "openai-completions",
		baseUrl,
		apiKey,
		models: [
			{ id: "jev-latest" }, // 官方 canonical id → 自动识别（协议取自官方目录）
			{ id: "jev-router" }, // 只是名字像：保持 chat
			{ id: "meta-cls", detectedType: "classifier", classifierProtocol: "typesafe-system-one" }, // 对端元数据
			{ id: "gpt-6-luna" }, // canonical，但官方协议 openai-decisions 本层不支持 → fail-closed 不注册
		],
	});

test("对端元数据识别：type/api/capabilities=classifier 才认，别的字段不认", () => {
	assert.deepEqual(detectClassifierMetadata({ id: "x", type: "classifier" }), { detectedType: "classifier" });
	assert.deepEqual(detectClassifierMetadata({ id: "x", api: "typesafe-system-one" }), { detectedType: "classifier", classifierProtocol: "typesafe-system-one" });
	assert.deepEqual(detectClassifierMetadata({ id: "x", capabilities: ["chat", "classifier"] }), { detectedType: "classifier" });
	assert.deepEqual(detectClassifierMetadata({ id: "x", capabilities: { type: "classifier" } }), { detectedType: "classifier" });
	assert.deepEqual(detectClassifierMetadata({ id: "jev-router", object: "model" }), {}, "只有名字像不算");
	assert.deepEqual(detectClassifierMetadata({ id: "x", api: "openai-completions" }), {}, "chat 协议不认");
});

test("一次保存：canonical id 与对端元数据自动成为 classifier；chat-only / 不支持协议不注册", async () => {
	const meta = await saveMixed("Discovery A", baseA, KEY_A);
	assert.equal(meta.id, "custom-discovery-a");
	assert.ok(!(meta.classifiers ?? []).length, "用户没有显式声明");
	assert.deepEqual(
		(meta.discoveredClassifiers ?? []).map((c) => `${c.modelId}:${c.protocol}`).sort(),
		["jev-latest:typesafe-system-one", "meta-cls:typesafe-system-one"],
	);
	const ids = models.listClassifierModels(meta.id).map((m) => m.id).sort();
	assert.deepEqual(ids, ["jev-latest", "meta-cls"], "自动识别的 classifier 出现在目录里");
	assert.ok(!ids.includes("jev-router"), "chat-only 模型不进 classifier 目录");
	assert.ok(!ids.includes("gpt-6-luna"), "官方协议不支持时 fail-closed，不伪造可调用");
	assert.equal(models.listClassifierModels(meta.id).find((m) => m.id === "jev-latest")?.configured, true, "复用该 provider 的凭据");
	assert.ok(!JSON.stringify(mem.getMetas()).includes("sk-discovery"), "元数据不含 key");
});

test("classify 用同一个 provider 的 baseUrl 与 Key，不额外建 Key", async () => {
	seen.length = 0;
	const res = await models.classify("custom-discovery-a", "jev-latest", context);
	assert.equal(res.stopReason, "stop");
	assert.equal(seen.length, 1);
	// 本地假 relay 收到的是该 provider 的 baseUrl + SystemOne 路径，带同一份 Key。
	assert.match(seen[0].url, /\/relayA\/systemone$/);
	assert.equal(seen[0].authorization, `Bearer ${KEY_A}`);
});

test("模拟重启：扩展层丢失后 reapplyClassifiers（启动路径）按自动识别元数据重新注册", async () => {
	const id = "custom-discovery-a";
	models.unregisterProvider(id);
	assert.equal(models.listClassifierModels(id).length, 0, "无扩展层时自动识别的 classifier 也不生效（证明不是靠 models.json）");
	customProviders.reapplyClassifiers();
	const ids = models.listClassifierModels(id).map((m) => m.id).sort();
	assert.deepEqual(ids, ["jev-latest", "meta-cls"], "启动重注册后自动识别结果仍在");
});

test("同 id 跨 provider：各自归自己，classify 只发自己的 baseUrl / Key", async () => {
	const b = await saveMixed("Discovery B", baseB, KEY_B);
	seen.length = 0;
	await models.classify("custom-discovery-a", "jev-latest", context);
	await models.classify(b.id, "jev-latest", context);
	const byUrl = Object.fromEntries(seen.map((r) => [r.url, r.authorization]));
	assert.equal(byUrl["/relayB/systemone"], `Bearer ${KEY_B}`);
	assert.equal(byUrl["/relayA/systemone"], `Bearer ${KEY_A}`);
	assert.notDeepEqual(effectiveClassifiers(mem.getMetas().find((m) => m.id === b.id)!), [], "B 自己也注册了");
});

test("编辑：去掉模型后自动识别结果同步移除，悬空快速操作引用被清", async () => {
	const id = "custom-discovery-a";
	mem.setFast({ kind: "systemone", provider: id, id: "jev-latest" });
	await customProviders.save(id, { name: "Discovery A2", api: "openai-completions", baseUrl: baseA, models: [{ id: "jev-router" }] });
	assert.deepEqual(models.listClassifierModels(id), [], "模型移除后 classifier 不再注册");
	assert.deepEqual([mem.getFast()?.provider, mem.getFast()?.id], ["", ""], "悬空引用被清");
});

test("能力纠正：标为 classifier 但协议无法确定 → 不注册（fail-closed）；显式声明协议后才注册", async () => {
	const p = await customProviders.save(null, { name: "Unknown", api: "openai-completions", baseUrl: baseB, apiKey: KEY_B, models: [{ id: "mystery-model" }] });
	const afterCap = customProviders.setModelCapabilities(p.id, "mystery-model", ["classifier"]);
	assert.ok(!afterCap.discoveredClassifiers?.length, "只有能力标签、协议未知 → 不产出 classifier");
	assert.deepEqual(models.listClassifierModels(p.id), [], "协议未知不注册（不伪造可调用）");
	// 用户在高级里显式声明协议 + 模型 id → 注册；仍复用同一份凭据。
	await customProviders.save(p.id, { name: "Unknown", api: "openai-completions", baseUrl: baseB, models: [{ id: "mystery-model" }], classifiers: [{ protocol: "typesafe-system-one", modelId: "mystery-model" }] });
	assert.deepEqual(models.listClassifierModels(p.id).map((m) => m.id), ["mystery-model"]);
	assert.equal(models.listClassifierModels(p.id)[0].configured, true);
	await customProviders.remove(p.id);
});

test("原生内置 classifier 已配置凭据 → 直接进快速操作目录（无需自定义声明）", async () => {
	const KEY = "sk-native-typesafe-0123456789abcdef";
	await models.setRuntimeApiKey("typesafe", KEY);
	await models.reloadConfig();
	const native = models.listClassifierModels("typesafe");
	assert.ok(native.some((m) => m.id === "jev-latest"), "官方 typesafe 目录自带 jev-latest");
	assert.equal(native.find((m) => m.id === "jev-latest")?.configured, true, "登录后 configured=true，快速操作列表就能选到");
	// 清理运行时 key（不碰持久凭据）
	await models.removeRuntimeApiKey("typesafe");
});

test("删除 provider：自动识别的 classifier 一并消失", async () => {
	const id = "custom-discovery-b";
	assert.ok(await customProviders.remove(id));
	assert.deepEqual(models.listClassifierModels(id), []);
	// extension 层移除与 Pi 的异步 refresh 有一个 tick 的先后，等它落定再断言 provider 消失。
	await new Promise((r) => setTimeout(r, 80));
	assert.deepEqual(models.listModels(id), []);
});
