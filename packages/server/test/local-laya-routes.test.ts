/**
 * 本地 Laya 路由契约测试（真实 Hono app + 假 manager，不启动服务、不碰文件系统 / 网络 / GPU）。
 * 验证：路径存在、status 不回显 token、install 异步返回、uninstall 需要确认、start/stop 转发。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { mountLocalLayaRoutes } from "../src/local-laya/routes.ts";
import { LAYA_MODEL_ID } from "../src/local-laya/manager.ts";
import { localModelHints, resetLocalModelHints } from "../src/local-models.ts";
import { LAYA_SOURCE } from "../src/local-laya/manifest.ts";
import { platformProfile } from "../src/local-laya/platform.ts";
import type { LocalLayaManager, LayaStatus } from "../src/local-laya/manager.ts";

function stubStatus(): LayaStatus {
	return {
		platform: platformProfile("darwin", "arm64"),
		install: { state: "not_installed", phase: "idle", received: 0, total: null, error: null, installedAt: null },
		runtime: { state: "stopped", pid: null, port: null, host: "127.0.0.1" },
		health: null,
		configured: false,
		registered: null,
		source: LAYA_SOURCE,
	};
}

function buildApp() {
	const st = stubStatus();
	const calls = { install: 0, start: 0, stop: 0, uninstall: [] as boolean[] };
	const fake = {
		status: () => st,
		install: async () => {
			calls.install++;
			st.install.state = "installing";
			return st;
		},
		cancel: () => ({ ok: true }),
		start: async () => {
			calls.start++;
			st.runtime.state = "running";
			return st;
		},
		stop: async () => {
			calls.stop++;
			st.runtime.state = "stopped";
			return st;
		},
		update: async () => st,
		uninstall: async (confirm: boolean) => {
			calls.uninstall.push(confirm);
			if (!confirm) throw new Error("卸载需要显式确认");
			st.install.state = "not_installed";
			return st;
		},
	} as unknown as LocalLayaManager;
	const app = new Hono();
	mountLocalLayaRoutes(app, async (_c, next) => next(), () => fake);
	return { app, calls, st };
}

test("GET status：返回契约字段，且绝不含 token / 凭据", async () => {
	const { app } = buildApp();
	const res = await app.request("/api/local-models/laya/status");
	assert.equal(res.status, 200);
	const body = (await res.json()) as LayaStatus;
	assert.equal(body.runtime.host, "127.0.0.1");
	assert.ok(body.platform.support);
	assert.ok(body.source.version);
	assert.ok(!JSON.stringify(body).toLowerCase().includes("token"));
});

test("GET status：把安全 hints 刷新进注册表（已安装未启动也出现，不靠 bus 缓存）", async () => {
	resetLocalModelHints();
	const { app, st } = buildApp();
	// 重启后：已安装、从未启动 → registered 为 null
	st.install.state = "installed";
	st.runtime.state = "stopped";
	assert.deepEqual(localModelHints().map((h) => h.provider), [], "读之前还没有 hints");
	await app.request("/api/local-models/laya/status");
	const h = localModelHints().find((x) => x.provider === "local-laya");
	assert.ok(h, "GET status 后 local-laya 应进入 hints");
	assert.equal(h!.modelId, LAYA_MODEL_ID);
	assert.equal(h!.installed, true);
	assert.equal(h!.running, false);
	resetLocalModelHints();
});

test("GET source：只读来源元数据", async () => {
	const { app } = buildApp();
	const res = await app.request("/api/local-models/laya/source");
	assert.equal(res.status, 200);
	const body = (await res.json()) as typeof LAYA_SOURCE;
	assert.equal(body.version, LAYA_SOURCE.version);
	assert.equal(body.repoUrl, LAYA_SOURCE.repoUrl);
});

test("POST install：异步启动，立即返回 ok + status", async () => {
	const { app, calls } = buildApp();
	const res = await app.request("/api/local-models/laya/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ checkpoint: "laya-multilingual" }) });
	assert.equal(res.status, 200);
	const body = (await res.json()) as { ok: boolean; status: LayaStatus };
	assert.equal(body.ok, true);
	assert.equal(calls.install, 1);
});

test("GET platform：预检返回平台 + NVIDIA 探测（未装驱动也不报错）", async () => {
	const { app } = buildApp();
	const res = await app.request("/api/local-models/laya/platform");
	assert.equal(res.status, 200);
	const body = (await res.json()) as { cudaAvailable: boolean; options: { id: string }[]; nvidia: { available: boolean } };
	assert.equal(typeof body.cudaAvailable, "boolean");
	assert.ok(body.options.some((o) => o.id === "cpu"));
	if (body.cudaAvailable) assert.ok(body.options.some((o) => o.id === "cuda"));
});

test("GET logs：返回数组（已脱敏，无 token 字段）", async () => {
	const { app } = buildApp();
	const res = await app.request("/api/local-models/laya/logs");
	assert.equal(res.status, 200);
	const body = (await res.json()) as { lines: string[] };
	assert.ok(Array.isArray(body.lines));
});

test("POST start/stop：转发到 manager", async () => {
	const { app, calls } = buildApp();
	assert.equal((await app.request("/api/local-models/laya/start", { method: "POST" })).status, 200);
	assert.equal((await app.request("/api/local-models/laya/stop", { method: "POST" })).status, 200);
	assert.equal(calls.start, 1);
	assert.equal(calls.stop, 1);
});

test("DELETE uninstall：未确认被拒绝（400），确认后转发 true", async () => {
	const { app, calls } = buildApp();
	const no = await app.request("/api/local-models/laya", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
	assert.equal(no.status, 400);
	assert.deepEqual(calls.uninstall, [false]);
	const yes = await app.request("/api/local-models/laya", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
	assert.equal(yes.status, 200);
	assert.deepEqual(calls.uninstall, [false, true]);
});
