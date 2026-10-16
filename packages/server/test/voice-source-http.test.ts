/**
 * 语音识别「显式来源」（voiceSource）的真实 HTTP 闭环测试。
 *
 * 覆盖用户已确认的行为（契约见 docs/design/settings-functional-backend.md）：
 *   - 旧库 / 未选过 = `source:null`，**不自选云端**；options 里本地未安装也出现但标 not_installed；
 *   - PUT 严格入参（未知字段 / 形状不对 → 400，不落库）；未知 / 未配置声明 → 400，不落库；
 *   - 选择本地未安装：允许存「用本地」意图（availability 仍 not_installed）；
 *   - 转写 / 租约按来源授权：未配 409 asr_not_configured、provider/model 与来源不一致 409 voice_source_changed，
 *     **source=local 时绝不把过期客户端的云端当默认上传**；
 *   - `source:null` 可清空（回到未配置）；失效来源标 deleted 且不改存值。
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
const dataDir = mkdtempSync(join(tmpdir(), "pia-voice-src-"));
const port = 25000 + Math.floor(Math.random() * 3000);
const base = `http://127.0.0.1:${port}`;

let srv: ReturnType<typeof spawn> | undefined;
let out = "";
type Json = Record<string, any>;
const api = async (path: string, init?: RequestInit): Promise<{ status: number; body: Json }> => {
	const r = await fetch(`${base}${path}`, { headers: { "content-type": "application/json" }, ...init });
	return { status: r.status, body: (await r.json().catch(() => ({}))) as Json };
};
const wav = () => {
	// 0.2s 16k mono PCM16 WAV（只做头部合法，内容无所谓）
	const n = 3200;
	const buf = Buffer.alloc(44 + n * 2);
	buf.write("RIFF", 0);
	buf.writeUInt32LE(36 + n * 2, 4);
	buf.write("WAVE", 8);
	buf.write("fmt ", 12);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(16000, 24);
	buf.writeUInt32LE(32000, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write("data", 36);
	buf.writeUInt32LE(n * 2, 40);
	return buf;
};
const transcribe = async (fields: Record<string, string>) => {
	const fd = new FormData();
	fd.append("file", new Blob([wav() as unknown as BlobPart], { type: "audio/wav" }), "audio.wav");
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	const r = await fetch(`${base}/api/audio/transcriptions`, { method: "POST", body: fd });
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

const LOCAL = { location: "local", provider: "local-sensevoice", model: "sensevoice-small-int8" };
const optionOf = (body: Json, provider: string, model: string) => (body.options as Json[]).find((o) => o.provider === provider && o.model === model);

test("未配置：source=null，本地未安装也出现且标 not_installed（不自选云端）", async () => {
	const r = await api("/api/audio/asr/source");
	assert.equal(r.status, 200);
	assert.equal(r.body.source, null);
	const local = optionOf(r.body, LOCAL.provider, LOCAL.model);
	assert.ok(local, "未安装的本地 SenseVoice 也应在候选里");
	assert.equal(local.location, "local");
	assert.equal(local.availability, "not_installed");
	assert.ok(typeof local.reason === "string" && local.reason.length > 0, "not_ready 必须给原因");
	assert.equal(local.selected, false);
});

test("PUT 严格入参：未知字段 / 形状不对都 400，且不落库", async () => {
	const cases: unknown[] = [
		{},
		{ source: { provider: "x", model: "y" } },
		{ source: { ...LOCAL, extra: 1 } },
		{ source: "local" },
		{ source: null, extra: true },
	];
	for (const body of cases) {
		const r = await api("/api/audio/asr/source", { method: "PUT", body: JSON.stringify(body) });
		assert.equal(r.status, 400, `应拒绝：${JSON.stringify(body)}`);
		assert.equal(r.body.error, "asr_invalid_source");
	}
	assert.equal((await api("/api/audio/asr/source")).body.source, null, "失败不得写入");
});

test("PUT 未知 provider-model → 400 asr_not_declared，不落库", async () => {
	const r = await api("/api/audio/asr/source", { method: "PUT", body: JSON.stringify({ source: { location: "cloud", provider: "no-such", model: "x" } }) });
	assert.equal(r.status, 400);
	assert.equal(r.body.error, "asr_not_declared");
	assert.equal((await api("/api/audio/asr/source")).body.source, null);
});

test("本地未安装允许先选「用本地」意图，但 availability 仍 not_installed", async () => {
	const put = await api("/api/audio/asr/source", { method: "PUT", body: JSON.stringify({ source: LOCAL }) });
	assert.equal(put.status, 200, JSON.stringify(put.body));
	assert.deepEqual(put.body.source, LOCAL);
	const local = optionOf(put.body, LOCAL.provider, LOCAL.model);
	assert.ok(local);
	assert.equal(local?.selected, true);
	assert.equal(local?.availability, "not_installed");
});

test("source=local 时：过期云端 provider/model 被拒（409 voice_source_changed），不带字段按来源走且不回落云端", async () => {
	const stale = await transcribe({ provider: "openai", model: "whisper-1", requestId: "t1" });
	assert.equal(stale.status, 409);
	assert.equal(stale.body.error, "voice_source_changed");
	// 不带 provider/model：按当前来源（本地未安装）→ 明确 409，**不**自动改成云端
	const bySource = await transcribe({ requestId: "t2" });
	assert.equal(bySource.status, 409);
	assert.equal(bySource.body.error, "asr_not_configured");
	// 租约同规则
	const lease = await api("/api/audio/asr/lease", { method: "POST", body: JSON.stringify({ provider: "openai", model: "whisper-1" }) });
	assert.equal(lease.status, 409);
	assert.equal(lease.body.error, "voice_source_changed");
});

test("云端：已配置声明可选且 ready；未配置声明被拒（400 asr_not_configured）；来源改动使注册表刷新后仍保留选择语义", async () => {
	// 已配置的自定义服务（noKey）与未配置的自定义服务（没有 Key）
	const configured = await api("/api/models/custom", { method: "POST", body: JSON.stringify({ name: "语音A", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", noKey: true, models: [{ id: "chat-a" }] }) });
	const unconfigured = await api("/api/models/custom", { method: "POST", body: JSON.stringify({ name: "语音B", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "chat-b" }] }) });
	const pidA = String(configured.body.id);
	const pidB = String(unconfigured.body.id);
	assert.ok(pidA && pidB && pidA !== pidB, JSON.stringify([configured.body, unconfigured.body]));
	assert.equal((await api("/api/audio/asr/providers", { method: "POST", body: JSON.stringify({ provider: pidA, model: "whisper-a", protocol: "openai-audio-transcriptions" }) })).status, 200);
	assert.equal((await api("/api/audio/asr/providers", { method: "POST", body: JSON.stringify({ provider: pidB, model: "whisper-b", protocol: "openai-audio-transcriptions" }) })).status, 200);

	const view = await api("/api/audio/asr/source");
	assert.equal(optionOf(view.body, pidA, "whisper-a")?.availability, "ready");
	assert.equal(optionOf(view.body, pidB, "whisper-b")?.availability, "not_configured");

	const rejected = await api("/api/audio/asr/source", { method: "PUT", body: JSON.stringify({ source: { location: "cloud", provider: pidB, model: "whisper-b" } }) });
	assert.equal(rejected.status, 400);
	assert.equal(rejected.body.error, "asr_not_configured");
	assert.deepEqual((await api("/api/audio/asr/source")).body.source, LOCAL, "被拒时保留旧值");

	const ok = await api("/api/audio/asr/source", { method: "PUT", body: JSON.stringify({ source: { location: "cloud", provider: pidA, model: "whisper-a" } }) });
	assert.equal(ok.status, 200);
	assert.deepEqual(ok.body.source, { location: "cloud", provider: pidA, model: "whisper-a" });
	assert.equal(optionOf(ok.body, pidA, "whisper-a")?.selected, true);

	// 与来源一致的请求会真的去连（baseUrl 指向不可达回环端口）→ 上游错误，而不是来源校验失败
	const matched = await transcribe({ provider: pidA, model: "whisper-a", requestId: "t3" });
	assert.notEqual(matched.body.error, "voice_source_changed");
	assert.equal(matched.status, 502);
});

test("清除来源：source:null 回到未配置，转写再次 409 asr_not_configured", async () => {
	const cleared = await api("/api/audio/asr/source", { method: "PUT", body: JSON.stringify({ source: null }) });
	assert.equal(cleared.status, 200);
	assert.equal(cleared.body.source, null);
	const local = optionOf(cleared.body, LOCAL.provider, LOCAL.model);
	assert.ok(local);
	assert.equal(local?.selected, false);
	const t = await transcribe({ provider: "openai", model: "whisper-1", requestId: "t4" });
	assert.equal(t.status, 409);
	assert.equal(t.body.error, "asr_not_configured");
});

test("失效来源：声明被删后 source 保原值，视图补 deleted 条目 + 原因", async () => {
	const p = await api("/api/models/custom", { method: "POST", body: JSON.stringify({ name: "语音C", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", noKey: true, models: [{ id: "chat-c" }] }) });
	const pid = String(p.body.id);
	assert.equal((await api("/api/audio/asr/providers", { method: "POST", body: JSON.stringify({ provider: pid, model: "whisper-c", protocol: "openai-audio-transcriptions" }) })).status, 200);
	assert.equal((await api("/api/audio/asr/source", { method: "PUT", body: JSON.stringify({ source: { location: "cloud", provider: pid, model: "whisper-c" } }) })).status, 200);

	assert.equal((await api(`/api/audio/asr/providers/${pid}/whisper-c`, { method: "DELETE" })).status, 200);
	const view = await api("/api/audio/asr/source");
	assert.deepEqual(view.body.source, { location: "cloud", provider: pid, model: "whisper-c" }, "不自动改存的值");
	const stale = (view.body.options as Json[]).find((o) => o.selected);
	assert.equal(stale?.availability, "deleted");
	assert.ok(typeof stale?.reason === "string" && stale.reason.length > 0);
});
