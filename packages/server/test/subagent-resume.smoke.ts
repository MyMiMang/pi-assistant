/**
 * 子代理「断网后原会话续跑」冒烟测试（真实起服务、Mock 模型，不花钱，不碰钥匙串）：
 *   node --import tsx test/subagent-resume.smoke.ts
 *
 * 场景：主会话派一个「网络断开测试」子代理，Mock 第一次模型请求抛 ECONNRESET（连接被重置）。
 * 断言：驱动在同一条子代理、同一个 Pi session 上有界退避重试后完成——
 *      · 只有一行 subagents 记录（没有新 spawn）；
 *      · 会话文件已落库且保留原任务；
 *      · 最终 done（不是 failed/lost），产出进入子会话。
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DATA = mkdtempSync(join(tmpdir(), "pia-resume-smoke-"));
let server: ChildProcess | undefined;
let BASE = "";

const freePort = () => new Promise<number>((resolve) => { const sv = createServer().listen(0, "127.0.0.1", () => { const p = (sv.address() as { port: number }).port; sv.close(() => resolve(p)); }); });
const waitFor = async <T>(fn: () => Promise<T | undefined>, ms = 60_000): Promise<T> => {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn().catch(() => undefined);
		if (v !== undefined) return v;
		if (Date.now() > end) throw new Error("timeout");
		await new Promise((r) => setTimeout(r, 150));
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
	server = spawn(process.execPath, ["--import", "tsx", "packages/server/test/launch-memory.ts"], { cwd: ROOT, env: { ...process.env, PIA_DATA_DIR: DATA, PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
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

interface Sub { id: string; status: string; session_file: string | null; result_summary: string | null; error_reason: string | null }
interface Msg { role: string; content: string }

try {
	await start(await freePort());
	await j("/api/settings", "PUT", { onboarded: true });
	const a = await j<{ id: string }>("/api/agents", "POST", { name: "断网续跑测试" });
	await j(`/api/agents/${a.id}/messages`, "POST", { text: "派个子代理网络断开测试" });
	const sub = await waitFor(async () => (await j<Sub[]>(`/api/subagents?agent=${a.id}`)).find((r) => ["running", "done", "failed", "lost"].includes(r.status)));
	const done = await waitFor(async () => {
		const d = (await j<{ subagent: Sub }>(`/api/subagents/${sub.id}`)).subagent;
		return ["done", "failed", "stopped", "timeout", "lost"].includes(d.status) ? d : undefined;
	});
	assert.equal(done.status, "done", `断网后应有界退避续跑并完成，实际 ${done.status}：${done.error_reason ?? done.result_summary ?? ""}`);
	// 只有一行 subagents 记录：没有因为断网新开子代理
	const all = await j<Sub[]>(`/api/subagents?agent=${a.id}`);
	assert.equal(all.filter((r) => r.id === sub.id).length, 1);
	assert.equal(all.length, 1, "没有新 spawn 出第二条子代理记录");
	assert.ok(done.session_file, "续跑后仍应有落库 session");
	const d = await j<{ messages: Msg[] }>(`/api/subagents/${sub.id}`);
	assert.ok(d.messages.some((m) => m.content.includes("网络断开测试")), "原任务要保留");
	assert.ok(d.messages.some((m) => m.content.includes("断网后继续完成")), "退避重试后在同一会话继续执行");
	// 路由已挂载：已完成的子代理拒绝继续
	const res = await fetch(`${BASE}/api/subagents/${sub.id}/resume`, { method: "POST" });
	assert.equal(res.status, 400, "已完成的子代理拒绝 /resume（路由已挂载）");
	console.log("✅ 断网后在同一子代理会话有界退避续跑：唯一记录、保留原任务、最终完成");
} finally {
	await kill();
}
