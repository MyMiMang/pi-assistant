import "./setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { desktopPairStore } from "../src/desktop-pair.ts";
import { startDesktopPeerTls } from "../src/desktop-peer-tls.ts";
import type { Env } from "../src/routes/common.ts";
import { mountDesktopPairRoutes } from "../src/routes/desktop-pair.ts";

const loopback = "127.0.0.1";
const primaryName = "fixture.test";
const alternateName = "alternate.fixture.test";
const secondaryName = "other.fixture.test";

function certificates(dir: string, name: string, names = [name]) {
	const rootKey = `${name}.ca.key`, rootCert = `${name}.ca.pem`;
	const leafKey = `${name}.key`, leafCert = `${name}.pem`, csr = `${name}.csr`;
	const config = `${name}.cnf`;
	writeFileSync(join(dir, config), `[req]
 distinguished_name = subject
 [subject]
 [ca_ext]
 basicConstraints = critical,CA:TRUE,pathlen:0
 keyUsage = critical,keyCertSign,cRLSign
 [leaf_ext]
 basicConstraints = critical,CA:FALSE
 keyUsage = critical,digitalSignature,keyEncipherment
 extendedKeyUsage = serverAuth
 subjectAltName = ${names.map(dns => `DNS:${dns}`).join(",")}
`);
	const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe", timeout: 10_000 });
	openssl("req", "-new", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2", "-config", config,
		"-extensions", "ca_ext", "-subj", `/CN=${name} test CA`, "-keyout", rootKey, "-out", rootCert);
	openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-config", config,
		"-subj", `/CN=${name}`, "-keyout", leafKey, "-out", csr);
	openssl("x509", "-req", "-sha256", "-days", "2", "-in", csr, "-CA", rootCert, "-CAkey", rootKey,
		"-set_serial", "1", "-extfile", config, "-extensions", "leaf_ext", "-out", leafCert);
	return { ca: readFileSync(join(dir, rootCert)), tls: { key: readFileSync(join(dir, leafKey)), cert: readFileSync(join(dir, leafCert)) } };
}

const close = (server: Server) => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));

async function startFixture(t: TestContext, name: string, certs: ReturnType<typeof certificates>) {
	// The configured origin must include the listener's real port. Let the OS choose it,
	// then hand it off immediately to the TLS listener without doing other work in between.
	const reservation = createServer().listen(0, loopback);
	await once(reservation, "listening");
	const address = reservation.address();
	await close(reservation);
	assert.ok(address && typeof address === "object");
	const { port } = address;
	const origin = `https://${name}:${port}`;
	const observations: { origin: string; requestOrigin: string }[] = [];
	const app = new Hono<Env>();
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT, platform TEXT, status TEXT, created_at INTEGER, token_hash TEXT)");
	const store = desktopPairStore(db);
	t.after(() => db.close());
	const identity = { serverId: `id-${name}`, publicKey: `key-${name}` };
	app.use("*", (c, next) => {
		c.set("caller", { local: false, deviceId: null, ip: loopback });
		return next();
	});
	mountDesktopPairRoutes(app, store, () => identity, () => origin);
	const server = startDesktopPeerTls({ hostname: loopback, port, origin, tls: certs.tls, handle: (req, targetOrigin) => {
		observations.push({ origin: targetOrigin, requestOrigin: new URL(req.url).origin });
		return app.fetch(req);
	} });
	t.after(async () => { if (server.listening) await close(server); });
	if (!server.listening) await once(server, "listening");
	return { name, port, origin, identity, ca: certs.ca, observations, store };
}

type Fixture = Awaited<ReturnType<typeof startFixture>>;

