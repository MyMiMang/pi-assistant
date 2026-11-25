// Headless service integration. On macOS run with e2e/fixtures/desktop-peer-loopback.sb.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { cleanupTempRun, makeTempRun, startTempServer } from "./fixtures/temp-server.mjs";

const root = new URL("../", import.meta.url);
const baseEnv = { PATH: "/usr/bin:/bin" };
const runs = [], servers = [];
const agents = "/api/agents", chats = `${agents}/shared-agent/conversations`;
const messages = `${agents}/shared-agent/messages`, history = `${messages}?conversation=shared-chat`;
const pair = op => `/api/desktop-pair/${op}`;
let nextId = 0;

function waitFor(child, match, ms) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error("Timed out waiting for child")), ms);
		const onExit = (code, signal) => finish(new Error(`Child exited: ${code ?? signal}`));
		const onMessage = event => { if (match(event)) finish(null, event); };
		function finish(err, event) {
			clearTimeout(timer);
			child.off("message", onMessage).off("exit", onExit).off("error", finish);
			if (err) reject(err); else resolve(event);
		}
		child.on("message", onMessage).once("exit", onExit).once("error", finish);
		if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
	});
}

async function start(peer, target) {
	const run = makeTempRun(`pia-desktop-peer-${peer}-`);
	runs.push(run);
	const name = `peer-${peer}.test`;
	writeFileSync(join(run.runDir, "openssl.cnf"), `[req]\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\n[ext]\nsubjectAltName=DNS:${name}\n`);
	execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-sha256", "-subj", `/CN=${name}`,
		"-config", "openssl.cnf", "-keyout", "peer.key", "-out", "peer.pem"], {
		cwd: run.runDir, env: { ...baseEnv, HOME: run.home, TMPDIR: run.runDir }, stdio: "pipe", timeout: 10_000,
	});
	if (target) copyFileSync(join(target.run.runDir, "peer.pem"), join(run.runDir, "target-ca.pem"));
	const server = startTempServer({ root, run, port: 0, baseEnv, entry: "packages/server/test/launch-desktop-peer.ts", ipc: true,
		extra: { PIA_WORKSPACE: join(run.data, "workspace"), PIA_HOST: "127.0.0.1", PIA_SANDBOX: "workspace",
			PIA_TEST_PEER: peer, ...(target ? { PIA_TEST_TARGET: target.origin } : {}) },
	});
	servers.push(server);
	return { ...await waitFor(server.child, event => event.ready, 25_000), run, child: server.child };
}

