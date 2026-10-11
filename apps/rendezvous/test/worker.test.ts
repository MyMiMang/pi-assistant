import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { test } from "node:test";
import worker, { registrationMessage, validUrl } from "../src/index.ts";

function kv() {
	const m = new Map<string, string>();
	return { get: async (k: string, t?: string) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)!) : m.get(k)) : null), put: async (k: string, v: string) => void m.set(k, v) } as unknown as KVNamespace;
}
const env = { SERVERS: kv(), ASSETS: { fetch: async () => new Response("shell") } } as never;
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pk = publicKey.export({ format: "jwk" }).x as string;
const id = randomUUID();
const put = (url: string, ts: number, key = privateKey, pub = pk) =>
	worker.fetch(new Request(`https://app.test/api/servers/${id}`, { method: "PUT", body: JSON.stringify({ url, ts, publicKey: pub, sig: sign(null, Buffer.from(registrationMessage(id, url, ts)), key).toString("base64url") }) }), env);

test("URL 校验", () => {
	assert.ok(validUrl("https://abc-def.trycloudflare.com"));
	assert.ok(!validUrl("http://abc.trycloudflare.com"));
	assert.ok(!validUrl("https://abc.com/x"));
});
test("签名注册、查询、防重放、防抢注", async () => {
	const ts = Date.now();
	assert.equal((await put("https://a-b.trycloudflare.com", ts)).status, 200);
	const got = (await (await worker.fetch(new Request(`https://app.test/api/servers/${id}`), env)).json()) as { url: string };
	assert.equal(got.url, "https://a-b.trycloudflare.com");
	assert.equal((await put("https://a-b.trycloudflare.com", ts)).status, 409, "重放");
	const other = generateKeyPairSync("ed25519");
	assert.equal((await put("https://evil.trycloudflare.com", ts + 1, other.privateKey, other.publicKey.export({ format: "jwk" }).x as string)).status, 403, "换公钥抢注");
	assert.equal((await put("https://evil.trycloudflare.com", ts + 2, other.privateKey)).status, 403, "签名不匹配");
	assert.equal((await put("https://c-d.trycloudflare.com", ts + 3)).status, 200);
});
