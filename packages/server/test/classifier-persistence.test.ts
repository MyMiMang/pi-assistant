/**
 * 自定义 provider 的 classifier 持久化 / 重注册集成测试（评审补缺口）。
 *
 * 覆盖：
 *  1) 保存后 classifier 出现在目录、可分类，且把 System One 请求发到**该 provider 的 baseUrl**；
 *  2) reloadConfig（丢掉扩展注册）后靠公开元数据 reapplyClassifiers（= 启动路径）重新注册；
 *  3) 更新 provider 时 chat 模型不丢、classifier 不丢（留空不改）；改 classifier 后旧引用被清；
 *  4) 删除 provider → 分类器消失、快速操作模型引用被清理；
 *  5) 不合法的 classifier 协议 / 空模型 id 被拒。
 *
 * 凭据只用临时 PIA_DATA_DIR 写假值，不读任何真实配置。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { getSetting, setSetting } from "../src/db.ts";
import { clearProviderReferences, customProviders, initModels, models } from "../src/models.ts";
import type { ClassifierContext } from "../src/pi-adapter/index.ts";

interface SeenRequest {
	url: string;
	authorization?: string;
}
const seen: SeenRequest[] = [];

// 一个最小 System One mock：任何路径都回同一份合法应答；只记录 URL 与鉴权头。
const server = createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (c) => chunks.push(c as Buffer));
	req.on("end", () => {
		seen.push({ url: req.url ?? "", authorization: req.headers.authorization });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ answers: { intent: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.9 } }, usage: { input_tokens: 7, output_tokens: 2 } }));
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

const KEY_A = "sk-relay-a-0123456789abcdef";
const KEY_B = "sk-relay-b-0123456789abcdef";

await initModels();

const context: ClassifierContext = {
	state: { text: "你好" },
	questions: { intent: { type: "choice", instructions: "意图", criteria: { a: "闲聊", b: "任务" } } },
};

const saveA = (over: Record<string, unknown> = {}) =>
	customProviders.save(null, {
		name: "Relay A",
		api: "openai-completions",
		baseUrl: baseA,
		apiKey: KEY_A,
		models: [{ id: "relayA-chat" }],
		classifiers: [{ protocol: "typesafe-system-one", modelId: "jev-relay-a" }],
		...over,
	});

test("保存 → 目录出现 → 分类请求发到该 provider 的 baseUrl 且用它的 key", async () => {
	const meta = await saveA();
	assert.equal(meta.id, "custom-relay-a");
	assert.deepEqual(meta.classifiers, [{ protocol: "typesafe-system-one", modelId: "jev-relay-a" }]);
	const list = models.listClassifierModels(meta.id);
	assert.ok(list.some((m) => m.id === "jev-relay-a" && m.api === "typesafe-system-one"), "classifier 应进入目录");
	assert.ok(models.listModels(meta.id).some((m) => m.id === "relayA-chat"), "chat 模型保留");

	seen.length = 0;
	const res = await models.classify(meta.id, "jev-relay-a", context);
	assert.equal(res.stopReason, "stop");
	assert.equal(seen.length, 1);
	assert.equal(seen[0].url, "/relayA/systemone");
	assert.equal(seen[0].authorization, `Bearer ${KEY_A}`, "用该 provider 的凭据，不串用别的");
});

test("模拟重启：扩展层丢失后 reapplyClassifiers（启动路径）按元数据重新注册", async () => {
	const id = "custom-relay-a";
	// 模拟新进程：扩展注册不在（models.json 里本来就不支持 classifier）。
	models.unregisterProvider(id);
	assert.equal(models.listClassifierModels(id).length, 0, "无扩展层时 classifier 不生效（证明不是靠 models.json 持久化）");
	customProviders.reapplyClassifiers();
	assert.ok(models.listClassifierModels(id).some((m) => m.id === "jev-relay-a"), "启动重注册后 classifier 回来");
	// 元数据持久化在 settings（公开 store），不是 models.json
	assert.ok(!JSON.stringify(getSetting("customProviders", [])).includes("sk-relay"), "元数据不含 key");
});

test("更新 provider：chat 不丢、classifier 留空不改；改 classifier 后旧引用被清", async () => {
	const id = "custom-relay-a";
	await customProviders.save(id, { name: "Relay A2", api: "openai-completions", baseUrl: baseA, models: [{ id: "relayA-chat" }, { id: "relayA-pro" }] });
	assert.equal(models.listModels(id).filter((m) => m.id.startsWith("relayA-")).length, 2, "chat 模型更新后保留");
	assert.ok(models.listClassifierModels(id).some((m) => m.id === "jev-relay-a"), "classifier 留空不改");

	// 改 classifier：旧 fast 引用应被清掉
	setSetting("fastComputer", { enabled: true, kind: "systemone", provider: id, id: "jev-relay-a", threshold: 0.6, timeoutMs: 4000 });
	await customProviders.save(id, { name: "Relay A3", api: "openai-completions", baseUrl: baseA, models: [{ id: "relayA-chat" }], classifiers: [{ protocol: "typesafe-system-one", modelId: "jev-relay-a2" }] });
	assert.ok(!models.listClassifierModels(id).some((m) => m.id === "jev-relay-a"), "旧 classifier 移除");
	assert.ok(models.listClassifierModels(id).some((m) => m.id === "jev-relay-a2"));
	const fast = getSetting<{ provider: string; id: string }>("fastComputer", { provider: "", id: "" });
	assert.deepEqual([fast.provider, fast.id], ["", ""], "悬空的快速操作模型引用被清");
});

test("多个 provider：各自的 key 只发给自己的 baseUrl，不串", async () => {
	const b = await customProviders.save(null, {
		name: "Relay B",
		api: "openai-completions",
		baseUrl: baseB,
		apiKey: KEY_B,
		models: [{ id: "relayB-chat" }],
		classifiers: [{ protocol: "typesafe-system-one", modelId: "jev-relay-b" }],
	});
	seen.length = 0;
	await models.classify(b.id, "jev-relay-b", context);
	await models.classify("custom-relay-a", "jev-relay-a2", context);
	const byUrl = Object.fromEntries(seen.map((r) => [r.url, r.authorization]));
	assert.equal(byUrl["/relayB/systemone"], `Bearer ${KEY_B}`);
	assert.equal(byUrl["/relayA/systemone"], `Bearer ${KEY_A}`);
});

test("非法 classifier 被拒：未知协议 / 空模型 id", async () => {
	await assert.rejects(() => saveA({ name: "非法协议", classifiers: [{ protocol: "not-a-protocol", modelId: "x" }] }), /不支持的 classifier 协议/);
	await assert.rejects(() => saveA({ name: "空 id", classifiers: [{ protocol: "typesafe-system-one", modelId: "  " }] }), /classifier 模型 ID 不能为空/);
	assert.ok(!customProviders.list().some((p) => p.name === "非法协议" || p.name === "空 id"), "非法输入不落库");
});

test("删除 provider：分类器消失，快速操作模型引用被清", async () => {
	const id = "custom-relay-a";
	setSetting("fastComputer", { enabled: true, kind: "systemone", provider: id, id: "jev-relay-a2", threshold: 0.6, timeoutMs: 4000 });
	assert.ok(await customProviders.remove(id));
	clearProviderReferences(id);
	assert.equal(models.listClassifierModels(id).length, 0);
	const fast = getSetting<{ provider: string; id: string }>("fastComputer", { provider: "x", id: "x" });
	assert.deepEqual([fast.provider, fast.id], ["", ""], "删除服务后清理快速操作模型引用");
	const b = customProviders.list().find((p) => p.name === "Relay B");
	if (b) await customProviders.remove(b.id);
});
