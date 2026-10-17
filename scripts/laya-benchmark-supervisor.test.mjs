/**
 * supervisor 的真实恢复路径测试：用**假 worker + 假 HTTP 生产 API**，不启动任何真实 daemon / Laya / 模型 / 浏览器。
 *
 * 覆盖：
 *  - 超时：worker 卡住 → supervisor 杀进程组、按 socket / 命令行证明归属收掉自有资源、再恢复生产 Laya（POST 一次）；
 *  - baseline 本来是 stopped → 绝不启动生产 Laya；
 *  - 正常退出：worker 自己恢复过 → supervisor 不重复 POST。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const SUP = resolve("scripts/laya-benchmark-supervisor.mjs");
const FIX = resolve("scripts/laya-benchmark-supervisor.fixture.mjs");
const NODE = process.execPath;

async function run(mode, timeoutMs = 2500) {
	const posts = [];
	const server = createServer((req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.method === "POST" && req.url === "/api/local-models/laya/start") {
			posts.push(req.url);
			res.end(JSON.stringify({ ok: true, status: { runtime: { state: "running" }, health: { ok: true } } }));
			return;
		}
		if (req.url === "/api/local-models/laya/status") {
			res.end(JSON.stringify({ runtime: { state: "running" }, health: { ok: true } }));
			return;
		}
		res.statusCode = 404;
		res.end("{}");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const apiBase = `http://127.0.0.1:${server.address().port}`;
	const child = spawn(NODE, [SUP, `--timeout-ms=${timeoutMs}`, `--api-base=${apiBase}`, "--", NODE, FIX], {
		env: { ...process.env, FAKE_MODE: mode, FAKE_API_BASE: apiBase },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (d) => (out += d));
	child.stderr.on("data", (d) => (out += d));
	const code = await new Promise((r) => child.on("exit", r));
	server.close();
	const m = out.match(/root=(\/tmp\/pia-lb-[^\s]+)/);
	assert.ok(m, `supervisor 没有输出 scratch 根：${out}`);
	const root = m[1];
	const state = JSON.parse(readFileSync(join(root, "supervisor-state.json"), "utf8"));
	return { code, out, root, state, posts };
}

/** 测试失败时的兜底：只按 state 里记录的本次 pid 清理（不会碰别的进程）。 */
function reap(state) {
	for (const pid of [state.ownLayaPid, state.workerPid].filter(Boolean)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* 已退出 */
		}
	}
}

test("超时：杀组 + 按归属收自有资源 + 恢复生产 Laya（不跑真实 daemon / 模型）", async () => {
	let r;
	try {
		r = await run("timeout");
		assert.equal(r.code, 124, "超时必须返回 124");
		assert.equal(r.state.phase, "finished");
		assert.equal(r.state.baselineProdLayaRunning, true);
		assert.equal(r.state.prodLayaStopped, true, "checkpoint 必须落盘（supervisor 才能判断要不要恢复）");
		assert.equal(r.state.cleanup.daemon.stopped, true, "本次 daemon 必须按 socket 证明停干净");
		assert.equal(r.state.cleanup.laya.stopped, true, "自有 Laya 必须证明停干净（假进程故意忽略 SIGTERM）");
		assert.equal(r.state.cleanup.ok, true, `cleanup 应成功：${JSON.stringify(r.state.cleanup.failures)}`);
		assert.equal(r.posts.length, 1, "暂停过生产 Laya → 必须恢复一次");
		assert.equal(r.state.prodRestored, true);
		// 状态文件只记非敏感字段：不落 token / 不落 env。
		assert.ok(!("token" in r.state) && !("env" in r.state) && !JSON.stringify(r.state).includes("PIA_BENCH"), "state 不得包含 token / env");
	} finally {
		if (r) reap(r.state);
	}
});

test("baseline 本来是 stopped：绝不启动生产 Laya", async () => {
	let r;
	try {
		r = await run("baseline-stopped");
		assert.equal(r.code, 124);
		assert.equal(r.state.baselineProdLayaRunning, false);
		assert.equal(r.posts.length, 0, "baseline 不是 running 时不得调 start");
		assert.match(String(r.state.cleanup.restore?.skipped ?? ""), /不擅自启动/);
	} finally {
		if (r) reap(r.state);
	}
});

test("正常退出：worker 自己恢复过 → supervisor 不重复恢复", async () => {
	let r;
	try {
		r = await run("complete", 8000);
		assert.equal(r.code, 0, r.out);
		assert.equal(r.posts.length, 1, "worker 自己 POST 过一次，supervisor 不得重复");
		assert.equal(r.state.prodRestored, true);
		assert.equal(r.state.cleanup.ok, true);
	} finally {
		if (r) reap(r.state);
	}
});
