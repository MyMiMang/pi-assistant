/**
 * 云 Jev 自动识别 → 快速操作模型设置 的真实 HTTP 闭环。
 *
 * 不只验 UI badge：起一个真实服务（内存 CredentialStore），用一个本地假 relay 当“中转站”，
 * 经 `POST /api/models/custom` 一次配置后，从 `GET /api/fast-computer/settings?scope=computer`
 * 的 `classifierModels` 里确实能拿到 Jev，且 `configured=true`（复用同一份 provider 凭据，不新增 Key）。
 * 同时验证：chat-only 的 `jev-router` 不进快速操作；编辑 / 删除后同步反映。
 *
 * 边界：临时数据目录 + 内存 CredentialStore + 环回假服务；不碰真实 key / 钥匙串 / 外网 / 真实模型。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

type Json = Record<string, any>;

// ---- 本地假中转：/v1/models 给模型目录，/v1/systemone 回 SystemOne 应答（记录请求） ----
const seen: { url: string; authorization?: string }[] = [];
const relay = createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (c) => chunks.push(c as Buffer));
	req.on("end", () => {
		seen.push({ url: req.url ?? "", authorization: req.headers.authorization });
		if (req.method === "GET" && req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(
				JSON.stringify({
					object: "list",
					data: [
						{ id: "jev-latest", object: "model" }, // 官方 canonical id → 自动识别
						{ id: "jev-router", object: "model" }, // 名字像 Jev 的普通 chat → 保持 chat
						{ id: "relay-meta-cls", object: "model", type: "classifier", api: "typesafe-system-one" }, // 对端元数据
						{ id: "gpt-6-luna", object: "model" }, // canonical 但协议本层不支持 → fail-closed
					],
				}),
			);
		}
		if (req.method === "POST" && req.url === "/v1/systemone") {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ answers: { intent: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.9 } }, usage: { input_tokens: 4, output_tokens: 1 } }));
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end("{}");
	});
});
await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
const relayPort = (relay.address() as { port: number }).port;
const relayUrl = `http://127.0.0.1:${relayPort}/v1`;
after(() => {
	relay.closeAllConnections();
	relay.close();
});

const serverDir = join(import.meta.dirname, "..");
const dataDir = mkdtempSync(join(tmpdir(), "pia-fm-http-"));
const port = 25000 + Math.floor(Math.random() * 3000);
const base = `http://127.0.0.1:${port}`;

let srv: ReturnType<typeof spawn> | undefined;
let out = "";
const api = async (path: string, init?: RequestInit): Promise<{ status: number; body: Json }> => {
	const r = await fetch(`${base}${path}`, { headers: { "content-type": "application/json" }, ...init });
	return { status: r.status, body: (await r.json().catch(() => ({}))) as Json };
};

before(async () => {
	srv = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", "test/launch-memory.ts"], {
		cwd: serverDir,
		env: { ...process.env, PIA_DATA_DIR: dataDir, PIA_WORKSPACE: join(dataDir, "workspace"), PIA_PORT: String(port), PIA_HOST: "127.0.0.1", PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_SETUP_CHECK_MS: "9999999" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	srv.stdout?.on("data", (b) => (out += b));
	srv.stderr?.on("data", (b) => (out += b));
	const end = Date.now() + 60_000;
	while (Date.now() < end) {
		if (await fetch(`${base}/api/system/public`).then((r) => r.status === 200).catch(() => false)) return;
		await new Promise((r) => setTimeout(r, 120));
	}
	throw new Error(`等待服务启动超时：\n${out.slice(-2000)}`);
});

after(() => srv?.kill("SIGKILL"));

test("一次配置后快速操作模型列表自动出现 Jev（configured，复用同一 provider 凭据）", async () => {
	const created = await api("/api/models/custom", {
		method: "POST",
		body: JSON.stringify({ name: "自动识别中转", api: "openai-completions", baseUrl: relayUrl, apiKey: "sk-auto-0123456789abcdef", models: [{ id: "jev-latest" }, { id: "jev-router" }, { id: "relay-meta-cls", detectedType: "classifier", classifierProtocol: "typesafe-system-one" }, { id: "gpt-6-luna" }] }),
	});
	assert.equal(created.status, 200, JSON.stringify(created.body));
	const id = String(created.body.id);
	assert.ok(id.startsWith("custom-"));

	const fs = await api("/api/fast-computer/settings?scope=computer");
	assert.equal(fs.status, 200);
	const classifiers = (fs.body.classifierModels as Json[]).filter((m) => m.provider === id);
	const ids = classifiers.map((m) => m.id).sort();
	assert.deepEqual(ids, ["jev-latest", "relay-meta-cls"], "canonical id 与对端元数据的 classifier 自动出现");
	assert.ok(classifiers.every((m) => m.configured === true), "复用该 provider 凭据 → configured，可直接在电脑里选");
	assert.ok(!classifiers.some((m) => m.id === "jev-router"), "chat-only 模型不进快速操作");
	assert.ok(!classifiers.some((m) => m.id === "gpt-6-luna"), "官方协议本层不支持 → fail-closed");

	// registry 同步：分类器模型以 type=classifier 出现（不是只有一张 badge）
	const reg = await api("/api/models/registry");
	const provider = (reg.body.providers as Json[]).find((p) => p.id === id);
	assert.ok(provider, "registry 里应有该服务");
	const clsModels = (provider.models as Json[]).filter((m) => m.type === "classifier").map((m) => m.id).sort();
	assert.deepEqual(clsModels, ["jev-latest", "relay-meta-cls"]);
	// jev-router 仍是 chat；即使用户把它标成 classifier 能力，协议不确定也只能是「未确认」，不进快速操作
	const put = await api(`/api/models/registry/${id}/models/jev-router/capabilities`, { method: "PUT", body: JSON.stringify({ capabilities: ["chat", "classifier"] }) });
	assert.equal(put.status, 200);
	const reg2 = await api("/api/models/registry");
	const p2 = (reg2.body.providers as Json[]).find((p) => p.id === id);
	assert.ok(p2, "registry 里应有该服务");
	const router = (p2!.models as Json[]).find((m) => m.id === "jev-router" && m.type === "chat");
	assert.ok(router, "jev-router 应仍是 chat");
	assert.ok((router!.inferred as string[]).includes("classifier"), "标了 classifier 但协议不确定 → 标「未确认」，不假装可调用");
	const fs2 = await api("/api/fast-computer/settings?scope=computer");
	assert.ok(!((fs2.body.classifierModels as Json[]).some((m) => m.provider === id && m.id === "jev-router")), "未确认的不进快速操作目录");

	// 编辑：去掉 jev-latest → 快速操作列表同步移除
	const edited = await api(`/api/models/custom/${id}`, { method: "PUT", body: JSON.stringify({ name: "自动识别中转", api: "openai-completions", baseUrl: relayUrl, models: [{ id: "jev-router" }] }) });
	assert.equal(edited.status, 200);
	const fs3 = await api("/api/fast-computer/settings?scope=computer");
	assert.deepEqual((fs3.body.classifierModels as Json[]).filter((m) => m.provider === id), [], "移除模型后不再出现在快速操作目录");

	// 删除：服务目录干净
	const del = await api(`/api/models/custom/${id}`, { method: "DELETE" });
	assert.equal(del.status, 200);
	const fs4 = await api("/api/fast-computer/settings?scope=computer");
	assert.deepEqual((fs4.body.classifierModels as Json[]).filter((m) => m.provider === id), []);
});

test("scope 独立：云端自动识别的 Jev 只影响所选 scope 的列表，不串到另一台电脑", async () => {
	const created = await api("/api/models/custom", {
		method: "POST",
		body: JSON.stringify({ name: "Scope 中转", api: "openai-completions", baseUrl: relayUrl, apiKey: "sk-scope-0123456789abcdef", models: [{ id: "jev-latest" }] }),
	});
	const id = String(created.body.id);
	await api("/api/fast-computer/settings", { method: "PUT", body: JSON.stringify({ scope: "computer", enabled: true, kind: "systemone", provider: id, id: "jev-latest" }) });
	const hostpc = await api("/api/fast-computer/settings?scope=hostpc");
	const computer = await api("/api/fast-computer/settings?scope=computer");
	assert.deepEqual([computer.body.settings.provider, computer.body.settings.id], [id, "jev-latest"]);
	assert.deepEqual([hostpc.body.settings.provider, hostpc.body.settings.id], ["", ""], "另一台电脑 scope 不受影响");
	await api(`/api/models/custom/${id}`, { method: "DELETE" });
});
