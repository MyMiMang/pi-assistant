/**
 * 助理级子代理上限的 HTTP 契约（`GET/PUT /api/agents/:id/subagents/settings`）与旧全局接口兼容。
 *
 * 覆盖（契约见 docs/design/settings-functional-backend.md）：
 *   - GET 返回 `{settings, overrides, defaults}`；未覆盖 = 空 overrides + 继承全局默认；
 *   - PUT patch：省略保留、null 清覆盖继承默认、数字越界 400 不落库、未知字段 / 类型不对 400；
 *   - 只改对应助理：改 A 不改 B，也不写其它助理的键 / 候选池；
 *   - 旧 `GET/PUT /api/subagents/settings` 保留（只动全局默认，不碰任何助理的覆盖）。
 *
 * 边界：真实服务进程 + 内存 CredentialStore（test/launch-memory.ts），临时数据目录，不碰真实数据 / 钥匙串。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const serverDir = join(import.meta.dirname, "..");
const dataDir = mkdtempSync(join(tmpdir(), "pia-sub-limits-"));
const port = 26000 + Math.floor(Math.random() * 3000);
const base = `http://127.0.0.1:${port}`;

let srv: ReturnType<typeof spawn> | undefined;
let out = "";
type Json = Record<string, any>;
const api = async (path: string, init?: RequestInit): Promise<{ status: number; body: Json }> => {
	const r = await fetch(`${base}${path}`, { headers: { "content-type": "application/json" }, ...init });
	return { status: r.status, body: (await r.json().catch(() => ({}))) as Json };
};
const createAgent = async (name: string): Promise<string> => {
	const r = await api("/api/agents", { method: "POST", body: JSON.stringify({ name }) });
	assert.equal(r.status, 200, JSON.stringify(r.body));
	return String(r.body.id);
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

test("默认：settings=defaults、overrides 为空；PUT 只改该助理，B 不受影响", async () => {
	const a = await createAgent("上限A");
	const b = await createAgent("上限B");
	const initial = await api(`/api/agents/${a}/subagents/settings`);
	assert.equal(initial.status, 200);
	assert.deepEqual(initial.body, { settings: { maxConcurrent: 10, maxMinutes: 60 }, overrides: {}, defaults: { maxConcurrent: 10, maxMinutes: 60 } });

	const set = await api(`/api/agents/${a}/subagents/settings`, { method: "PUT", body: JSON.stringify({ maxConcurrent: 3 }) });
	assert.equal(set.status, 200);
	assert.deepEqual(set.body, { settings: { maxConcurrent: 3, maxMinutes: 60 }, overrides: { maxConcurrent: 3 }, defaults: { maxConcurrent: 10, maxMinutes: 60 } });
	const bView = await api(`/api/agents/${b}/subagents/settings`);
	assert.deepEqual(bView.body.overrides, {});
	assert.deepEqual(bView.body.settings, { maxConcurrent: 10, maxMinutes: 60 });
	// 不碰候选池（没有产生 subagentModel:<id>）
	assert.deepEqual((await api(`/api/agents/${a}/subagent-model`)).body, { pool: [] });

	// patch：只改 maxMinutes，并发覆盖保留
	const patch = await api(`/api/agents/${a}/subagents/settings`, { method: "PUT", body: JSON.stringify({ maxMinutes: 30 }) });
	assert.deepEqual(patch.body, { settings: { maxConcurrent: 3, maxMinutes: 30 }, overrides: { maxConcurrent: 3, maxMinutes: 30 }, defaults: { maxConcurrent: 10, maxMinutes: 60 } });
	// null 清覆盖 → 继承全局默认
	const cleared = await api(`/api/agents/${a}/subagents/settings`, { method: "PUT", body: JSON.stringify({ maxConcurrent: null }) });
	assert.deepEqual(cleared.body, { settings: { maxConcurrent: 10, maxMinutes: 30 }, overrides: { maxMinutes: 30 }, defaults: { maxConcurrent: 10, maxMinutes: 60 } });
});

test("PUT 严格入参：未知字段 / 类型 / 越界都 400 且不落库；未知助理 404", async () => {
	const a = await createAgent("上限A2");
	const before = (await api(`/api/agents/${a}/subagents/settings`)).body;
	const bad: unknown[] = [{ foo: 1 }, { maxConcurrent: "3" }, { maxConcurrent: 0 }, { maxConcurrent: 101 }, { maxConcurrent: 1.5 }, { maxMinutes: 0 }, { maxMinutes: -5 }, []];
	for (const body of bad) {
		const r = await api(`/api/agents/${a}/subagents/settings`, { method: "PUT", body: JSON.stringify(body) });
		assert.equal(r.status, 400, `应拒绝：${JSON.stringify(body)}`);
		assert.equal((await api(`/api/agents/${a}/subagents/settings`)).body.settings.maxConcurrent, before.settings.maxConcurrent);
	}
	assert.equal((await api("/api/agents/no-such-agent/subagents/settings")).status, 404);
	assert.equal((await api("/api/agents/no-such-agent/subagents/settings", { method: "PUT", body: "{}" })).status, 404);
});

test("旧全局接口兼容：读回 settings+models，写只改全局默认，不碰任何助理的覆盖", async () => {
	const a = await createAgent("上限A3");
	const b = await createAgent("上限B3");
	assert.equal((await api(`/api/agents/${a}/subagents/settings`, { method: "PUT", body: JSON.stringify({ maxConcurrent: 2, maxMinutes: 20 }) })).status, 200);

	const legacy = await api("/api/subagents/settings");
	assert.equal(legacy.status, 200);
	assert.deepEqual(legacy.body.settings, { maxConcurrent: 10, maxMinutes: 60 });
	assert.ok(Array.isArray(legacy.body.models), "旧 UI 仍拿到 models 列表");

	const putLegacy = await api("/api/subagents/settings", { method: "PUT", body: JSON.stringify({ maxConcurrent: 7, maxMinutes: 45 }) });
	assert.equal(putLegacy.status, 200);
	assert.deepEqual(putLegacy.body, { maxMinutes: 45, maxConcurrent: 7 });

	// A 的覆盖原样保留（旧接口没有悄悄改它）；B 继承新的全局默认
	const aView = await api(`/api/agents/${a}/subagents/settings`);
	assert.deepEqual(aView.body.overrides, { maxConcurrent: 2, maxMinutes: 20 });
	assert.deepEqual(aView.body.settings, { maxConcurrent: 2, maxMinutes: 20 });
	assert.deepEqual(aView.body.defaults, { maxConcurrent: 7, maxMinutes: 45 });
	assert.deepEqual((await api(`/api/agents/${b}/subagents/settings`)).body, { settings: { maxConcurrent: 7, maxMinutes: 45 }, overrides: {}, defaults: { maxConcurrent: 7, maxMinutes: 45 } });
});
