/** 识图：只跟随当前对话模型；不支持时明确提示、不静默换模型；legacy 设置保留不删。 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
const { indexModelDb, knownVision } = await import("../src/pi-adapter/model-limits.ts");
const { trimModelsDev } = await import("../src/model-db.ts");
const { config } = await import("../src/config.ts");
const { initModels } = await import("../src/models.ts");
const modelsMod = await import("../src/models.ts");
const { setSetting, getSetting } = await import("../src/db.ts");
const vision = await import("../src/vision.ts");
const { visionExtension } = await import("../src/vision-ext.ts");

type Tool = { execute: (id: string, p: unknown) => Promise<{ content: { type: string; text?: string }[]; isError?: boolean }> };
const mountVision = (model: () => { provider: string; id: string } | null) => {
	const tools = new Map<string, Tool>();
	let onResult: ((e: unknown) => Promise<unknown>) | null = null;
	visionExtension({ workspace: join(config.workspaceRoot, "vision-test"), model })({
		registerTool: (t: { name: string }) => tools.set(t.name, t as never),
		on: (ev, h) => ev === "tool_result" && (onResult = h as never),
	});
	return { tools, onResult: () => onResult };
};
const writePng = (name: string) => {
	const ws = join(config.workspaceRoot, "vision-test");
	mkdirSync(ws, { recursive: true });
	writeFileSync(join(ws, name), Buffer.from("89504e470d0a1a0a", "hex"));
};

test("models.dev：识图标记写进精简数据并能按模型名查到", () => {
	const t = trimModelsDev({ a: { models: { "qwen-vl-max": { limit: { context: 131072, output: 8192 }, modalities: { input: ["text", "image"] } }, "deepseek-v4-flash": { limit: { context: 1_000_000, output: 384_000 }, modalities: { input: ["text"] } } } } });
	assert.deepEqual(t.providers.a["qwen-vl-max"], [131072, 8192, 1]);
	assert.deepEqual(t.providers.a["deepseek-v4-flash"], [1_000_000, 384_000]);
	const db = indexModelDb(t.providers);
	assert.equal(knownVision("Qwen/qwen-vl-max", db), true);
	assert.equal(knownVision("deepseek-v4-flash", db), false);
	// 个别托管商标了识图不算；官方标记优先
	const db2 = indexModelDb({ h1: { m1: [1, 1, 1] }, h2: { m1: [1, 1] }, h3: { m1: [1, 1] }, openai: { m2: [1, 1] }, h4: { m2: [1, 1, 1] }, h5: { m2: [1, 1, 1] } });
	assert.equal(knownVision("m1", db2), false);
	assert.equal(knownVision("m2", db2), false);
	assert.equal(knownVision("unknown-model", db), undefined);
	// 内置快照里有常见识图模型
	const snap = indexModelDb(JSON.parse(readFileSync(join(import.meta.dirname, "..", "model-db.json"), "utf8")).providers);
	assert.equal(knownVision("gpt-4o-mini", snap), true);
});

test("当前对话模型支持图片：look_at_image 直接把图片给它，绝不调用别的模型", async () => {
	await initModels();
	writePng("a.png");
	// 造一个「公开元数据 input 含 image」的会话模型（能力判定只按 Pi 元数据）
	const models = modelsMod.models;
	const orig = models.listModels.bind(models);
	models.listModels = ((p?: string) => (p === "fake" ? [{ provider: "fake", id: "vision-model", name: "v", input: ["text", "image"] }] : orig(p))) as never;
	let described = 0;
	vision.setDescribeImpl(async () => (described++, { text: "不该被调用" }));
	try {
		const { tools } = mountVision(() => ({ provider: "fake", id: "vision-model" }));
		const r = await tools.get("look_at_image")!.execute("1", { paths: ["a.png"], question: "是不是猫" });
		assert.notEqual(r.isError, true);
		assert.equal(r.content.filter((c) => c.type === "image").length, 1, "图片原样发给当前模型");
		assert.equal(described, 0, "没有静默改用别的模型");
	} finally {
		models.listModels = orig as never;
	}
});

test("当前模型不支持图片：明确提示换模型，不静默换模型 / 不产生额外费用", async () => {
	await initModels();
	writePng("a.png");
	let described = 0;
	vision.setDescribeImpl(async () => (described++, { text: "不该被调用" }));
	const { tools, onResult } = mountVision(() => ({ provider: "x", id: "no-such-text-model" }));
	const r = await tools.get("look_at_image")!.execute("1", { paths: ["a.png"], question: "是不是 2008 年穿越火线的截图" });
	assert.equal(r.isError, true);
	assert.match(r.content[0].text!, /不支持图片输入/);
	assert.match(r.content[0].text!, /设置 › 模型/);
	assert.equal(described, 0, "没有静默调用别的模型看图");
	// read 的图片结果被换成提示，图片不进上下文，也不调用别的模型
	const out = (await onResult()!({ toolName: "read", input: { path: "a.png" }, isError: false, content: [{ type: "text", text: "Read image file" }, { type: "image", data: "AAAA", mimeType: "image/png" }] })) as { content: { type: string; text?: string }[] };
	assert.ok(out.content.every((c) => c.type === "text"));
	assert.match(out.content.at(-1)!.text!, /不支持图片输入/);
	assert.equal(described, 0);
	// 非图片 / 其它工具不处理
	assert.equal(await onResult()!({ toolName: "bash", input: {}, isError: false, content: [{ type: "image", data: "A", mimeType: "image/png" }] }), undefined);
	// 工作区外的路径拒绝
	const bad = await tools.get("look_at_image")!.execute("1", { paths: ["/etc/passwd.png"] });
	assert.match(bad.content[0].text!, /只能看工作区里的图片/);
});

test("legacy 识图设置保留不删；能力判定按 Pi 公开 input 元数据", async () => {
	await initModels();
	const any = modelsMod.models.listModels()[0];
	assert.ok(any, "至少有一个模型");
	setSetting("visionModel", { provider: any.provider, id: any.id });
	assert.deepEqual(getSetting("visionModel", null), { provider: any.provider, id: any.id }, "legacy visionModel 设置保留，不被迁移清掉");
	// pickVisionModel 仅 legacy 只读兼容：设了就用设的
	assert.equal(vision.pickVisionModel().source, "user");
	assert.equal(vision.supportsVision({ provider: any.provider, id: any.id }), any.input.includes("image"));
	assert.equal(vision.supportsVision({ provider: "x", id: "no-such-model" }), false);
	assert.match(vision.visionUnsupportedMessage({ provider: any.provider, id: any.id }), /不支持图片输入/);
	setSetting("visionModel", null);
});
