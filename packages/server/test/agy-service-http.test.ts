/**
 * Antigravity（本机）渠道的启动注册与检测接口（真实服务进程 + 假 agy，绝不调用真实 agy）：
 * - Mock 模式没设 PIA_AGY_COMMAND 时默认不注册；
 * - 指向的 agy 还不存在：检测为没装、不注册；装好后「重新检测」就地注册，模型按家族去重；
 * - 未登录（agy models 失败）：如实返回 loggedIn=false，不注册。
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
const FAKE = join(import.meta.dirname, "fixtures", "fake-agy.mjs");
const procs: ReturnType<typeof spawn>[] = [];

async function start(extra: Record<string, string | undefined>) {
	const dataDir = mkdtempSync(join(tmpdir(), "pia-agy-http-"));
	const port = 34000 + Math.floor(Math.random() * 3000);
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

const agyModels = async (api: (p: string) => Promise<Json>) => ((await api("/api/models")) as unknown as Json[]).filter((m) => m.provider === "antigravity");

test("Mock 模式没设 PIA_AGY_COMMAND：默认不注册（不因为开发机装了真的 agy 就改变模型列表）", async () => {
	const { api } = await start({ PIA_AGY_COMMAND: undefined });
	const info = await api("/api/models/antigravity");
	assert.equal(info.registered, false);
	assert.deepEqual(await agyModels(api), []);
});

test("还没装 → 装好后重新检测就地注册；模型按家族去重，思考档位按家族", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pia-agy-bin-"));
	const cmd = join(dir, "agy");
	const { api } = await start({ PIA_AGY_COMMAND: cmd });
	let info = await api("/api/models/antigravity");
	assert.equal(info.installed, false);
	assert.equal(info.registered, false);

	copyFileSync(FAKE, cmd);
	chmodSync(cmd, 0o755);
	info = await api("/api/models/antigravity/recheck", { method: "POST" });
	assert.equal(info.installed, true);
	assert.equal(info.loggedIn, true);
	assert.equal(info.version, "1.4.7");
	assert.equal(info.registered, true);
	const list = await agyModels(api);
	assert.deepEqual(list.map((m) => m.id).sort(), ["claude-sonnet-5-5", "gemini-4-argon", "gpt-oss-120b"]);
	assert.ok(list.find((m) => m.id === "claude-sonnet-5-5")!.thinking.includes("high"));
	assert.deepEqual(list.find((m) => m.id === "gpt-oss-120b")!.thinking, ["off"]);
	assert.ok(list.every((m) => m.fast.capability === "unsupported"));
});

test("未登录（agy models 失败）：如实返回、不注册", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pia-agy-out-"));
	const cmd = join(dir, "agy");
	copyFileSync(FAKE, cmd);
	chmodSync(cmd, 0o755);
	writeFileSync(join(dir, "agy-logged-out"), ""); // 服务进程的环境白名单挡掉自定义变量，假 agy 认脚本旁边的这个文件
	const { api } = await start({ PIA_AGY_COMMAND: cmd });
	const info = await api("/api/models/antigravity");
	assert.equal(info.installed, true);
	assert.equal(info.loggedIn, false);
	assert.equal(info.registered, false);
	assert.match(String(info.error), /sign in/);
	assert.deepEqual(await agyModels(api), []);
});

test("启动时 agy 已装好且已登录就直接注册", async () => {
	const { api } = await start({ PIA_AGY_COMMAND: FAKE });
	const info = await api("/api/models/antigravity");
	assert.equal(info.registered, true);
	assert.equal((await agyModels(api)).length, 3);
});
