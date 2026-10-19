/**
 * 子代理「服务重启后从断点续跑」冒烟测试（真实起服务进程、真重启，Mock 模型，不花钱）：
 *   node --import tsx test/subagent-restart.smoke.ts
 *
 * 流程：起服务 → 让主会话派一个会跑 8 秒命令的子代理 → 杀掉进程 → 用同一数据目录重启
 *      → 断言子代理被重新入队并续跑（不是 lost、不从头重跑），复用落库 session、保留原任务。
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DATA = mkdtempSync(join(tmpdir(), "pia-restart-smoke-"));
let server: ChildProcess | undefined;
let BASE = "";

const freePort = () => new Promise<number>((resolve) => { const sv = createServer().listen(0, "127.0.0.1", () => { const p = (sv.address() as { port: number }).port; sv.close(() => resolve(p)); }); });
const waitFor = async <T>(fn: () => Promise<T | undefined>, ms = 40_000): Promise<T> => {
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

interface Sub { id: string; status: string; session_file: string | null; result_summary: string | null }
interface Msg { role: string; content: string }

try {
	await start(await freePort());
	await j("/api/settings", "PUT", { onboarded: true });
	const a = await j<{ id: string }>("/api/agents", "POST", { name: "重启续跑测试" });
	await j(`/api/agents/${a.id}/messages`, "POST", { text: "派个子代理重启测试" });
	const sub = await waitFor(async () => (await j<Sub[]>(`/api/subagents?agent=${a.id}`)).find((r) => r.status === "running"));
	// 等它真的跑起来：有工具步骤、会话已落库
	const before = await waitFor(async () => {
		const d = await j<{ subagent: Sub; messages: Msg[] }>(`/api/subagents/${sub.id}`);
		return d.messages.some((m) => m.role === "tool") && d.subagent.session_file ? d : undefined;
	});
	console.log(`✅ 子代理运行中，已落库 session：${before.subagent.session_file}`);

	await kill();
	await start(await freePort());
	// 重启后应重新入队 → 续跑 → done；一旦出现 lost 就立刻失败
	const resumed = await waitFor(async () => {
		const d = (await j<{ subagent: Sub }>(`/api/subagents/${sub.id}`)).subagent;
		if (d.status === "lost" || d.status === "done" || d.status === "failed") return d;
		return undefined;
	});
	assert.notEqual(resumed.status, "lost", "重启后不应标 lost，应从断点续跑");
	assert.notEqual(resumed.status, "failed", `重启后续跑不应失败：${resumed.result_summary ?? ""}`);
	assert.equal(resumed.status, "done");
	assert.ok(resumed.session_file, "续跑后仍应有落库 session");
	assert.match(resumed.result_summary ?? "", /子代理已按补充要求调整/, "续跑回复应基于原会话上下文（证明 session 被 resume，而不是从头跑）");
	const d = await j<{ messages: Msg[] }>(`/api/subagents/${sub.id}`);
	assert.ok(d.messages.some((m) => m.content.includes("派个子代理重启测试")), "原任务消息要保留");
	assert.ok(d.messages.some((m) => m.content.includes("服务刚刚重启")), "续跑提示要进入会话");
	console.log("✅ 重启后从中断处续跑：复用 session、保留原任务、未标 lost");
} finally {
	await kill();
}