function post(fixture: Fixture, operation: string, payload: object, options: { ca?: Buffer; servername?: string; host?: string } = {}) {
	const body = JSON.stringify(payload);
	return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
		const req = request({
			hostname: loopback, port: fixture.port, servername: options.servername ?? fixture.name,
			// Explicit CA replaces Node's default trust roots. A fresh connection verifies every case.
			ca: options.ca ?? fixture.ca, rejectUnauthorized: true, agent: false,
			method: "POST", path: `/api/desktop-pair/${operation}`,
			headers: { host: options.host ?? new URL(fixture.origin).host, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
			signal: AbortSignal.timeout(5_000),
		}, res => {
			let body = "";
			res.setEncoding("utf8").on("data", chunk => { body += chunk; });
			res.on("error", reject);
			res.on("end", () => resolve({ status: res.statusCode, body }));
		});
		req.on("error", reject);
		req.end(body);
	});
}

test("桌面 HTTPS：验证证书、精确匹配 Host 与 SNI，并隔离两台服务的配对身份", { timeout: 30_000 }, async t => {
	const dir = mkdtempSync(join(tmpdir(), "pia-desktop-peer-tls-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const primary = await startFixture(t, primaryName, certificates(dir, primaryName, [primaryName, alternateName]));
	const secondary = await startFixture(t, secondaryName, certificates(dir, secondaryName));

	await t.test("不受信的 CA 或不匹配的证书域名在 TLS 层被拒", async () => {
		await assert.rejects(post(primary, "claim", {}, { ca: secondary.ca }), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
		await assert.rejects(post(primary, "claim", {}, { servername: secondary.name }), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
		assert.deepEqual(primary.observations, []);
	});

	await t.test("TLS 验证通过也必须精确匹配配置的 Host（含端口）和 SNI", async () => {
		assert.equal((await post(primary, "claim", {}, { host: primary.name })).status, 421);
		assert.equal((await post(primary, "claim", {}, { host: `${secondary.name}:${primary.port}` })).status, 421);
		// This name is in the leaf SAN, so only the listener's SNI check can reject it.
		assert.equal((await post(primary, "claim", {}, { servername: alternateName })).status, 421);
		assert.deepEqual(primary.observations, []);
	});

	await t.test("正确的 TLS 身份只能完成本服务经本地批准的合成配对", async () => {
		const invite = primary.store.invite({ origin: primary.origin, ...primary.identity });
		const secret = randomBytes(32);
		const claim = { ...invite, commitment: createHash("sha256").update(secret).digest("hex") };
		const wrongIdentity = await post(secondary, "claim", claim);
		assert.equal(wrongIdentity.status, 409);
		assert.deepEqual(JSON.parse(wrongIdentity.body), { error: "desktop_identity_changed" });
		assert.equal((await post(secondary, "claim", { ...claim, ...secondary.identity })).status, 403);

		const accepted = await post(primary, "claim", claim);
		assert.equal(accepted.status, 200);
		const { id } = JSON.parse(accepted.body);
		assert.equal(typeof id, "string");
		const collect = { ...primary.identity, id, proof: secret.toString("base64url") };
		const pending = await post(primary, "collect", collect);
		assert.equal(pending.status, 200);
		assert.deepEqual(JSON.parse(pending.body), { status: "pending" });
		assert.equal((await post(primary, "approve", { id })).status, 403);
		assert.equal(primary.store.approve(id), true);
		const issued = await post(primary, "collect", collect);
		assert.equal(issued.status, 200);
		const { status, token, deviceId } = JSON.parse(issued.body);
		assert.equal(status, "issued");
		assert.equal(typeof token, "string");
		const confirmation = { ...primary.identity, id, receipt: token };
		assert.equal((await post(secondary, "confirm", confirmation)).status, 409);
		const confirmed = await post(primary, "confirm", confirmation);
		assert.equal(confirmed.status, 200);
		assert.deepEqual(JSON.parse(confirmed.body), { ok: true });
		assert.equal(primary.store.bound(deviceId, { ...primary.identity, origin: primary.origin }), true);
		assert.equal(secondary.store.bound(deviceId, { ...secondary.identity, origin: secondary.origin }), false);
		assert.equal((await post(primary, "collect", collect)).status, 403);
		for (const fixture of [primary, secondary]) {
			assert.ok(fixture.observations.length > 0);
			for (const actual of fixture.observations) {
				assert.deepEqual(actual, { origin: fixture.origin, requestOrigin: fixture.origin });
			}
		}
	});
});
