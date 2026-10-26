/**
 * Codex（本机）渠道的启动注册与检测接口（真实服务进程 + 假 codex，绝不调用真实 codex）：
 * - Mock 模式没设 PIA_CODEX_COMMAND 时默认不注册；
 * - 指向的 codex 还不存在：检测为没装、不注册；装好后「重新检测」就地注册，模型列表来自 model/list（隐藏的不要）；
 * - 未登录：如实返回 loggedIn=false，不注册；登录后重新检测才注册；
 * - 全局 AGENTS.md 存在时返回 globalAgentsMd=true（只检查文件在不在）。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

type Json = Record<string, any>;
const serverDir = join(import.meta.dirname, "..");
const FAKE = join(import.meta.dirname, "fixtures", "fake-codex.mjs");
const procs: ReturnType<typeof spawn>[] = [];

async function start(extra: Record<string, string | undefined>) {
	const dataDir = mkdtempSync(join(tmpdir(), "pia-cx-http-"));
	const port = 31000 + Math.floor(Math.random() * 3000);
	const env: Record<string, string | undefined> = { ...process.env, PIA_DATA_DIR: dataDir, PIA_WORKSPACE: join(dataDir, "workspace"), PIA_PORT: String(port), PIA_HOST: "127.0.0.1", PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_SETUP_CHECK_MS: "9999999", ...extra };
	for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", "test/launch-memory.ts"], { cwd: serverDir, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
	procs.push(child);
	let out = "";
	child.stdout?.on("data", (b) => (out += b));
	child.stderr?.on("data", (b) => (out += b));
	const base = `http://127.0.0.1:${port}`;
	const end = Date.now() + 60_000;
	for (;;) {
		if (await fetch(`${base}/api/system/public`).then((r) => r.status === 200).catch(() => false)) break;
		if (Date.now() > end) throw new Error(`等待服务启动超时：\n${out.slice(-2000)}`);
		await new Promise((r) => setTimeout(r, 120));
	}
	const api = async (path: string, init?: RequestInit): Promise<Json> => (await fetch(`${base}${path}`, { headers: { "content-type": "application/json" }, ...init })).json() as Promise<Json>;
	return { api, dataDir };
}
after(() => {
	for (const p of procs) p.kill("SIGKILL");
});

const codexModels = async (api: (p: string) => Promise<Json>) => ((await api("/api/models")) as unknown as Json[]).filter((m) => m.provider === "codex").map((m) => m.id).sort();

test("Mock 模式没设 PIA_CODEX_COMMAND：默认不注册", async () => {
	const { api } = await start({ PIA_CODEX_COMMAND: undefined });
	const info = await api("/api/models/codex");
	assert.equal(info.registered, false);
	assert.deepEqual(await codexModels(api), []);
});

test("还没装 → 装好后重新检测就地注册；模型来自 model/list，思考档位按模型", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pia-cx-bin-"));
	const cmd = join(dir, "codex");
	const home = mkdtempSync(join(tmpdir(), "pia-cx-home-"));
	const { api } = await start({ PIA_CODEX_COMMAND: cmd, CODEX_HOME: home });
	let info = await api("/api/models/codex");
	assert.equal(info.installed, false);
	assert.equal(info.registered, false);
	assert.equal(info.globalAgentsMd, false);

	copyFileSync(FAKE, cmd);
	chmodSync(cmd, 0o755);
	writeFileSync(join(home, "AGENTS.md"), "不会被读取的内容");
	info = await api("/api/models/codex/recheck", { method: "POST" });
	assert.equal(info.installed, true);
	assert.equal(info.loggedIn, true);
	assert.match(String(info.version), /^\d+\.\d+\.\d+/);
	assert.equal(info.registered, true);
	assert.equal(info.globalAgentsMd, true);
	assert.deepEqual(await codexModels(api), ["gpt-6-luna", "gpt-6.1-sol"]);
	const list = ((await api("/api/models")) as unknown as Json[]).filter((m) => m.provider === "codex");
	assert.ok(list.find((m) => m.id === "gpt-6.1-sol")!.thinking.includes("max"));
	assert.ok(!list.find((m) => m.id === "gpt-6-luna")!.thinking.includes("max"), "luna 不支持 max");
	assert.ok(list.every((m) => m.fast.capability === "unsupported"));
});

test("未登录：如实返回、不注册", async () => {
	const home = mkdtempSync(join(tmpdir(), "pia-cx-home2-"));
	writeFileSync(join(home, "logged-out"), "");
	const { api } = await start({ PIA_CODEX_COMMAND: FAKE, CODEX_HOME: home });
	const info = await api("/api/models/codex");
	assert.equal(info.installed, true);
	assert.equal(info.loggedIn, false);
	assert.equal(info.registered, false);
	assert.deepEqual(await codexModels(api), []);
});

test("启动时 codex 已装好且已登录就直接注册", async () => {
	const { api } = await start({ PIA_CODEX_COMMAND: FAKE });
	const info = await api("/api/models/codex");
	assert.equal(info.registered, true);
	assert.deepEqual(await codexModels(api), ["gpt-6-luna", "gpt-6.1-sol"]);
});
