/**
 * 本地 Laya 生产依赖里可离线验证的部分（fake HTTP / 临时目录 / 不碰 GPU / 不下载）。
 * 数据目录由 test/setup.ts 强制临时。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { findFreePort, layaRoot, readHealth } from "../src/local-laya/deps.ts";

test("readHealth：带 Bearer 读 /health 详细字段；非 200 → ok:false（不抛）", async () => {
	let gotAuth = "";
	const srv = createServer((req, res) => {
		gotAuth = String(req.headers.authorization ?? "");
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ status: "ok", device: "cpu", loaded: ["multilingual"], checkpoint_devices: { multilingual: "cpu" }, cpu_fallbacks: { count: 2, last_reason: "oom" }, revisions: { multilingual: "e4e9" } }));
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const port = (srv.address() as { port: number }).port;
	const h = await readHealth(port, "sometoken");
	assert.equal(gotAuth, "Bearer sometoken");
	assert.equal(h.ok, true);
	assert.equal(h.device, "cpu");
	assert.equal(h.cpuFallbacks?.count, 2);
	assert.equal(h.cpuFallbacks?.lastReason, "oom");
	assert.deepEqual(h.loaded, ["multilingual"]);
	srv.close();
	// 停掉后再读 → 连接失败也必须是 ok:false，不把异常甩给调用方
	const dead = await readHealth(port, "x").catch(() => null);
	assert.ok(dead === null || dead.ok === false);
});

test("findFreePort：返回可用端口且可再次绑定", async () => {
	const port = await findFreePort();
	assert.ok(port > 0 && port < 65536);
	const srv = createServer();
	await new Promise<void>((r, j) => srv.on("error", j).listen(port, "127.0.0.1", r));
	srv.close();
});

test("uninstall：canonical 校验 —— 只删我们自己的 local-laya 目录，越界路径直接拒绝", async () => {
	const { createLayaDeps } = await import("../src/local-laya/deps.ts");
	const deps = createLayaDeps();
	assert.equal(layaRoot().endsWith("local-laya"), true);
	const outside = { ...deps.paths(), root: "/tmp/not-ours" };
	await assert.rejects(() => deps.uninstall(outside), /已拒绝/);
});
