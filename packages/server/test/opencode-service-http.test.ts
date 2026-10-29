/**
 * OpenCode（本机）渠道的启动注册与检测接口（真实服务进程 + 假 opencode，绝不调用真实 opencode）：
 * - Mock 模式没设 PIA_OPENCODE_COMMAND 时默认不注册；
 * - 指向的 opencode 还不存在：检测为没装、不注册；装好后「重新检测」就地注册，不支持工具调用的模型被去掉，名字带来源；
 * - 登录状态只看 auth.json 在不在（不读内容）；没登录也照样注册（自带免费模型），登录状态只在卡片里显示。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

type Json = Record<string, any>;
const serverDir = join(import.meta.dirname, "..");
const FAKE = join(import.meta.dirname, "fixtures", "fake-opencode.mjs");
const procs: ReturnType<typeof spawn>[] = [];

async function start(extra: Record<string, string | undefined>) {
	const dataDir = mkdtempSync(join(tmpdir(), "pia-oc-http-"));
	const port = 34000 + Math.floor(Math.random() * 3000);
	// 登录凭据放在 XDG_DATA_HOME 下：用临时目录，不看开发机上真实的 opencode 登录状态
	const xdgData = join(dataDir, "xdg-data");
	const env: Record<string, string | undefined> = { ...process.env, PIA_DATA_DIR: dataDir, PIA_WORKSPACE: join(dataDir, "workspace"), PIA_PORT: String(port), PIA_HOST: "127.0.0.1", PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_SETUP_CHECK_MS: "9999999", XDG_DATA_HOME: xdgData, ...extra };
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
	const login = () => {
		mkdirSync(join(xdgData, "opencode"), { recursive: true });
		writeFileSync(join(xdgData, "opencode", "auth.json"), "{}");
	};
	return { api, dataDir, login };
}
after(() => {
	for (const p of procs) p.kill("SIGKILL");
});

const ocModels = async (api: (p: string) => Promise<Json>) => ((await api("/api/models")) as unknown as Json[]).filter((m) => m.provider === "opencode-cli");

test("Mock 模式没设 PIA_OPENCODE_COMMAND：默认不注册（不因为开发机装了真的 opencode 就改变模型列表）", async () => {
	const { api } = await start({ PIA_OPENCODE_COMMAND: undefined });
	const info = await api("/api/models/opencode-cli");
	assert.equal(info.registered, false);
	assert.deepEqual(await ocModels(api), []);
});

test("还没装 → 装好后重新检测就地注册；没登录也注册；不支持工具调用的模型去掉，名字带来源，思考档位按模型", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pia-oc-bin-"));
	const cmd = join(dir, "opencode");
	const { api } = await start({ PIA_OPENCODE_COMMAND: cmd });
	let info = await api("/api/models/opencode-cli");
	assert.equal(info.installed, false);
	assert.equal(info.registered, false);

	copyFileSync(FAKE, cmd);
	chmodSync(cmd, 0o755);
	info = await api("/api/models/opencode-cli/recheck", { method: "POST" });
	assert.equal(info.installed, true);
	assert.equal(info.loggedIn, false, "没有 auth.json = 没登录（只能用免费模型）");
	assert.equal(info.version, "1.18.35");
	assert.equal(info.registered, true, "没登录也注册");
	const list = await ocModels(api);
	assert.deepEqual(list.map((m) => m.id).sort(), ["opencode-go/deepseek-v4.1-flash", "opencode-go/mimo-v2.5-pro", "opencode/beam-free", "opencode/claude-fable-5"]);
	assert.equal(list.find((m) => m.id === "opencode-go/deepseek-v4.1-flash")!.name, "DeepSeek V4.1 Flash（OpenCode Go）");
	assert.ok(list.find((m) => m.id === "opencode-go/deepseek-v4.1-flash")!.thinking.includes("max"));
	assert.deepEqual(list.find((m) => m.id === "opencode-go/mimo-v2.5-pro")!.thinking, ["off"]);
	assert.ok(list.every((m) => m.fast.capability === "unsupported"));
});

test("登录凭据在（auth.json 存在）：loggedIn 为真；只看文件在不在", async () => {
	const { api, login } = await start({ PIA_OPENCODE_COMMAND: FAKE });
	let info = await api("/api/models/opencode-cli");
	assert.equal(info.loggedIn, false);
	login();
	info = await api("/api/models/opencode-cli/recheck", { method: "POST" });
	assert.equal(info.loggedIn, true);
	assert.equal(info.registered, true);
});

test("启动时 opencode 已装好就直接注册", async () => {
	const { api } = await start({ PIA_OPENCODE_COMMAND: FAKE });
	const info = await api("/api/models/opencode-cli");
	assert.equal(info.registered, true);
	assert.equal((await ocModels(api)).length, 4);
});
