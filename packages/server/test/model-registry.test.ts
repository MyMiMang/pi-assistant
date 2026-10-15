/**
 * 统一模型服务注册表：纯函数单测（不读数据库 / 不碰凭据）。
 * 覆盖：一个服务同时挂 chat / 识图 / 生图 / classifier；未知能力标未确认；
 * 同 id 不同 type 分别保留、同 id 同 type 去重覆盖；按能力筛选。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRegistry, chatCapabilities, findRegistryModel, modelsWithCapability, type RegistryInput } from "../src/model-registry.ts";

const base = (): RegistryInput => ({
	providers: [
		{ id: "openai", name: "OpenAI", configured: true },
		{ id: "custom-relay", name: "中转站", configured: true },
	],
	chatModels: [
		{ provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true, thinking: ["off", "high"], api: "openai-responses", input: ["text"], contextWindow: 400_000, maxTokens: 128_000 },
		{ provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, thinking: ["off"], api: "openai-responses", input: ["text", "image"], contextWindow: 128_000, maxTokens: 16_384 },
	],
	classifierModels: [{ provider: "openai", id: "gpt-6-luna", name: "Luna", api: "openai-decisions", input: ["text"], contextWindow: 922_000, configured: true }],
	custom: [
		{
			id: "custom-relay",
			name: "中转站",
			api: "openai-completions",
			baseUrl: "https://relay.example.com/v1",
			headerNames: [],
			noKey: false,
			configured: true,
			createdAt: 1,
			models: [
				{ id: "relay-chat", name: "Relay Chat", input: ["text"] },
				{ id: "relay-vl", name: "Relay VL", input: ["text", "image"] },
				{ id: "relay-guess", name: "Relay Guess", input: ["text", "image"], inputAuto: true },
			],
			classifiers: [{ protocol: "typesafe-system-one", modelId: "jev-latest" }],
		},
	],
	image: {
		providers: [{ id: "img-1", name: "生图服务", kind: "openai", baseUrl: "https://api.openai.com/v1", models: ["gpt-image-1"], configured: true }],
		supportsEdit: (kind, model) => kind === "openai" && model !== "dall-e-3",
		costNote: (model) => (model === "gpt-image-1" ? "约 $0.01–0.17/张" : undefined),
	},
});

test("chat 能力推导：识图属于 chat 能力，不是独立服务", () => {
	assert.deepEqual(chatCapabilities(["text"]), ["chat"]);
	assert.deepEqual(chatCapabilities(["text", "image"]), ["chat", "vision"]);
	assert.deepEqual(chatCapabilities(undefined), ["chat"]);
});

test("一个服务可同时挂 chat / 识图 / classifier，内置模型也在一起", () => {
	const reg = buildRegistry(base());
	const openai = reg.find((p) => p.id === "openai")!;
	assert.equal(openai.kind, "builtin");
	assert.deepEqual(
		openai.models.map((m) => `${m.type}:${m.id}`).sort(),
		["chat:gpt-4o", "chat:gpt-5", "classifier:gpt-6-luna"],
	);
	const gpt4o = findRegistryModel(reg, "openai", "gpt-4o", "chat")!;
	assert.deepEqual(gpt4o.capabilities, ["chat", "vision"]);
	assert.equal(gpt4o.confirmed, true);
	// 同 id 分别作为 chat 与 classifier 时都保留
	assert.ok(findRegistryModel(reg, "openai", "gpt-6-luna", "classifier"));
});

test("自定义服务：一个 baseUrl + 一份凭据下多类模型", () => {
	const reg = buildRegistry(base());
	const relay = reg.find((p) => p.id === "custom-relay")!;
	assert.equal(relay.kind, "custom");
	assert.equal(relay.baseUrl, "https://relay.example.com/v1");
	assert.deepEqual(
		relay.models.map((m) => `${m.type}:${m.id}:${m.capabilities.join("+")}`).sort(),
		["chat:relay-chat:chat", "chat:relay-guess:chat+vision", "chat:relay-vl:chat+vision", "classifier:jev-latest:classifier"],
	);
	// classifier 协议来自声明，不按名字猜
	assert.equal(findRegistryModel(reg, "custom-relay", "jev-latest", "classifier")!.protocol, "typesafe-system-one");
});

test("猜出来的能力标未确认，显式元数据标已确认", () => {
	const reg = buildRegistry(base());
	const explicit = findRegistryModel(reg, "custom-relay", "relay-vl", "chat")!;
	assert.equal(explicit.confirmed, true);
	assert.deepEqual(explicit.inferred, []);
	const guessed = findRegistryModel(reg, "custom-relay", "relay-guess", "chat")!;
	assert.equal(guessed.confirmed, false);
	assert.deepEqual(guessed.inferred, ["vision"]);
});

test("生图服务合并进来，带改图与价格（未知不填 0）", () => {
	const reg = buildRegistry(base());
	const img = reg.find((p) => p.id === "img-1")!;
	assert.equal(img.kind, "imagegen");
	const m = findRegistryModel(reg, "img-1", "gpt-image-1", "image")!;
	assert.deepEqual(m.capabilities, ["image"]);
	assert.equal(m.type, "image");
	assert.equal(m.edit, true);
	assert.equal(m.costNote, "约 $0.01–0.17/张");
});

test("按能力筛选 + 同 id 同 type 去重（自定义覆盖内置）", () => {
	const input = base();
	input.chatModels.push({ provider: "custom-relay", id: "relay-chat", name: "旧名", reasoning: false, thinking: ["off"], api: "openai-completions", input: ["text"], contextWindow: 1, maxTokens: 1 });
	const reg = buildRegistry(input);
	const relay = reg.find((p) => p.id === "custom-relay")!;
	const chats = relay.models.filter((m) => m.id === "relay-chat");
	assert.equal(chats.length, 1, "同 id 同 type 只保留一条");
	assert.equal(chats[0].source, "custom");
	// 能力筛选跨服务
	const vision = modelsWithCapability(reg, "vision").map((m) => m.id).sort();
	assert.deepEqual(vision, ["gpt-4o", "relay-guess", "relay-vl"]);
	const images = modelsWithCapability(reg, "image").map((m) => m.id);
	assert.deepEqual(images, ["gpt-image-1"]);
});
