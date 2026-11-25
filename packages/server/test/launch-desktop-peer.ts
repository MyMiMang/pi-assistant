// Test-only wrapper: real main, optional direct TLS, and deterministic A/B ID collisions.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { request } from "node:https";
import { createServer } from "node:net";
import { join } from "node:path";
import { httpServer as defaultHttpServer } from "./launch-memory.ts";
const { db } = await import("../src/db.ts");
const { startDirectDesktopPeer, startHttp } = await import("../src/http.ts");
const { insertMessage } = await import("../src/messages.ts");

const loopback = "127.0.0.1";
const { PIA_TEST_PEER: peer, PIA_TEST_TARGET: target, PIA_TEST_NO_DIRECT: noDirect,
	PIA_TEST_EDGE_ORIGIN: edgeOrigin, TMPDIR: dir } = process.env;
assert.ok((peer === "a" || peer === "b") && dir && process.send);
let httpServer = defaultHttpServer;
if (edgeOrigin) {
	assert.ok(peer === "b" && noDirect);
	const edge = new URL(edgeOrigin);
	assert.equal(edgeOrigin, `https://phone-b.test:${edge.port}`);
	assert.ok(edge.port);
	// Keep main's runtime initialization, but use the explicit test ingress for the sole HTTP listener.
	if (!httpServer.listening) await once(httpServer, "listening");
	await new Promise<void>((resolve, reject) => httpServer.close(err => err ? reject(err) : resolve()));
	httpServer = startHttp({ desktopEdgeOrigin: () => edgeOrigin });
}
const agentId = "shared-agent", conversationId = "shared-chat";
const label = peer.toUpperCase();
db.prepare("INSERT OR IGNORE INTO agents(id, name, avatar, color, model_provider, model_id, created_at) VALUES(?,?,?,?,?,?,?)")
	.run(agentId, `Agent ${label}`, label, "#6366f1", "mock", "echo", 1);
const { changes } = db.prepare("INSERT OR IGNORE INTO conversations(id, agent_id, title, created_at, updated_at) VALUES(?,?,?,?,?)")
	.run(conversationId, agentId, `Chat ${label}`, 1, 1);
if (changes) insertMessage({ agentId, conversationId, role: "assistant", content: `History only on ${label}` });

let origin: string | null = null;
if (!noDirect) {
	const reservation = createServer().listen(0, loopback);
	await once(reservation, "listening");
	const address = reservation.address();
	assert.ok(address && typeof address === "object");
	origin = `https://peer-${peer}.test:${address.port}`;
	const tls = { key: readFileSync(join(dir, "peer.key")), cert: readFileSync(join(dir, "peer.pem")) };
	await new Promise<void>((resolve, reject) => reservation.close(err => err ? reject(err) : resolve()));
	const direct = startDirectDesktopPeer({ hostname: loopback, port: address.port, origin, tls });
	await once(direct, "listening");
}
if (!httpServer.listening) await once(httpServer, "listening");
const local = httpServer.address();
assert.ok(local && typeof local === "object");

// Only the legacy direct-TLS test needs the fixture's raw IPC client. The
// edge test starts A without a target and runs the bundled CLI separately.
if (peer === "a" && !noDirect) {
	assert.ok(target);
	const b = new URL(target);
	assert.equal(b.origin, target);
	assert.equal(b.hostname, "peer-b.test");
	assert.equal(b.protocol, "https:");
	assert.ok(b.port);
	const ca = readFileSync(join(dir, "target-ca.pem"));
	type Call = { id: number; path: string; payload?: object; token?: string };
	process.on("message", ({ id, path, payload, token }: Call) => {
		const body = payload === undefined ? undefined : JSON.stringify(payload);
		const req = request({ hostname: loopback, port: Number(b.port), servername: b.hostname, ca, rejectUnauthorized: true, agent: false,
			method: body === undefined ? "GET" : "POST", path, signal: AbortSignal.timeout(5_000),
			headers: { host: b.host, ...(token ? { authorization: `Bearer ${token}` } : {}),
				...(body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) }) },
		}, async res => {
			try {
				const chunks = [];
				for await (const chunk of res) chunks.push(chunk);
				process.send?.({ id, status: res.statusCode, body: Buffer.concat(chunks).toString() });
			} catch (err) { process.send?.({ id, error: String(err) }); }
		});
		req.on("error", (err: NodeJS.ErrnoException) => process.send?.({ id, error: err.message, code: err.code }));
		req.end(body);
	});
}
process.send({ ready: true, origin, local: `http://${loopback}:${local.port}`, pid: process.pid });
