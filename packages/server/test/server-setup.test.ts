/**
 * Linux 服务器版（DESIGN §15.3）：真实启动服务进程（服务器模式），走完首次设置：
 * 控制台打印一次性设置码 → 网页用设置码登录成为主人设备 → 主人远程改设置 / 生成配对码 / 批准新设备 →
 * 普通设备不能做管理操作 → 设置码只能用一次 → 回环请求不再免登录 → reset-owner 后重新生成设置码。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setupBanner } from "../src/setup-code.ts";

const data = mkdtempSync(join(tmpdir(), "pia-server-"));
const port = 19000 + Math.floor(Math.random() * 900);
const env = { ...process.env, PIA_DATA_DIR: data, PIA_PORT: String(port), PIA_HOST: "127.0.0.1", PIA_HEADLESS: "1", PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_SETUP_CHECK_MS: "500" };
let out = "";
const srv = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", "test/launch-memory.ts"], { cwd: join(import.meta.dirname, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
srv.stdout.on("data", (b) => (out += b));
srv.stderr.on("data", (b) => (out += b));
after(() => srv.kill());
const base = `http://127.0.0.1:${port}`;
const codes = () => [...out.matchAll(/设置码：([A-Z0-9]{4}-[A-Z0-9]{4})/g)].map((m) => m[1]);
async function waitFor<T>(f: () => T | Promise<T>, ms = 60_000): Promise<T> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = await f();
		if (v) return v;
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`等待超时。服务输出：\n${out.slice(-3000)}`);
}
const req = async (path: string, init: RequestInit & { token?: string; json?: unknown } = {}) => {
	const headers: Record<string, string> = { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.json !== undefined ? { "content-type": "application/json" } : {}) };
	const r = await fetch(base + path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
	return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> & { token?: string; deviceId?: string } };
};
async function claim(code: string, name: string) {
	const r = await req("/api/pair/claim", { method: "POST", json: { code, name, platform: "test" } });
	if (r.status !== 200) return { r };
	const st = await req(`/api/pair/status/${r.body.deviceId}`);
	return { r, deviceId: r.body.deviceId as string, token: st.body.token as string | undefined, status: st.body.status };
}

test("设置码横幅：地址、有效期、找回方法", () => {
	const b = setupBanner("ABCD-EFGH", Date.now() + 1000, ["http://10.0.0.2:8787"]);
	assert.match(b, /设置码：ABCD-EFGH/);
	assert.match(b, /http:\/\/10\.0\.0\.2:8787/);
	assert.match(b, /pi-assistant setup-code/);
});

test("服务器版首次设置：设置码 → 主人设备 → 远程管理 / 批准新设备", { timeout: 120_000 }, async () => {
	const code = await waitFor(() => codes()[0]);
	assert.match(out, /服务器模式/);
	const file = join(data, "setup-code.txt");
	assert.equal(readFileSync(file, "utf8").trim(), code);
	assert.equal(statSync(file).mode & 0o777, 0o600, "设置码文件只有服务账号能读");
	const pub = await req("/api/system/public");
	assert.equal(pub.body.setup, true);
	assert.equal(pub.body.server, true);

	// 服务器模式：回环请求也要登录（反向代理没带转发头时外部请求看起来都来自 127.0.0.1）
	assert.equal((await req("/api/system")).status, 401);
	assert.equal((await req("/api/agents")).status, 401);

	// 错误的设置码不行
	assert.equal((await claim("ZZZZ-ZZZZ", "猜的")).r.status, 400);

	// 用设置码登录 → 直接成为主人设备
	const owner = await claim(code, "我的笔记本");
	assert.equal(owner.r.status, 200);
	assert.equal(owner.r.body.preApproved, true);
	assert.equal(owner.status, "active");
	assert.ok(owner.token?.startsWith("hh_"));
	const T = owner.token!;
	const sys = await req("/api/system", { token: T });
	assert.equal(sys.body.local, true, "主人设备拥有全部管理权限");
	assert.equal(sys.body.owner, true);
	assert.equal((await req("/api/system/public")).body.setup, false);
	await waitFor(() => !existsSync(file));

	// 设置码只能用一次
	assert.equal((await claim(code, "第二次")).r.status, 400);

	// 主人远程改设置（原来只能在本机改的接口）
	const desk = await req("/api/desktop", { method: "PUT", token: T, json: { idleMinutes: 30 } });
	assert.equal(desk.status, 200, JSON.stringify(desk.body));
	assert.equal((desk.body.settings as { idleMinutes: number }).idleMinutes, 30);

	// 主人生成配对码 → 新设备认领 → 待批准 → 主人批准
	const pair = await req("/api/pair/start", { method: "POST", token: T, json: {} });
	assert.equal(pair.status, 200);
	const phone = await claim(pair.body.shortCode as string, "手机");
	assert.equal(phone.status, "pending");
	const devs = await req("/api/devices", { token: T });
	assert.ok((devs.body as unknown as { id: string; status: string; owner: number }[]).some((d) => d.id === phone.deviceId && d.status === "pending"));
	assert.equal((await req(`/api/devices/${phone.deviceId}/approve`, { method: "POST", token: T })).body.ok, true);
	const P = (await req(`/api/pair/status/${phone.deviceId}`)).body.token as string;
	assert.ok(P?.startsWith("hh_"));

	// 普通设备：能用，但不能做管理操作，也不能吊销主人
	const psys = await req("/api/system", { token: P });
	assert.equal(psys.status, 200);
	assert.equal(psys.body.local, false);
	assert.equal(psys.body.owner, false);
	assert.equal((await req("/api/desktop", { method: "PUT", token: P, json: { idleMinutes: 5 } })).status, 200, "普通设置照常");
	assert.equal((await req("/api/pair/start", { method: "POST", token: P, json: {} })).status, 403);
	assert.equal((await req(`/api/devices/${owner.deviceId}`, { method: "DELETE", token: P })).status, 403);
	assert.equal((await req(`/api/devices/${phone.deviceId}/owner`, { method: "POST", token: P, json: { owner: true } })).status, 403);

	// 主人可以把手机也设为主人；不能取消最后一个主人
	assert.equal((await req(`/api/devices/${phone.deviceId}/owner`, { method: "POST", token: T, json: { owner: true } })).body.ok, true);
	assert.equal((await req("/api/system", { token: P })).body.owner, true);
	assert.equal((await req(`/api/devices/${phone.deviceId}/owner`, { method: "POST", token: T, json: { owner: false } })).body.ok, true);
	const last = await req(`/api/devices/${owner.deviceId}/owner`, { method: "POST", token: T, json: { owner: false } });
	assert.equal(last.status, 400);
	assert.match(String(last.body.error), /至少要保留一台主人设备/);

	// 普通设备可以退出自己
	assert.equal((await req(`/api/devices/${phone.deviceId}`, { method: "DELETE", token: P })).status, 200);
	assert.equal((await req("/api/system", { token: P })).status, 401);

	// 主人设备丢了：命令行 reset-owner → 主人被吊销，服务重新生成并打印设置码
	const cli = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", "src/cli.ts", "reset-owner"], { cwd: join(import.meta.dirname, ".."), env, encoding: "utf8" });
	assert.match(cli, /已取消 1 台主人设备/);
	assert.equal((await req("/api/system", { token: T })).status, 401);
	const code2 = (await waitFor(() => codes().find((c) => c !== code))) as string;
	assert.match(execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", "src/cli.ts", "setup-code"], { cwd: join(import.meta.dirname, ".."), env, encoding: "utf8" }), new RegExp(code2));
	const owner2 = await claim(code2, "新笔记本");
	assert.equal(owner2.status, "active");
	assert.equal((await req("/api/system", { token: owner2.token })).body.owner, true);
});
