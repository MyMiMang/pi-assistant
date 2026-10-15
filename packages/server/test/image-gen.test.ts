import "./setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { makePng, startMockImages } from "../../../e2e/mock-images.mjs";
import { db, getSetting, setSetting } from "../src/db.ts";
import { workspaceOf } from "../src/files.ts";
import { initModels } from "../src/models.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";
import { arkSize, dashscopeSize, defaultCtx, generate, ImageGenError, isImageModel, listModels, openaiSize, supportsEdit, type Ctx } from "../src/image-gen/providers.ts";
import { agentChoice, defaultImageModel, endpointOf, fetchModelsFor, generateForAgent, getProvider, imageKey, imageModelFor, listProviders, migrateLegacyImageProviders, removeProvider, saveProvider, setAgentChoice, setImageCtx } from "../src/image-gen/index.ts";
import { imageExtensions } from "../src/image-gen/extension.ts";

const KEY = "sk-img-unit";
const mock = await startMockImages({ key: KEY });
after(() => mock.close());
await initModels(memoryCredentialStore());
const ctx: Ctx = { ...defaultCtx(), pollMs: 5, pollTimeoutMs: 5_000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
const png = (b: Buffer) => b[0] === 0x89 && b[1] === 0x50;
const last = (p: string | RegExp) => [...mock.seen].reverse().find((s) => (typeof p === "string" ? s.path === p : p.test(s.path)))!;

test("识别图片模型", () => {
	for (const id of ["gpt-image-1", "dall-e-3", "doubao-seedream-4-0-250828", "wanx2.1-t2i-turbo", "qwen-image-edit", "gemini-2.5-flash-image", "imagen-4.0-generate-001", "black-forest-labs/FLUX.1-dev", "Kwai-Kolors/Kolors", "cogview-4", "grok-2-image-1212"]) assert.ok(isImageModel(id), id);
	for (const id of ["gpt-4o", "text-embedding-3-small", "qwen-max", "gemini-2.5-flash", "deepseek-chat"]) assert.ok(!isImageModel(id), id);
});

test("图片输出能力优先，识图模型和名字带 image 的聊天模型不混入", async () => {
	const { trimModelsDev } = await import("../src/model-db.ts");
	const { indexModelDb } = await import("../src/pi-adapter/model-limits.ts");
	const data = trimModelsDev({ provider: { models: {
		"paint-alias": { modalities: { input: ["text"], output: ["image"] } },
		"image-chat": { limit: { context: 1000 }, modalities: { input: ["text", "image"], output: ["text"] } },
	} } });
	const db = indexModelDb(data.providers);
	assert.ok(isImageModel("paint-alias", undefined, db), "没有上下文长度的生成模型也保留能力");
	assert.equal(isImageModel("image-chat", undefined, db), false);
	assert.equal(isImageModel("gpt-image-1", { modalities: { output: ["text"] } }, db), false, "接口明确只输出文字时不按名字猜");
	assert.ok(isImageModel("relay-painter", { architecture: { output_modalities: ["image"] } }, db));
	assert.equal(isImageModel("my-image-chat", undefined, []), false);
});

test("尺寸换算", () => {
	assert.equal(openaiSize("gpt-image-1", "16:9"), "1536x1024");
	assert.equal(openaiSize("dall-e-3", "9:16"), "1024x1792");
	assert.equal(openaiSize("gpt-image-1"), undefined);
	assert.equal(openaiSize("x", undefined, "512*512"), "512x512");
	assert.equal(dashscopeSize("qwen-image", "16:9"), "1664*928");
	assert.equal(dashscopeSize("wanx2.1-t2i-turbo", "3:4"), "768*1024");
	assert.equal(arkSize("doubao-seedream-4-0-250828", "1:1"), "2048x2048");
	assert.equal(arkSize("doubao-seedream-3-0-t2i-250415", "16:9"), "1280x720");
	assert.ok(supportsEdit("gemini", "gemini-2.5-flash-image") && !supportsEdit("gemini", "imagen-4.0-generate-001"));
	assert.ok(!supportsEdit("xai", "grok-2-image") && supportsEdit("ark", "doubao-seedream-4-0-250828"));
});

test("OpenAI 兼容：文生图（b64）、size/quality、多张、url 返回", async () => {
	const ep = { kind: "openai" as const, baseUrl: mock.url, apiKey: KEY };
	const r = await generate(ep, { model: "gpt-image-1", prompt: "一只猫", n: 2, aspect: "16:9", quality: "low" }, ctx);
	assert.equal(r.images.length, 2);
	assert.ok(png(r.images[0].data));
	const s = last("/v1/images/generations");
	assert.equal(s.headers.authorization, `Bearer ${KEY}`);
	assert.deepEqual([s.json.size, s.json.quality, s.json.n, s.json.response_format], ["1536x1024", "low", 2, undefined]);
	// dall-e-3 一次只能 1 张 → 循环请求；带 response_format
	const d = await generate(ep, { model: "dall-e-3", prompt: "狗", n: 2 }, ctx);
	assert.equal(d.images.length, 2);
	assert.equal(d.revisedPrompt, "狗（改写）");
	assert.equal(last("/v1/images/generations").json.response_format, "b64_json");
});

test("OpenAI 兼容：中转站不认 size 时去掉参数重试", async () => {
	const r = await generate({ kind: "openai", baseUrl: mock.url, apiKey: KEY }, { model: "strict-size", prompt: "山", aspect: "4:3" }, ctx);
	assert.equal(r.images.length, 1);
	assert.equal(last("/v1/images/generations").json.size, undefined);
});

test("OpenAI 兼容：改图走 multipart /images/edits", async () => {
	const r = await generate({ kind: "openai", baseUrl: mock.url, apiKey: KEY }, { model: "gpt-image-1", prompt: "换成蓝色背景", images: [{ name: "a.png", mime: "image/png", data: makePng(8, 8) }] }, ctx);
	assert.equal(r.images.length, 1);
	const s = last("/v1/images/edits");
	assert.match(String(s.headers["content-type"]), /multipart\/form-data/);
	assert.match(s.body, /name="image\[\]"; filename="a.png"/);
	await assert.rejects(generate({ kind: "xai", baseUrl: mock.url, apiKey: KEY }, { model: "grok-2-image", prompt: "x", images: [{ name: "a.png", mime: "image/png", data: makePng(8, 8) }] }, ctx), (e: ImageGenError) => e.code === "unsupported");
});

test("错误分类：Key 无效 / 安全策略 / 模型不存在 / 超时 / 连不上", async () => {
	const ep = { kind: "openai" as const, baseUrl: mock.url, apiKey: KEY };
	await assert.rejects(generate({ ...ep, apiKey: "bad" }, { model: "gpt-image-1", prompt: "猫" }, ctx), (e: ImageGenError) => e.code === "auth" && /API Key/.test(e.message) && /401/.test(e.detail));
	await assert.rejects(generate(ep, { model: "gpt-image-1", prompt: "违规内容" }, ctx), (e: ImageGenError) => e.code === "policy" && /安全策略/.test(e.message) && /moderation_blocked/.test(e.detail));
	await assert.rejects(generate(ep, { model: "nope", prompt: "猫" }, ctx), (e: ImageGenError) => e.code === "model");
	await assert.rejects(generate(ep, { model: "gpt-image-1", prompt: "慢慢画" }, { ...ctx, timeoutMs: 300 }), (e: ImageGenError) => e.code === "timeout" && /超时/.test(e.message));
	await assert.rejects(generate({ ...ep, baseUrl: "http://127.0.0.1:9/v1" }, { model: "gpt-image-1", prompt: "猫" }, ctx), (e: ImageGenError) => e.code === "network");
});

test("火山方舟 Seedream：b64、尺寸、参考图（data URL）、敏感词", async () => {
	const ep = { kind: "ark" as const, baseUrl: `${mock.base}/api/v3`, apiKey: KEY };
	const r = await generate(ep, { model: "doubao-seedream-4-0-250828", prompt: "海报", aspect: "9:16", images: [{ name: "r.png", mime: "image/png", data: makePng(8, 8) }] }, ctx);
	assert.equal(r.images.length, 1);
	const s = last("/api/v3/images/generations");
	assert.equal(s.json.size, "1440x2560");
	assert.equal(s.json.response_format, "b64_json");
	assert.equal(s.json.watermark, false);
	assert.match(s.json.image, /^data:image\/png;base64,/);
	await assert.rejects(generate(ep, { model: "doubao-seedream-3-0-t2i-250415", prompt: "x", images: [{ name: "r.png", mime: "image/png", data: makePng(8, 8) }] }, ctx), (e: ImageGenError) => e.code === "unsupported");
	await assert.rejects(generate(ep, { model: "doubao-seedream-3-0-t2i-250415", prompt: "违规" }, ctx), (e: ImageGenError) => e.code === "policy");
});

test("阿里云百炼：异步任务轮询（兼容模式 Base URL 也能用）、改图、敏感词", async () => {
	const ep = { kind: "dashscope" as const, baseUrl: `${mock.base}/compatible-mode/v1`, apiKey: KEY };
	const r = await generate(ep, { model: "wanx2.1-t2i-turbo", prompt: "山水画", n: 2, aspect: "16:9" }, ctx);
	assert.equal(r.images.length, 2);
	assert.equal(r.revisedPrompt, "扩写后的描述");
	const sub = last("/api/v1/services/aigc/text2image/image-synthesis");
	assert.equal(sub.headers["x-dashscope-async"], "enable");
	assert.equal(sub.json.parameters.size, "1280*720");
	assert.ok(mock.seen.filter((s) => s.path.startsWith("/api/v1/tasks/")).length >= 2, "至少轮询两次");
	const e = await generate(ep, { model: "qwen-image-edit", prompt: "加一顶帽子", images: [{ name: "a.png", mime: "image/png", data: makePng(8, 8) }] }, ctx);
	assert.equal(e.images.length, 1);
	assert.match(last("/api/v1/services/aigc/multimodal-generation/generation").json.input.messages[0].content[0].image, /^data:image\/png/);
	await assert.rejects(generate(ep, { model: "qwen-image", prompt: "违规" }, ctx), (x: ImageGenError) => x.code === "policy");
	await assert.rejects(generate(ep, { model: "qwen-image-edit", prompt: "改" }, ctx), (x: ImageGenError) => x.code === "unsupported");
});

test("Gemini 图片模型 / Imagen：inlineData、宽高比、参考图、安全拦截、Key 无效", async () => {
	const ep = { kind: "gemini" as const, baseUrl: `${mock.base}/v1beta`, apiKey: KEY };
	const r = await generate(ep, { model: "gemini-2.5-flash-image", prompt: "猫", aspect: "3:4", images: [{ name: "a.png", mime: "image/png", data: makePng(8, 8) }] }, ctx);
	assert.equal(r.images.length, 1);
	assert.equal(r.text, "好的，这是你要的图。");
	const s = last(/generateContent$/);
	assert.equal(s.headers["x-goog-api-key"], KEY);
	assert.equal(s.json.generationConfig.imageConfig.aspectRatio, "3:4");
	assert.ok(s.json.contents[0].parts[0].inline_data.data);
	const im = await generate(ep, { model: "imagen-4.0-generate-001", prompt: "猫", n: 3 }, ctx);
	assert.equal(im.images.length, 3);
	await assert.rejects(generate(ep, { model: "gemini-2.5-flash-image", prompt: "违规" }, ctx), (e: ImageGenError) => e.code === "policy");
	await assert.rejects(generate({ ...ep, apiKey: "bad" }, { model: "gemini-2.5-flash-image", prompt: "猫" }, ctx), (e: ImageGenError) => e.code === "auth");
});

test("模型列表：OpenAI 兼容 / 百炼 / Gemini 只挑出图片模型", async () => {
	assert.deepEqual((await listModels({ kind: "openai", baseUrl: mock.url, apiKey: KEY }, ctx)).image, ["flux-dev", "gpt-image-1", "qwen-image", "wanx2.1-t2i-turbo"]);
	assert.deepEqual((await listModels({ kind: "dashscope", baseUrl: mock.base, apiKey: KEY }, ctx)).image, ["flux-dev", "gpt-image-1", "qwen-image", "wanx2.1-t2i-turbo"]);
	assert.deepEqual((await listModels({ kind: "gemini", baseUrl: `${mock.base}/v1beta`, apiKey: KEY }, ctx)).image, ["gemini-2.5-flash-image", "imagen-4.0-generate-001"]);
	const bad = await fetchModelsFor({ kind: "openai", baseUrl: mock.url, apiKey: "bad" });
	assert.equal(bad.ok, false);
	assert.ok(bad.presets.includes("gpt-image-1"));
});

test("配置：Key 写入统一凭据存储（不落 settings）、默认模型、助理选择 / 关闭、generate_image 存进工作区并发到聊天", async () => {
	setImageCtx(ctx);
	assert.equal(imageModelFor("a1"), null);
	assert.deepEqual(imageExtensions("a1", null, null), []);
	const credentials = memoryCredentialStore();
	await initModels(credentials);
	const p = await saveProvider(null, { kind: "openai", name: "我的中转", baseUrl: mock.url, apiKey: KEY, models: ["gpt-image-1", "dall-e-3"] });
	assert.ok(!JSON.stringify(listProviders()).includes(KEY), "Key 不明文");
	assert.equal(getSetting(`imageKey:${p.id}`, null), null, "不再写 legacy imageKey 设置");
	const stored = await credentials.read(p.id);
	assert.equal(stored?.type === "api_key" ? stored.key : undefined, KEY, "Key 存在统一凭据存储");
	assert.deepEqual(defaultImageModel(), { provider: p.id, model: "gpt-image-1" });
	assert.equal(imageKey("a1"), `${p.id}/gpt-image-1`);
	setAgentChoice("a1", { mode: "off" });
	assert.equal(imageModelFor("a1"), null);
	setAgentChoice("a1", { mode: "model", provider: p.id, model: "dall-e-3" });
	assert.deepEqual(agentChoice("a1"), { mode: "model", provider: p.id, model: "dall-e-3" });
	assert.equal(imageExtensions("a1", null, null).length, 1);
	db.prepare("INSERT OR IGNORE INTO agents(id, name, avatar, color, created_at) VALUES('a1','画师','🎨','#000',0)").run();
	const up = join(workspaceOf("a1"), "uploads");
	mkdirSync(up, { recursive: true });
	writeFileSync(join(up, "ref.png"), makePng(16, 16));
	setAgentChoice("a1", { mode: "default" });
	const r = await generateForAgent("a1", null, null, { prompt: "把背景换成海边", input_images: ["uploads/ref.png"], count: 1 });
	assert.equal(r.saved.length, 1);
	assert.match(r.saved[0], /^images\/\d{8}-\d{6}-把背景换成海边\.png$/);
	assert.ok(existsSync(join(workspaceOf("a1"), r.saved[0])));
	const msg = db.prepare("SELECT meta FROM messages WHERE agent_id = 'a1' ORDER BY created_at DESC LIMIT 1").get() as { meta: string };
	const meta = JSON.parse(msg.meta);
	assert.equal(meta.attachments[0].mime, "image/png");
	assert.equal(meta.imageGen.edit, true);
	await assert.rejects(generateForAgent("a1", null, null, { prompt: "x", input_images: ["../etc/passwd"] }), (e: ImageGenError) => /工作区/.test(e.message));
	assert.ok(await removeProvider(p.id));
	assert.equal(defaultImageModel(), null);
	setImageCtx(null);
});

test("legacy Key 桥接与幂等元数据迁移：旧 imageKey 仍能读、不复制明文；keyFrom 复用统一凭据", async () => {
	const credentials = memoryCredentialStore();
	await initModels(credentials);
	const { sealJson } = await import("../src/secrets.ts");
	const id = "img-legacy";
	setSetting("imageProviders", [{ id, name: "旧版", kind: "openai", baseUrl: mock.url, models: ["gpt-image-1"], createdAt: 1 }]);
	setSetting(`imageKey:${id}`, sealJson(KEY));
	// 元数据迁移：只补 keyStored 标记，不读、不复制明文
	assert.equal(migrateLegacyImageProviders(), 1);
	assert.equal(listProviders()[0].keyStored, "legacy");
	assert.equal(listProviders()[0].imageKeyMigrated, false, "Key 仍在旧位置，不得标成已迁移");
	assert.equal(migrateLegacyImageProviders(), 0, "幂等：再跑不变");
	assert.notEqual(getSetting(`imageKey:${id}`, null), null, "legacy 密文原样保留，未复制 / 删除");
	// 桥接读取：旧 Key 仍能用于真实请求（走 HTTP adapter 的 apiKey）
	assert.equal((await endpointOf(getProvider(id)!)).apiKey, KEY);
	// keyFrom 复用别的服务的统一凭据（同一份存储，不拆两套）
	await credentials.modify("svc-x", async () => ({ type: "api_key", key: "sk-svc-x" }));
	const p2 = await saveProvider(null, { kind: "openai", name: "复用", baseUrl: mock.url, keyFrom: "svc-x", models: ["gpt-image-1"] });
	assert.equal((await endpointOf(p2)).apiKey, "sk-svc-x");
	assert.equal(p2.keyStored, "reference");
	assert.equal(p2.imageKeyMigrated, true, "引用别的服务也算已迁移（不再仅存 legacy）");
	// keyFrom 时绝不回退读本服务旧的 legacy Key（避免把旧 Key 串到引用目标上）
	setSetting(`imageKey:${p2.id}`, sealJson("sk-old-own"));
	await credentials.delete("svc-x");
	assert.equal((await endpointOf(p2)).apiKey, undefined, "引用目标没 Key 也不能用自己旧的 legacy Key 顶上");
	setSetting(`imageKey:${p2.id}`, null);
	setSetting("imageProviders", []);
	setSetting(`imageKey:${id}`, null);
});
