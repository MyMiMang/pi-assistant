/**
 * Claude Code（本机）渠道的启动注册与检测接口（真实服务进程 + 假 claude，绝不调用真实 claude）：
 * - Mock 模式没设 PIA_CLAUDE_COMMAND 时默认不注册（不因为开发机装了 claude 就改变模型列表）；
 * - 指向的 claude 还不存在：检测为没装、不注册；装好后「重新检测」就地注册，模型列表里出现 opus / sonnet / haiku；
 * - 未登录：检测如实返回 loggedIn=false。
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
const FAKE = join(import.meta.dirname, "fixtures", "fake-claude.mjs");
const procs: ReturnType<typeof spawn>[] = [];

async function start(extra: Record<string, string | undefined>) {
	const dataDir = mkdtempSync(join(tmpdir(), "pia-cc-http-"));
	const port = 28000 + Math.floor(Math.random() * 3000);
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

const claudeModels = async (api: (p: string) => Promise<Json>) => ((await api("/api/models")) as unknown as Json[]).filter((m) => m.provider === "claude-code").map((m) => m.id).sort();

test("Mock 模式没设 PIA_CLAUDE_COMMAND：默认不注册", async () => {
	const { api } = await start({ PIA_CLAUDE_COMMAND: undefined });
	const info = await api("/api/models/claude-code");
	assert.equal(info.registered, false);
	assert.deepEqual(await claudeModels(api), []);
});

test("还没装 → 装好后重新检测就地注册；未登录如实返回", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pia-cc-bin-"));
	const cmd = join(dir, "claude");
	const { api } = await start({ PIA_CLAUDE_COMMAND: cmd });
	let info = await api("/api/models/claude-code");
	assert.equal(info.installed, false);
	assert.equal(info.registered, false);
	assert.deepEqual(await claudeModels(api), []);

	copyFileSync(FAKE, cmd);
	chmodSync(cmd, 0o755);
	info = await api("/api/models/claude-code/recheck", { method: "POST" });
	assert.equal(info.installed, true);
	assert.equal(info.loggedIn, true);
	assert.equal(info.authMethod, "claude.ai");
	assert.match(String(info.version), /^\d+\.\d+\.\d+/);
	assert.equal(info.registered, true);
	assert.deepEqual(await claudeModels(api), ["default", "haiku", "opus"]); // 假 claude 默认回包的三项
});

test("启动时 claude 已装好就直接注册；未登录时 loggedIn=false 但仍可见", async () => {
	const { api } = await start({ PIA_CLAUDE_COMMAND: FAKE, FAKE_CLAUDE_LOGGED_IN: "0" });
	const info = await api("/api/models/claude-code");
	assert.equal(info.installed, true);
	assert.equal(info.registered, true);
	assert.deepEqual(await claudeModels(api), ["default", "haiku", "opus"]); // 假 claude 默认回包的三项
});

test("重新检测会重新问模型列表：先问不到（退回三个别名），之后问得到就换成真实列表", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pia-cc-bin-"));
	const modeFile = join(dir, "mode");
	const cmd = join(dir, "claude");
	writeFileSync(modeFile, "none");
	writeFileSync(cmd, `#!/bin/sh\nFAKE_CLAUDE_MODELS=$(cat "${modeFile}") exec "${process.execPath}" "${FAKE}" "$@"\n`);
	chmodSync(cmd, 0o755);
	const { api } = await start({ PIA_CLAUDE_COMMAND: cmd });
	await api("/api/models/claude-code"); // 启动注册在后台，这个检测会并入同一次注册，等它完成
	assert.deepEqual(await claudeModels(api), ["haiku", "opus", "sonnet"]);
	writeFileSync(modeFile, "dup");
	await api("/api/models/claude-code/recheck", { method: "POST" });
	const ids = await claudeModels(api);
	assert.ok(ids.includes("claude-fable-5-1[1m]") && ids.includes("default"), ids.join("|"));
});

test("claude 问模型列表卡住时：服务照常监听，/api/system 和 /api/models 立即返回，不等后台注册", { timeout: 120000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pia-cc-bin-"));
	const cmd = join(dir, "claude");
	writeFileSync(cmd, `#!/bin/sh\nFAKE_CLAUDE_MODELS=hang exec "${process.execPath}" "${FAKE}" "$@"\n`);
	chmodSync(cmd, 0o755);
	const { api } = await start({ PIA_CLAUDE_COMMAND: cmd });
	const t0 = Date.now();
	const sys = await api("/api/system");
	const list = (await api("/api/models")) as unknown as Json[];
	assert.ok(Date.now() - t0 < 4000, `两个接口用了 ${Date.now() - t0}ms`);
	assert.ok(sys.defaultModel, "Mock 默认模型在");
	assert.equal(list.filter((m) => m.provider === "claude-code").length, 0, "还在后台注册");
});