async function local(peer, path, payload, method = payload === undefined ? "GET" : "POST") {
	const res = await fetch(`${peer.local}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(5_000),
		...(payload === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
	});
	assert.equal(res.status, 200, `local ${method} ${path}`);
	return res.json();
}

async function fromA(a, path, { payload, token, status = 200 } = {}) {
	const id = ++nextId;
	const result = waitFor(a.child, event => event.id === id, 7_000);
	a.child.send({ id, path, payload, token });
	const response = await result;
	assert.ok(!response.error, `A → B ${path}: ${response.error}`);
	// Do not include response bodies here: collect returns an ephemeral credential.
	assert.equal(response.status, status, `A → B ${path}`);
	return response.body ? JSON.parse(response.body) : undefined;
}

async function exercise() {
	const b = await start("b"), a = await start("a", b);
	assert.notEqual(a.pid, b.pid);
	assert.notEqual(a.local, b.local);
	assert.notEqual(a.origin, b.origin);
	const aId = await local(a, "/api/system/public"), bId = await local(b, "/api/system/public");
	assert.notEqual(aId.serverId, bId.serverId);
	const remoteId = await fromA(a, "/api/system/public");
	assert.deepEqual(remoteId, bId);
	const aAgents = await local(a, agents), aChats = await local(a, chats), aBefore = await local(a, history);
	assert.deepEqual(aAgents.map(({ id, name }) => [id, name]), [["shared-agent", "Agent A"]]);
	assert.deepEqual(aChats.items.map(({ id, title }) => [id, title]), [["shared-chat", "Chat A"]]);
	assert.deepEqual(aBefore.map(m => m.content), ["History only on A"]);
	console.log(`隔离：A pid=${a.pid} ${a.origin}，B pid=${b.pid} ${b.origin}；实例身份不同`);

	assert.deepEqual(await fromA(a, agents, { status: 401 }), { error: "unauthorized" });
	const invite = await local(b, pair("invite"), {});
	assert.equal(invite.origin, b.origin);
	assert.equal(invite.serverId, bId.serverId);
	assert.equal(invite.publicKey, bId.publicKey);
	const proof = randomBytes(32), commitment = createHash("sha256").update(proof).digest("hex");
	const identity = { origin: b.origin, serverId: bId.serverId, publicKey: bId.publicKey };
	const { id } = await fromA(a, pair("claim"), { payload: { ...identity, code: invite.code, commitment, name: "Peer A fixture", platform: "fixture" } });
	const collect = { ...identity, id, proof: proof.toString("base64url") };
	assert.deepEqual(await fromA(a, pair("collect"), { payload: collect }), { status: "pending" });
	const { requests } = await local(b, pair("pending"), {});
	assert.equal(requests.find(row => row.id === id)?.checkCode, commitment.slice(0, 12));
	assert.deepEqual(await local(a, pair("pending"), {}), { requests: [] });
	assert.deepEqual(await local(b, pair("approve"), { id }), { ok: true });
	const { deviceId, token } = await fromA(a, pair("collect"), { payload: collect });
	assert.ok(deviceId && token, "B issued an ephemeral device credential");
	assert.deepEqual(await fromA(a, agents, { token, status: 401 }), { error: "unauthorized" });
	assert.deepEqual(await fromA(a, pair("confirm"), { payload: { ...identity, id, receipt: token } }), { ok: true });
	console.log("配对：未配对 401 → B 待审批 → B 本地批准 → 确认前 401 → A 确认");

	const bAgents = await fromA(a, agents, { token }), bChats = await fromA(a, chats, { token });
	const bBefore = await fromA(a, history, { token });
	assert.deepEqual(bAgents.map(({ id, name }) => [id, name]), [["shared-agent", "Agent B"]]);
	assert.deepEqual(bChats.items.map(({ id, title }) => [id, title]), [["shared-chat", "Chat B"]]);
	assert.deepEqual(bBefore.map(m => m.content), ["History only on B"]);
	console.log("读取：A/B 助理和会话 ID 相同；A 的 TLS 客户端只读到 B 的列表和历史");

	const text = "请复述本轮标记：" + randomBytes(8).toString("hex");
	const task = { text, conversationId: "shared-chat", clientId: "desktop-peer-text-task" };
	const sent = await fromA(a, messages, { token, payload: task });
	assert.equal(sent.role, "user");
	assert.equal(sent.content, text);
	assert.equal(sent.conversation_id, task.conversationId);
	const deadline = Date.now() + 15_000;
	let reply;
	do {
		const rows = await fromA(a, history, { token });
		reply = rows.find(m => m.role === "assistant" && m.status === "done" && m.content.includes(text));
		if (!reply) await delay(200);
	} while (!reply && Date.now() < deadline);
	assert.ok(reply, "B runtime completed the Mock reply to the submitted text");
	assert.match(reply.content, /Mock 模型/);
	const bAfter = await local(b, history);
	assert.equal(bAfter.filter(m => m.role === "user" && m.content === text).length, 1);
	assert.ok(bAfter.some(m => m.id === sent.id) && bAfter.some(m => m.id === reply.id));
	assert.deepEqual(await local(a, history), aBefore);
	console.log("文本：B 保存一条用户消息及已完成的 Mock 回复，A 本地会话未变化");

	assert.deepEqual(await local(b, `/api/devices/${deviceId}`, undefined, "DELETE"), { ok: true });
	assert.deepEqual(await fromA(a, history, { token, status: 401 }), { error: "unauthorized" });
	assert.deepEqual(await fromA(a, messages, { token, payload: { ...task, clientId: "revoked-write" }, status: 401 }), { error: "unauthorized" });
	assert.deepEqual(await local(b, history), bAfter);
	assert.deepEqual(await local(a, history), aBefore);
	console.log("撤销：同一凭据读、写均返回 401；A/B 本地历史均未变化");
}

try {
	await exercise();
	console.log("PASS desktop-peer-text");
} catch (err) {
	for (const server of servers) console.error(server.logs());
	throw err;
} finally {
	await Promise.all(servers.map(server => server.stop()));
	for (const run of runs) cleanupTempRun(run);
}
