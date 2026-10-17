/**
 * 云 Jev 自动识别 → 统一模型服务目录 的真实 HTTP 闭环。
 *
 * 2026-10-18 起电脑快速候选选择器（含 `/api/fast-computer/settings`）已撤下，
 * 本测试改为只验**通用 classifier 服务元数据**：一次 `POST /api/models/custom` 后，
 * `GET /api/models/registry` 里 canonical Jev / 对端元数据被识别为 classifier（复用同一份 provider 凭据），
 * chat-only 的 `jev-router` 保持 chat，标了能力但协议不确定只标「未确认」；编辑 / 删除后同步反映。
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

test("一次配置后统一目录自动出现 Jev classifier（configured，复用同一 provider 凭据）", async () => {
	const created = await api("/api/models/custom", {
		method: "POST",
		body: JSON.stringify({ name: "自动识别中转", api: "openai-completions", baseUrl: relayUrl, apiKey: "sk-auto-0123456789abcdef", models: [{ id: "jev-latest" }, { id: "jev-router" }, { id: "relay-meta-cls", detectedType: "classifier", classifierProtocol: "typesafe-system-one" }, { id: "gpt-6-luna" }] }),
	});
	assert.equal(created.status, 200, JSON.stringify(created.body));
	const id = String(created.body.id);
	assert.ok(id.startsWith("custom-"));

	const reg = await api("/api/models/registry");
	const provider = (reg.body.providers as Json[]).find((p) => p.id === id);
	assert.ok(provider, "registry 里应有该服务");
	const classifiers = (provider.models as Json[]).filter((m) => m.type === "classifier").map((m) => m.id).sort();
	assert.deepEqual(classifiers, ["jev-latest", "relay-meta-cls"], "canonical id 与对端元数据的 classifier 自动出现");
	assert.ok((provider.models as Json[]).filter((m) => m.type === "classifier").every((m) => m.configured === true), "复用该 provider 凭据 → configured");
	assert.ok(!(provider.models as Json[]).some((m) => m.id === "jev-router" && m.type === "classifier"), "chat-only 模型不进分类器");
	assert.ok(!(provider.models as Json[]).some((m) => m.id === "gpt-6-luna" && m.type === "classifier"), "官方协议本层不支持 → fail-closed");

	// 即使用户把 jev-router 标成 classifier 能力，协议不确定也只能是「未确认」，不假装可调用
	const put = await api(`/api/models/registry/${id}/models/jev-router/capabilities`, { method: "PUT", body: JSON.stringify({ capabilities: ["chat", "classifier"] }) });
	assert.equal(put.status, 200);
	const reg2 = await api("/api/models/registry");
	const p2 = (reg2.body.providers as Json[]).find((p) => p.id === id);
	assert.ok(p2, "registry 里应有该服务");
	const router = (p2!.models as Json[]).find((m) => m.id === "jev-router" && m.type === "chat");
	assert.ok(router, "jev-router 应仍是 chat");
	assert.ok((router!.inferred as string[]).includes("classifier"), "标了 classifier 但协议不确定 → 标「未确认」");
	assert.ok(!(p2!.models as Json[]).some((m) => m.id === "jev-router" && m.type === "classifier"), "未确认的不进分类器目录");

	// 编辑：去掉 jev-latest → 目录同步移除
	const edited = await api(`/api/models/custom/${id}`, { method: "PUT", body: JSON.stringify({ name: "自动识别中转", api: "openai-completions", baseUrl: relayUrl, models: [{ id: "jev-router" }] }) });
	assert.equal(edited.status, 200);
	const reg3 = await api("/api/models/registry");
	const p3 = (reg3.body.providers as Json[]).find((p) => p.id === id);
	assert.ok(p3, "编辑后服务仍在");
	assert.deepEqual((p3!.models as Json[]).filter((m) => m.type === "classifier"), [], "移除模型后不再出现在分类器目录");

	// 删除：服务目录干净
	const del = await api(`/api/models/custom/${id}`, { method: "DELETE" });
	assert.equal(del.status, 200);
	const reg4 = await api("/api/models/registry");
	assert.ok(!((reg4.body.providers as Json[]) ?? []).some((p) => p.id === id), "删除后不再出现该服务");
});
