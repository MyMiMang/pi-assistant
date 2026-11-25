// macOS: sandbox-exec -f e2e/fixtures/desktop-peer-loopback.sb node e2e/desktop-peer-phone-route.mjs
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer, request as httpsRequest } from "node:https";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { cleanupTempRun, makeTempRun, startTempServer } from "./fixtures/temp-server.mjs";

const root = new URL("../", import.meta.url);
const baseEnv = { PATH: "/usr/bin:/bin" };
const loopback = "127.0.0.1", phoneHost = "phone-b.test";
const agents = "/api/agents", chats = `${agents}/shared-agent/conversations`;
const messages = `${agents}/shared-agent/messages`, history = `${messages}?conversation=shared-chat`;
const desktop = op => `/api/desktop-pair/${op}`;
const edge = op => `/api/desktop-edge-pair/${op}`;
const identityPath = "/api/system/public", unauthorized = { error: "unauthorized" };

function makeCertificates(run) {
	const openssl = (...args) => execFileSync("openssl", args, {
		cwd: run.runDir, env: { ...baseEnv, HOME: run.home, TMPDIR: run.runDir }, stdio: "pipe", timeout: 10_000,
	});
	const write = (name, text) => writeFileSync(join(run.runDir, name), text);
	write("ca.cnf", "[req]\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n");
	openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-sha256", "-subj", "/CN=Phone route test CA",
		"-config", "ca.cnf", "-keyout", "ca.key", "-out", "ca.pem");
	for (const [stem, host] of [["peer", "peer-b.test"], ["phone", phoneHost]]) {
		write("leaf.cnf", `basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${host}\n`);
		openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-config", "ca.cnf", "-subj", `/CN=${host}`,
			"-keyout", `${stem}.key`, "-out", `${stem}.csr`);
		openssl("x509", "-req", "-in", `${stem}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-set_serial", stem === "peer" ? "1" : "2",
			"-days", "1", "-sha256", "-extfile", "leaf.cnf", "-out", `${stem}.pem`);
	}
	const read = name => readFileSync(join(run.runDir, name));
	return { ca: read("ca.pem"), key: read("phone.key"), cert: read("phone.pem") };
}

async function childMessage(child, timeout) {
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]);
	try {
		assert.ok(child.exitCode === null && child.signalCode === null && child.connected, "fixture child is running");
		const result = Promise.race([
			once(child, "message", { signal }),
			once(child, "exit", { signal }).then(([code, reason]) => { throw new Error(`Fixture child exited: ${code ?? reason}`); }),
		]);
		const [message] = await result;
		return message;
	} finally {
		controller.abort();
	}
}

function phoneGateway(tls, upstreamPort) {
	// The gateway, not the client, supplies ordinary remote provenance. The
	// upstream is fixed to B's normal HTTP listener, never its direct TLS port.
	return createServer(tls, (req, res) => {
		const headers = { host: req.headers.host, "x-forwarded-for": "192.0.2.10" };
		for (const name of ["authorization", "content-type", "content-length"]) {
			if (req.headers[name] !== undefined) headers[name] = req.headers[name];
		}
		const upstream = httpRequest({ hostname: loopback, port: upstreamPort(), path: req.url, method: req.method,
			headers, agent: false, signal: AbortSignal.timeout(5_000) }, reply => {
			res.writeHead(reply.statusCode, reply.headers);
			reply.on("error", err => res.destroy(err));
			reply.pipe(res);
		});
		upstream.on("error", () => {
			if (!res.headersSent) res.writeHead(502).end();
			else res.destroy();
		});
		res.on("close", () => upstream.destroy());
		req.pipe(upstream);
	});
}

function jsonClient(request, connection) {
	return async (path, { payload, token, status = 200, method = payload === undefined ? "GET" : "POST" } = {}) => {
		const body = payload === undefined ? undefined : JSON.stringify(payload);
		const response = await new Promise((resolve, reject) => {
			const req = request({ ...connection, hostname: loopback, path, method, agent: false, signal: AbortSignal.timeout(5_000),
				headers: { ...connection.headers, ...(token ? { authorization: `Bearer ${token}` } : {}),
					...(body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) }) },
			}, resolve);
			req.on("error", reject);
			req.end(body);
		});
		// Assert the status without including sensitive response bodies in errors.
		const chunks = [];
		for await (const chunk of response) chunks.push(chunk);
		assert.equal(response.statusCode, status, `${method} ${path} via ${request === httpsRequest ? "HTTPS gateway" : "local HTTP"}`);
		return JSON.parse(Buffer.concat(chunks).toString());
	};
}

async function exercisePhoneAndOldDirect(local, phone, directOrigin) {
	assert.deepEqual(await phone(agents, { status: 401 }), unauthorized);
	const { shortCode, preApproved } = await local("/api/pair/start", { payload: { preApproved: false } });
	assert.equal(preApproved, false);
	assert.ok(shortCode, "B issued a phone pairing code");
	const claim = await phone("/api/pair/claim", { payload: { code: shortCode, name: "Fixture phone", platform: "iPhone" } });
	assert.equal(claim.preApproved, false);
	assert.ok(claim.deviceId, "B created an ordinary device");
	const statusPath = `/api/pair/status/${claim.deviceId}`, devicePath = `/api/devices/${claim.deviceId}`;
	assert.deepEqual(await phone(statusPath), { status: "pending" });
	assert.deepEqual(await phone(agents, { status: 401 }), unauthorized);
	assert.deepEqual(await local(`${devicePath}/approve`, { method: "POST" }), { ok: true });
	const approval = await phone(statusPath);
	assert.equal(approval.status, "active");
	assert.ok(typeof approval.token === "string" && approval.token.length > 0, "approved phone received a credential");
	const device = (await local("/api/devices")).find(row => row.id === claim.deviceId);
	assert.equal(device?.owner, 0);
	const auth = { token: approval.token };
	assert.deepEqual((await phone(agents, auth)).map(({ id, name }) => [id, name]), [["shared-agent", "Agent B"]]);
	assert.deepEqual((await phone(chats, auth)).items.map(({ id, title }) => [id, title]), [["shared-chat", "Chat B"]]);
	assert.deepEqual((await phone(history, auth)).map(row => row.content), ["History only on B"]);
	console.log("手机：未认证列表 401；普通设备待审批 → B 本机批准；经 HTTPS 读取 B 的助理、会话与历史");

	const { origin, serverId, publicKey, code } = await local(desktop("invite"), { payload: {} });
	assert.equal(origin, directOrigin);
	assert.equal(serverId, claim.serverId);
	assert.equal(publicKey, claim.publicKey);
	assert.ok(code, "B issued a fresh desktop invitation");
	const commitment = createHash("sha256").update(randomBytes(32)).digest("hex");
	assert.deepEqual(await phone(desktop("claim"), { status: 409,
		payload: { origin, serverId, publicKey, code, commitment, name: "Fixture desktop", platform: "macOS" },
	}), { error: "desktop_https_entry_required" });
	assert.deepEqual(await local(desktop("pending"), { payload: {} }), { requests: [] });
	console.log("桌面：有效邀请经同一普通 HTTPS 入口提交，返回 409，B 没有新增待审批项");

	return { auth, devicePath, serverId, publicKey };
}

// Resolve only the fixture hostname inside the CLI child. Keep the production
// fetch, original URL/Host/SNI, and Node's normal certificate validation.
const loopbackResolver = `data:text/javascript,${encodeURIComponent(`
	import dns from 'node:dns';
	import { syncBuiltinESMExports } from 'node:module';
	dns.lookup = (name, options, callback) => {
		if (typeof options === 'function') [callback, options] = [options, {}];
		queueMicrotask(() => {
			if (name !== ${JSON.stringify(phoneHost)}) return callback(Error('Unexpected fixture hostname'));
			if (options?.all) return callback(null, [{ address: '${loopback}', family: 4 }]);
			callback(null, '${loopback}', 4);
		});
	};
	syncBuiltinESMExports();
`)}`;

async function cli(run, caPath, input, expectedError) {
	const output = await new Promise((resolve, reject) => {
		const child = execFile(process.execPath, ["--import", loopbackResolver, "packages/server/src/desktop-peer-client.mjs"], {
			cwd: root, timeout: 22_000, maxBuffer: 1024 * 1024,
			env: { ...baseEnv, HOME: run.home, TMPDIR: run.runDir, ...(caPath ? { NODE_EXTRA_CA_CERTS: caPath } : {}) },
		}, (err, stdout) => {
			// Do not log stdout or request input: some commands carry ephemeral credentials.
			if (err) reject(Error(`desktop CLI ${input.op} failed to exit cleanly (${err.signal ?? err.code})`));
			else resolve(stdout);
		});
		child.stdin.on("error", err => reject(Error(`desktop CLI ${input.op} stdin failed (${err.code})`)));
		child.stdin.end(`${JSON.stringify(input)}\n`);
	});
	let result;
	try { result = JSON.parse(output); }
	catch { throw Error(`desktop CLI ${input.op} did not return a JSON envelope`); }
	assert.ok(result && typeof result === "object", `desktop CLI ${input.op} returned an envelope`);
	assert.equal(result.error, expectedError, `desktop CLI ${input.op}`);
	assert.equal(Object.hasOwn(result, "value"), !expectedError, `desktop CLI ${input.op} value presence`);
	return result.value;
}

async function exerciseEdge(a, b, phone, origin, caPath, phonePair, disconnect) {
	const call = (input, error) => cli(aRun, caPath, input, error);
	const aId = await a.local(identityPath), bId = await b.local(identityPath);
	assert.notEqual(aId.serverId, bId.serverId);
	assert.equal(bId.serverId, phonePair.serverId);
	assert.equal(bId.publicKey, phonePair.publicKey);
	const aBefore = await a.local(history), bBefore = await b.local(history);
	assert.deepEqual(aBefore.map(row => row.content), ["History only on A"]);
	assert.deepEqual(bBefore.map(row => row.content), ["History only on B"]);
	assert.deepEqual((await a.local(chats)).items.map(({ id, title }) => [id, title]), [["shared-chat", "Chat A"]]);
	const originArg = { payload: { origin } };
	const target = { origin, serverId: bId.serverId, publicKey: bId.publicKey };
	const invite = await b.local(edge("invite"), originArg);
	const previewInput = { op: "preview", invite: JSON.stringify(invite) };
	await cli(aRun, undefined, previewInput, "peer_request_failed");
	const preview = await call(previewInput);
	assert.deepEqual({ origin: preview.origin, serverId: preview.serverId, publicKey: preview.publicKey }, target);
	assert.equal(preview.targetName, phoneHost);
	assert.ok(preview.handle && preview.code === invite.code && preview.expires === invite.expires, "CLI returned the authenticated invitation");
	console.log("TLS：同一 CLI 不带测试 CA 拒绝，带 CA 成功验证邀请与预览主机名");

	const name = "Fixture desktop A";
	const claim = await call({ op: "claim", peer: preview, name });
	const pendingPeer = { ...target, claimId: claim.claimId, proof: claim.proof };
	assert.deepEqual(await call({ op: "collect", peer: pendingPeer }), { status: "pending" });
	const { requests } = await b.local(edge("pending"), originArg);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].id, claim.claimId);
	assert.equal(requests[0].name, name);
	assert.match(claim.checkCode, /^[a-f0-9]{12}$/);
	assert.equal(requests[0].checkCode, claim.checkCode);
	assert.deepEqual(await b.local(edge("approve"), { payload: { origin, id: claim.claimId } }), { ok: true });
	const { status, deviceId, token } = await call({ op: "collect", peer: pendingPeer });
	assert.equal(status, "issued");
	assert.ok(deviceId && token && token !== phonePair.auth.token, "B issued a separate desktop credential");
	const peer = { ...target, token };
	await call({ op: "status", peer }, "revoked");
	assert.equal(await call({ op: "confirm", peer: { ...pendingPeer, token } }), null);
	assert.equal(await call({ op: "status", peer }), "online");
	assert.deepEqual(await b.local(edge("pending"), originArg), { requests: [] });
	console.log("桌面 CLI：申请人名称与校验码在 B 待审批中一致；本机批准后仍须确认才激活");

	// Server-side restriction: this route is deliberately not a CLI operation.
	assert.deepEqual(await phone("/api/devices", { token, status: 403 }), { error: "desktop_operation_unavailable" });
	const scope = { agent: "shared-agent", conversation: "shared-chat" };
	const read = { op: "read", peer, ...scope };
	const readView = rows => rows.map(({ id, role, content }) => ({ id, role, content }));
	assert.deepEqual(await call({ op: "chats", peer }), [{ ...scope, title: "Chat B" }]);
	assert.deepEqual(await call(read), readView(bBefore));
	const text = `请复述本轮标记：${randomBytes(8).toString("hex")}`;
	const task = { op: "send", peer, ...scope, text, clientId: "desktop-edge-text-task" };
	const sent = await call(task);
	const deadline = Date.now() + 15_000;
	let bAfter, reply;
	do {
		const remoteReply = (await call(read)).find(row => row.role === "assistant" && row.content.includes(text));
		if (remoteReply) {
			bAfter = await b.local(history);
			reply = bAfter.find(row => row.id === remoteReply.id && row.role === "assistant" && row.status === "done");
		}
		if (!reply) await delay(200);
	} while (!reply && Date.now() < deadline);
	assert.ok(reply, "B completed the Mock reply visible through CLI read");
	assert.match(reply.content, /Mock 模型/);
	const writes = bAfter.filter(row => row.role === "user" && row.content === text);
	assert.equal(writes.length, 1);
	const [write] = writes;
	assert.deepEqual(sent, { id: write.id, agent: write.agent_id, conversation: write.conversation_id });
	assert.equal(sent.agent, scope.agent);
	assert.equal(sent.conversation, scope.conversation);
	assert.deepEqual(await call(read), readView(bAfter));
	assert.deepEqual(await a.local(history), aBefore);
	console.log("桌面 CLI：同 ID 只列出 B 会话；读取 B 历史与回复；发送回执匹配 B 唯一写入，A 未变化");

	await disconnect(() => call({ ...task, clientId: "offline-write" }, "peer_request_failed"));
	assert.deepEqual(await call(read), readView(bAfter));
	assert.deepEqual(await a.local(history), aBefore);
	assert.deepEqual(await b.local(`/api/devices/${deviceId}`, { method: "DELETE" }), { ok: true });
	await call(read, "revoked");
	await call({ ...task, clientId: "revoked-write" }, "revoked");
	assert.deepEqual(await b.local(history), bAfter);
	assert.deepEqual(await a.local(history), aBefore);
	assert.deepEqual(await phone(history, phonePair.auth), bAfter);
	assert.deepEqual(await b.local(phonePair.devicePath, { method: "DELETE" }), { ok: true });
	assert.deepEqual(await phone(agents, { ...phonePair.auth, status: 401 }), unauthorized);
	assert.deepEqual(await phone(history, { ...phonePair.auth, status: 401 }), unauthorized);
	console.log("断线与撤销：恢复后没有重发；撤销桌面凭据后无法读写，手机仍可用，直至单独撤销");
}

const run = makeTempRun("pia-desktop-peer-phone-"), aRun = makeTempRun("pia-desktop-edge-a-");
const servers = [];
async function start(peer, fixtureRun, extra = {}) {
	const server = startTempServer({ root, run: fixtureRun, port: 0, baseEnv, entry: "packages/server/test/launch-desktop-peer.ts", ipc: true,
		extra: { PIA_HOST: loopback, PIA_SANDBOX: "workspace", PIA_TEST_PEER: peer, ...extra },
	});
	servers.push(server);
	const ready = await childMessage(server.child, 25_000);
	assert.equal(ready?.ready, true);
	const url = new URL(ready.local);
	assert.equal(url.protocol, "http:");
	assert.equal(url.hostname, loopback);
	assert.ok(url.port);
	return { ...ready, server, port: Number(url.port), local: jsonClient(httpRequest, { port: Number(url.port) }) };
}

let gateway;
async function closeGateway() {
	if (!gateway?.listening) return;
	await new Promise((resolve, reject) => {
		gateway.close(err => err ? reject(err) : resolve());
		gateway.closeAllConnections();
	});
}
try {
	const tls = makeCertificates(run);
	const oldB = await start("b", run);
	let upstreamPort = oldB.port;
	async function listenGateway(port) {
		gateway = phoneGateway(tls, () => upstreamPort).listen(port, loopback);
		await once(gateway, "listening", { signal: AbortSignal.timeout(5_000) });
		return gateway.address().port;
	}
	const port = await listenGateway(0);
	const origin = `https://${phoneHost}:${port}`;
	const phone = jsonClient(httpsRequest, { port, servername: phoneHost, ca: tls.ca, rejectUnauthorized: true,
		headers: { host: `${phoneHost}:${port}` } });
	const phonePair = await exercisePhoneAndOldDirect(oldB.local, phone, oldB.origin);
	await oldB.server.stop();
	const b = await start("b", run, { PIA_TEST_NO_DIRECT: "1", PIA_TEST_EDGE_ORIGIN: origin });
	assert.equal(b.origin, null);
	upstreamPort = b.port;
	const a = await start("a", aRun, { PIA_TEST_NO_DIRECT: "1" });
	assert.notEqual(a.pid, b.pid);
	assert.notEqual(a.local, b.local);
	await exerciseEdge(a, b, phone, origin, join(run.runDir, "ca.pem"), phonePair, async whileOffline => {
		await closeGateway();
		await whileOffline();
		assert.equal(await listenGateway(port), port);
	});
	console.log("PASS desktop-peer-phone-route (loopback only: client HTTPS → gateway → B plain HTTP)");
} catch (err) {
	for (const server of servers) console.error(server.logs());
	throw err;
} finally {
	try {
		await closeGateway();
	} finally {
		try { await Promise.all(servers.map(server => server.stop())); }
		finally { cleanupTempRun(run); cleanupTempRun(aRun); }
	}
}
