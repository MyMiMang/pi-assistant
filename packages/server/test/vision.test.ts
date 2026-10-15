/** 识图：models.dev 识图标记、非识图模型读图时换成识图模型的描述、look_at_image、没有识图模型时明确说明 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
const { indexModelDb, knownVision } = await import("../src/pi-adapter/model-limits.ts");
const { trimModelsDev } = await import("../src/model-db.ts");
const { config } = await import("../src/config.ts");
const { initModels } = await import("../src/models.ts");
const { setSetting } = await import("../src/db.ts");
const vision = await import("../src/vision.ts");
const { visionExtension } = await import("../src/vision-ext.ts");

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

test("非识图模型：read 到的图片换成识图模型的描述；look_at_image；没有识图模型时说清楚", async () => {
	await initModels();
	const ws = join(config.workspaceRoot, "vision-test");
	mkdirSync(ws, { recursive: true });
	writeFileSync(join(ws, "a.png"), Buffer.from("89504e470d0a1a0a", "hex"));
	const seen: string[] = [];
	vision.setDescribeImpl(async (ref, prompt, imgs) => (seen.push(`${ref.provider}/${ref.id}:${imgs.length}:${prompt.includes("穿越火线") ? "q" : ""}`), { text: "一张热交换器示意图，与穿越火线不相关" }));
	const tools = new Map<string, { execute: (id: string, p: unknown) => Promise<{ content: { type: string; text?: string }[]; isError?: boolean }> }>();
	let onResult: ((e: unknown) => Promise<unknown>) | null = null;
	const textModel = { provider: "x", id: "no-such-text-model" };
	visionExtension({ workspace: ws, model: () => textModel })({ registerTool: (t: { name: string }) => tools.set(t.name, t as never), on: (ev, h) => ev === "tool_result" && (onResult = h as never) });

	// 没有识图模型
	setSetting("visionModel", null);
	const none = vision.pickVisionModel();
	if (none.source === "none") {
		const r = await tools.get("look_at_image")!.execute("1", { paths: ["a.png"] });
		assert.match(r.content[0].text!, /没有可用的识图模型/);
		assert.equal(r.isError, true);
	}
	// 指定识图模型（mock 模型存在即可；调用被替换）
	const { models } = await import("../src/models.ts");
	const any = models.listModels()[0];
	assert.ok(any, "至少有一个模型");
	setSetting("visionModel", { provider: any.provider, id: any.id });
	assert.equal(vision.pickVisionModel().source, "user");
	const r = await tools.get("look_at_image")!.execute("1", { paths: ["a.png"], question: "是不是 2008 年穿越火线的截图" });
	assert.match(r.content[0].text!, /热交换器/);
	assert.ok(seen.at(-1)!.endsWith(":1:q"));
	// read 的图片结果被替换
	const out = (await onResult!({ toolName: "read", input: { path: "a.png" }, isError: false, content: [{ type: "text", text: "Read image file" }, { type: "image", data: "AAAA", mimeType: "image/png" }] })) as { content: { type: string; text?: string }[] };
	assert.ok(out.content.every((c) => c.type === "text"));
	assert.match(out.content.at(-1)!.text!, /当前模型不能直接看图.*\n.*热交换器/s);
	// 非图片 / 其它工具不处理
	assert.equal(await onResult!({ toolName: "bash", input: {}, isError: false, content: [{ type: "image", data: "A", mimeType: "image/png" }] }), undefined);
	// 工作区外的路径拒绝
	const bad = await tools.get("look_at_image")!.execute("1", { paths: ["/etc/passwd.png"] });
	assert.match(bad.content[0].text!, /只能看工作区里的图片/);
	setSetting("visionModel", null);
});

test("识图用量：describeImages 返回真实 usage，扩展通过 onUsage 上报（不碰凭据）", async () => {
	await initModels();
	const ws = join(config.workspaceRoot, "vision-usage-test");
	mkdirSync(ws, { recursive: true });
	writeFileSync(join(ws, "b.png"), Buffer.from("89504e470d0a1a0a", "hex"));
	const { models } = await import("../src/models.ts");
	const any = models.listModels()[0];
	assert.ok(any, "至少有一个模型");
	setSetting("visionModel", { provider: any.provider, id: any.id });
	vision.setDescribeImpl(async () => ({ text: "描述", usage: { input: 123, output: 45 } }));
	const r = await vision.describeImages([{ data: "AAAA", mimeType: "image/png" }]);
	assert.equal(r.ok, true);
	assert.deepEqual(r.usage, { input: 123, output: 45 }, "公开 usage 原样透传");
	const usage: { provider: string; model: string; input: number; output: number }[] = [];
	const tools = new Map<string, { execute: (id: string, p: unknown) => Promise<{ content: { text?: string }[] }> }>();
	visionExtension({ workspace: ws, model: () => ({ provider: "x", id: "no-such-text-model" }), onUsage: (u) => usage.push(u) })({ registerTool: (t: { name: string }) => tools.set(t.name, t as never), on: () => {} });
	await tools.get("look_at_image")!.execute("1", { paths: ["b.png"] });
	assert.deepEqual(usage, [{ provider: any.provider, model: any.id, input: 123, output: 45 }], "识图调用上报用量");
	setSetting("visionModel", null);
});
