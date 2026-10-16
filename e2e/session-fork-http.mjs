/**
 * 「从消息另开会话分支」HTTP 冒烟（真实 server + Mock 模型 + 临时数据目录，不碰用户数据 / 不联网 / 不花钱）。
 * 运行：node e2e/session-fork-http.mjs
 *
 * 要证（真实 HTTP 链路，含 /api/* 鉴权中间件）：POST /api/conversations/:cid/fork 能按 user 消息建分支对话、
 * 源对话保留、clientId 幂等、非 user 消息 fail-closed。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSecurityProbe, spawnMemoryServer, startupEvidence } from "./fixtures/safe-memory-server.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = await new Promise((r) => {
	const sv = createNetServer().listen(0, "127.0.0.1", () => {
		const p = sv.address().port;
		sv.close(() => r(p));
	});
});
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "pia-fork-http-"));

const api = async (path, init = {}) => {
	try {
		const res = await fetch(BASE + path, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) }, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
		const text = await res.text();
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}
		return { status: res.status, body };
	} catch {
		return { status: 0, body: null };
	}
};
const fail = (m) => {
	console.error("✖", m);
	process.exitCode = 1;
};
const ok = (m) => console.log("✔", m);
const wait = async (fn, ms = 20_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
};

const probe = createSecurityProbe(DATA);
const { child: server, startupFile } = spawnMemoryServer({ repoRoot: ROOT, dataDir: DATA, port: PORT, probe, env: { PIA_HOST_CONTROL_DRY_RUN: "1" } });
server.stderr.on("data", (d) => process.env.FORK_SMOKE_VERBOSE && process.stderr.write(d));

try {
	if (!(await wait(async () => (await api("/api/system/public")).status === 200, 30_000))) throw new Error("server 没起来");

	const ev = await startupEvidence(startupFile, probe);
	if (!(ev.storeCalls > 0)) fail(`内存凭据没被访问（storeCalls=${ev.storeCalls}）`);
	else if (ev.securityCalls !== 0) fail(`调用了系统 security ${ev.securityCalls} 次`);
	else ok("启动走测试入口：内存凭据被调用、0 次 security（不碰钥匙串）");

	const agent = (await api("/api/agents", { method: "POST", json: { name: "分支冒烟" } })).body;
	const conv = (await api(`/api/agents/${agent.id}/conversations`)).body.current;
	const u1 = (await api(`/api/agents/${agent.id}/messages`, { method: "POST", json: { text: "你好第一轮", conversationId: conv } })).body;

	if (!(await wait(async () => ((await api(`/api/agents/${agent.id}/messages?conversation=${conv}`)).body ?? []).some((m) => m.role === "assistant" && m.status === "done")))) throw new Error("Mock 模型没回复");
	// entry id 映射是异步落在 user 消息 meta 上的，等它出现
	if (!(await wait(async () => !!(await api(`/api/messages/${u1.id}`)).body?.meta?.piEntryId, 10_000))) throw new Error("user 消息没拿到 piEntryId");
	ok("user 消息拿到可信的 piEntryId（服务端映射，前端不下传）");

	const mid = u1.id;
	// 第一次 fork：Mock 刚回复完也不一定已经 settle（Pi 的 agent_settled 稍晚），busy 时会 409——顺便证 busy 保护真的生效
	let f1 = await api(`/api/conversations/${conv}/fork`, { method: "POST", json: { messageId: mid, clientId: "smoke-1" } });
	if (f1.status === 409 && f1.body?.code === "fork_busy") {
		ok("源对话还在收尾时 fork → 409 fork_busy（不 abort 用户任务）");
		await wait(async () => {
			f1 = await api(`/api/conversations/${conv}/fork`, { method: "POST", json: { messageId: mid, clientId: "smoke-1" } });
			return f1.status === 200;
		}, 15_000);
	}
	if (f1.status !== 200 || !f1.body.conversationId) throw new Error(`fork 失败：${f1.status} ${JSON.stringify(f1.body)}`);
	if (f1.body.created !== true) fail("首次 fork created 应为 true");
	if (f1.body.conversationId === conv) fail("fork 必须是新对话，不能复用源对话");
	if (f1.body.draft !== "你好第一轮") fail(`draft 应是被分支消息正文，实际 ${JSON.stringify(f1.body.draft)}`);
	if (!f1.body.forkedFrom?.entryId) fail("返回应带 forkedFrom.entryId");
	ok(`从第一条 user 消息另开新对话成功：${f1.body.conversationId}`);

	const f2 = await api(`/api/conversations/${conv}/fork`, { method: "POST", json: { messageId: mid, clientId: "smoke-1" } });
	if (f2.body.conversationId !== f1.body.conversationId || f2.body.created !== false) fail(`clientId 幂等失败：${JSON.stringify(f2.body)}`);
	else ok("同 clientId 重复请求 → 同一个对话（created=false）");

	const convs = (await api(`/api/agents/${agent.id}/conversations`)).body;
	if (convs.items.length !== 2) fail(`应有 2 个对话（源 + 分支），实际 ${convs.items.length}`);
	if (convs.current !== conv) fail("fork 不应把服务端 current 切走（源对话保留）");
	else ok("源对话保留、current 不变（可返回原对话）");

	const listed = await api(`/api/agents/${agent.id}/messages?conversation=${f1.body.conversationId}`);
	if (!Array.isArray(listed.body)) fail("分支对话消息列表取不到");
	else if (listed.body.some((m) => m.content === "你好第一轮")) fail("被分支的消息本身不应复制进新对话（另开并编辑语义）");
	else ok("分支对话历史是前缀，不含被分支的那条消息");

	// 非 user 消息 fail-closed
	const assistant = (await api(`/api/agents/${agent.id}/messages?conversation=${conv}`)).body.find((m) => m.role === "assistant");
	const bad = await api(`/api/conversations/${conv}/fork`, { method: "POST", json: { messageId: assistant.id, clientId: "smoke-2" } });
	if (bad.status !== 409 || bad.body.code !== "fork_anchor_not_supported") fail(`非 user 锚点应 409 fork_anchor_not_supported，实际 ${bad.status} ${JSON.stringify(bad.body)}`);
	else ok("非 user 消息只返回明确错误，不会偷偷从别的消息分支");

	// 跨对话 messageId fail-closed
	const cross = await api(`/api/conversations/${f1.body.conversationId}/fork`, { method: "POST", json: { messageId: mid, clientId: "smoke-3" } });
	if (cross.status !== 403 || cross.body.code !== "fork_cross_scope") fail(`跨对话锚点应 403 fork_cross_scope，实际 ${cross.status} ${JSON.stringify(cross.body)}`);
	else ok("跨对话 messageId 被拒（403 fork_cross_scope）");
} catch (e) {
	fail(e instanceof Error ? e.message : String(e));
} finally {
	server.kill("SIGTERM");
	await new Promise((r) => setTimeout(r, 300));
	server.kill("SIGKILL");
	rmSync(DATA, { recursive: true, force: true });
}
console.log(process.exitCode ? "HTTP 冒烟：失败" : "HTTP 冒烟：全部通过");
