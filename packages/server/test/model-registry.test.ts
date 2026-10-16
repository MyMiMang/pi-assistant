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

test("自定义服务的 chat 模型也出现在 Pi 目录时，registry 仍标 kind=custom（不冒充官方）", () => {
	const input = base();
	input.chatModels.push({ provider: "custom-relay", id: "relay-chat", name: "Relay Chat", reasoning: false, thinking: ["off"], api: "openai-completions", input: ["text"], contextWindow: 128_000, maxTokens: 8192 });
	const reg = buildRegistry(input);
	const relay = reg.find((p) => p.id === "custom-relay")!;
	assert.equal(relay.kind, "custom", "Pi 目录里先出现同名 provider 也不能把自定义服务当成官方");
	assert.equal(relay.models.filter((m) => m.type === "chat" && m.id === "relay-chat").length, 1, "同一个 chat 模型只保留一条");
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
	assert.deepEqual(m.imageAdapter, { kind: "openai", baseUrl: "https://api.openai.com/v1", edit: true, costNote: "约 $0.01–0.17/张" }, "生图适配器元数据（UI 展示用）");
});

test("生图服务复用同一份凭据时并入同一服务卡（一次 key 多 capabilities）", () => {
	const input = base();
	input.image.providers.push({ id: "img-shared", name: "复用中转", kind: "openai", baseUrl: "https://relay.example.com/v1", models: ["gpt-image-1"], configured: true, credentialProvider: "custom-relay" });
	const reg = buildRegistry(input);
	assert.equal(reg.find((p) => p.id === "img-shared"), undefined, "复用凭据的生图服务不再单独建卡");
	const relay = reg.find((p) => p.id === "custom-relay")!;
	assert.equal(relay.kind, "custom");
	assert.ok(relay.models.some((m) => m.id === "gpt-image-1" && m.type === "image"), "同一张卡同时有 chat 与 image 能力");
	assert.ok(relay.protocols.includes("openai"), "协议集合含生图协议");
});

test("本地服务：来源可靠区分，已安装停止后卡片不消失（安装/运行状态分开）", () => {
	const input = base();
	// 运行中：Pi classifier 目录里有它（经 registerClassifiers 注册），source 应被覆写为 local
	input.classifierModels.push({ provider: "local-laya", id: "multilingual", name: "本地 Laya · multilingual", api: "typesafe-system-one", input: ["text"], contextWindow: 8192, configured: true });
	input.local = [{ provider: "local-laya", modelId: "multilingual", protocol: "typesafe-system-one", installed: true, running: true, state: "running", device: "mps" }];
	let reg = buildRegistry(input);
	const running = reg.find((p) => p.id === "local-laya")!;
	assert.equal(running.kind, "local");
	const rm = findRegistryModel(reg, "local-laya", "multilingual", "classifier")!;
	assert.equal(rm.source, "local");
	assert.deepEqual(rm.local, { installed: true, running: true, state: "running", device: "mps" });
	assert.equal(rm.name, "本地 Laya · multilingual", "运行中保留目录里的名字");
	// 停止：classifier 目录里没有它了，但已安装 → 仍保留卡片，只标暂不可用
	const stopped = base();
	stopped.local = [{ provider: "local-laya", modelId: "multilingual", protocol: "typesafe-system-one", installed: true, running: false, state: "stopped", device: null }];
	reg = buildRegistry(stopped);
	const card = reg.find((p) => p.id === "local-laya")!;
	assert.equal(card.kind, "local");
	const sm = findRegistryModel(reg, "local-laya", "multilingual", "classifier")!;
	assert.equal(sm.source, "local");
	assert.equal(sm.configured, false, "停止时不可用");
	assert.deepEqual(sm.local, { installed: true, running: false, state: "stopped", device: null });
	assert.equal(sm.confirmed, true, "本地服务的能力是已确认的");
});

test("自动识别的 classifier：以 type=classifier 出现（标 discovered），只标能力未注册的标未确认", () => {
	const input = base();
	const relay = input.custom[0];
	relay.discoveredClassifiers = [{ protocol: "typesafe-system-one", modelId: "jev-auto" }];
	relay.models.push({ id: "jev-auto" }, { id: "maybe-cls", capabilities: ["chat", "classifier"] });
	const reg = buildRegistry(input);
	const auto = findRegistryModel(reg, "custom-relay", "jev-auto", "classifier")!;
	assert.equal(auto.discovered, true, "自动识别条目标 discovered");
	assert.equal(auto.confirmed, true);
	// 只在能力里标了 classifier、但没有真正注册进 Pi → 标未确认，不假装可调用
	const maybe = findRegistryModel(reg, "custom-relay", "maybe-cls", "chat")!;
	assert.ok(maybe.capabilities.includes("classifier"));
	assert.ok(maybe.inferred.includes("classifier"));
	assert.equal(maybe.confirmed, false);
	// 真的注册了的模型，同 id 的 chat 行不错误标未确认
	const registeredChat = reg.find((p) => p.id === "custom-relay")!.models.find((m) => m.id === "jev-auto" && m.type === "chat")!;
	assert.ok(!registeredChat.inferred.includes("classifier"));
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
