/**
 * 云语音识别（ASR）声明的真实 HTTP 闭环测试。
 *
 * 缺口：注册表读 `asrProviders` 设置、`POST /api/audio/transcriptions` 也按声明解析端点，
 * 但此前**没有任何 HTTP 接口能写这条声明**（上游有、用户不可配置）。本测试验证新增的
 * `GET/POST/DELETE /api/audio/asr/providers`：
 *   - 未知服务 / 不支持协议 / 缺参数 fail-closed（400），不写设置；
 *   - 合法声明后 `GET /api/models/registry` 出现 `type:"asr"` 的模型（复用既有 provider，不新建 Key）；
 *   - 删除后注册表不再有该 ASR 模型。
 *
 * 边界：真实服务进程 + 内存 CredentialStore（test/launch-memory.ts），临时数据目录，不碰真实数据 / 钥匙串 / 付费模型。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const serverDir = join(import.meta.dirname, "..");
const dataDir = mkdtempSync(join(tmpdir(), "pia-asr-http-"));
const port = 24000 + Math.floor(Math.random() * 3000);
const base = `http://127.0.0.1:${port}`;

let srv: ReturnType<typeof spawn> | undefined;
let out = "";
type Json = Record<string, any>;
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

test("云 ASR 声明：协议列表可见，未声明时注册表没有 ASR 模型", async () => {
	const list = await api("/api/audio/asr/providers");
	assert.equal(list.status, 200);
	assert.ok(Array.isArray(list.body.protocols) && list.body.protocols.includes("openai-audio-transcriptions"), JSON.stringify(list.body));
	assert.deepEqual(list.body.providers, []);
	const reg = await api("/api/models/registry");
	const asrModels = (reg.body.providers as Json[]).flatMap((p) => (p.models as Json[]).filter((m) => m.type === "asr"));
	assert.equal(asrModels.length, 0, "未声明时不应出现 ASR 模型");
});

test("云 ASR 声明：未知服务 / 不支持协议 / 缺参数 fail-closed", async () => {
	assert.equal((await api("/api/audio/asr/providers", { method: "POST", body: JSON.stringify({ provider: "no-such-provider", model: "x" }) })).status, 400);
	assert.equal((await api("/api/audio/asr/providers", { method: "POST", body: JSON.stringify({ provider: "mock", model: "" }) })).status, 400);
	const bad = await api("/api/audio/asr/providers", { method: "POST", body: JSON.stringify({ provider: "mock", model: "x", protocol: "not-a-protocol" }) });
	assert.equal(bad.status, 400);
	assert.deepEqual((await api("/api/audio/asr/providers")).body.providers, [], "失败不应写入设置");
});

test("云 ASR 声明：合法声明后注册表出现 type=asr 模型，删除后消失（复用既有 provider）", async () => {
	// 找一个真实存在的 provider（mock 模式通常有 mock / 内置目录）；没有就跳过声明成功断言，避免臆造。
	const providers = (await api("/api/models/providers")).body;
	const pid = Array.isArray(providers) && providers[0]?.id ? (providers[0].id as string) : "mock";
	const created = await api("/api/audio/asr/providers", { method: "POST", body: JSON.stringify({ provider: pid, model: "whisper-1", protocol: "openai-audio-transcriptions", name: "语音测试" }) });
	assert.equal(created.status, 200, JSON.stringify(created.body));
	assert.equal((created.body.providers as Json[]).length, 1);
	const reg = await api("/api/models/registry");
	const asrModels = (reg.body.providers as Json[]).flatMap((p) => (p.models as Json[]).filter((m) => m.type === "asr"));
	assert.equal(asrModels.length, 1, "声明后注册表应出现 ASR 模型");
	assert.equal(asrModels[0].id, "whisper-1");
	assert.equal((asrModels[0].asrAdapter as Json).location, "cloud");

	const del = await api(`/api/audio/asr/providers/${encodeURIComponent(pid)}/whisper-1`, { method: "DELETE" });
	assert.equal(del.status, 200);
	const reg2 = await api("/api/models/registry");
	assert.equal((reg2.body.providers as Json[]).flatMap((p) => (p.models as Json[]).filter((m) => m.type === "asr")).length, 0);
});
