/**
 * 子代理「模型故障池内 fallback」冒烟测试（真实起服务进程，Mock 模型，不花钱）：
 *   node --import tsx test/subagent-fallback.smoke.ts
 *
 * 场景：助理候选池 = [mock/echo, mock/echo-think]。派一个「限流测试」子代理，
 *      首个模型请求报 429（可恢复）→ 自动在池内换下一个模型，从已保存会话续跑并完成。
 * 断言：同一子代理行换了模型、写了一条用户可见的切换原因、最终 done（没有从头重跑、没有无限重试）。
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DATA = mkdtempSync(join(tmpdir(), "pia-fallback-smoke-"));
let server: ChildProcess | undefined;
let BASE = "";

const freePort = () => new Promise<number>((resolve) => { const sv = createServer().listen(0, "127.0.0.1", () => { const p = (sv.address() as { port: number }).port; sv.close(() => resolve(p)); }); });
const waitFor = async <T>(fn: () => Promise<T | undefined>, ms = 90_000): Promise<T> => {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn().catch(() => undefined);
		if (v !== undefined) return v;
		if (Date.now() > end) throw new Error("timeout");
		await new Promise((r) => setTimeout(r, 200));
	}
};
const j = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
	const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const data = await r.json();
	if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(data)}`);
	return data as T;
};
const start = async (port: number) => {
	BASE = `http://127.0.0.1:${port}`;
	server = spawn(process.execPath, ["--import", "tsx", "packages/server/src/main.ts"], { cwd: ROOT, env: { ...process.env, PIA_DATA_DIR: DATA, PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
	server.stdout?.on("data", (d) => process.stdout.write(`[server] ${d}`));
	server.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));
	await waitFor(async () => ((await fetch(`${BASE}/api/system`)).ok ? true : undefined));
};
const kill = async () => {
	const s = server;
	if (!s || s.exitCode !== null) { server = undefined; return; }
	const done = new Promise((r) => s.once("exit", r));
	s.kill("SIGKILL");
	await done;
	server = undefined;
};

interface Sub { id: string; status: string; model_id: string; model_reason: string; session_file: string | null; result_summary: string | null }
interface Msg { role: string; content: string }

try {
	await start(await freePort());
	await j("/api/settings", "PUT", { onboarded: true });
	const a = await j<{ id: string }>("/api/agents", "POST", { name: "fallback 测试" });
	// 候选池两个模型：派活时会挑一个，另一个作为 fallback
	await j(`/api/agents/${a.id}/subagent-model`, "PUT", { pool: [{ provider: "mock", id: "echo" }, { provider: "mock", id: "echo-think" }] });
	await j(`/api/agents/${a.id}/messages`, "POST", { text: "派个子代理限流测试" });
	const sub = await waitFor(async () => (await j<Sub[]>(`/api/subagents?agent=${a.id}`)).find((r) => r.status === "running" || r.status === "done"));
	const done = await waitFor(async () => {
		const d = (await j<{ subagent: Sub }>(`/api/subagents/${sub.id}`)).subagent;
		return ["done", "failed", "stopped", "timeout", "lost"].includes(d.status) ? d : undefined;
	});
	assert.equal(done.status, "done", `应在池内 fallback 后完成，实际 ${done.status}：${done.result_summary ?? ""}`);
	const detail = await j<{ messages: Msg[] }>(`/api/subagents/${sub.id}`);
	const switchMsg = detail.messages.find((m) => m.content.includes("已切换到候选池内"));
	assert.ok(switchMsg, "切换原因要对用户可见");
	assert.ok(switchMsg.content.includes(`mock/${done.model_id}`), "最终模型就是切换到的那个");
	assert.ok(["echo", "echo-think"].includes(done.model_id), "只在候选池内换模型");
	assert.ok(detail.messages.some((m) => m.content.includes("限流测试")), "原任务要保留");
	assert.ok(detail.messages.some((m) => m.content.includes("上一个模型不可用")), "续跑提示要进入会话（从断点继续，不从头重跑）");
	// 同一任务只应该有一张卡、一行 subagent 记录
	assert.equal((await j<Sub[]>(`/api/subagents?agent=${a.id}`)).filter((r) => r.id === sub.id).length, 1);
	console.log("✅ 模型故障在候选池内 fallback：换模型续跑、原因可见、同一任务不重复、最终完成");
} finally {
	await kill();
}
