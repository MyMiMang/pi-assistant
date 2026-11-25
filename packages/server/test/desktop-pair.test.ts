import "./setup.ts";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { once } from "node:events";
import { approveDevice, claimPairCode, createPairCode, deviceForToken, pairStatus, revokeDevice } from "../src/auth.ts";
import { db } from "../src/db.ts";
import { desktopPairStore } from "../src/desktop-pair.ts";
import { mountDesktopPairRoutes } from "../src/routes/desktop-pair.ts";
import type { Env } from "../src/routes/common.ts";

const target = { origin: "https://desktop-fixture.invalid", serverId: "fixture-server", publicKey: "fixture-key" };
const challenge = () => { const bytes = randomBytes(32); return { proof: bytes.toString("base64url"), commitment: createHash("sha256").update(bytes).digest("hex") }; };
function fixture(verified = true) {
 let now = 1700000000000;
 const store = desktopPairStore(db, () => now);
 const app = new Hono<Env>();
 app.use("*", (c, next) => { c.set("caller", { local: new URL(c.req.url).hostname === "localhost", deviceId: null, ip: "fixture" }); return next(); });
 mountDesktopPairRoutes(app, store, () => target, () => target.origin, request => verified && new URL(request.url).protocol === "https:" ? new URL(request.url).origin : undefined);
 const call = (op: string, data = {}, origin = target.origin) => app.request(`${origin}/api/desktop-pair/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
 const local = (op: string, data = {}) => call(op, data, "http://localhost");
 const begin = async () => {
  const invite = await (await local("invite")).json(), { proof, commitment } = challenge();
  const claim = { ...target, code: invite.code, commitment, name: "测试桌面", platform: "fixture" };
  const r = await call("claim", claim); assert.equal(r.status, 200);
  const { id, expires } = await r.json(); assert.equal(expires, invite.expires);
  return { invite, claim, id, proof, collect: () => call("collect", { ...target, id, proof }) };
 };
 return { app, call, local, begin, advance: (ms: number) => { now += ms; } };
}

test("独立桌面领取：绑定 HTTPS 与身份，明确批准，并发仅一次；撤销沿用设备机制", async () => {
 const f = fixture(), p = await f.begin();
 assert.equal((await f.call("claim", p.claim)).status, 403);
 assert.equal((await f.call("collect", { ...target, id: p.id, proof: p.proof }, "https://other-fixture.invalid")).status, 409);
 assert.equal((await f.call("collect", { ...target, serverId: "other", id: p.id, proof: p.proof })).status, 409);
 assert.equal((await f.call("collect", { ...target, id: p.id, proof: p.invite.code })).status, 403);
 assert.equal((await f.call("collect", { ...target, id: p.id, proof: challenge().proof })).status, 403);
 assert.deepEqual(await (await p.collect()).json(), { status: "pending" });
 assert.equal((await f.call("approve", { id: p.id })).status, 403);
 const review = (await (await f.local("pending")).json()).requests.find((r: { id: string }) => r.id === p.id);
 assert.equal(review.name, "测试桌面"); assert.equal(review.checkCode, p.claim.commitment.slice(0, 12));
 assert.deepEqual(await (await f.local("approve", { id: p.id })).json(), { ok: true });
 const both = await Promise.all([p.collect(), p.collect()]);
 assert.deepEqual(both.map(r => r.status).sort(), [200, 403]);
 const issued = both.find(r => r.ok)!; assert.equal(issued.headers.get("cache-control"), "no-store");
 const { deviceId, token } = await issued.json();
 assert.equal(deviceForToken(token), null, "未确认收到的凭据不允许访问");
 assert.equal((await f.call("confirm", { ...target, id: p.id, receipt: token })).status, 200);
 assert.equal(deviceForToken(token), deviceId);
 revokeDevice(deviceId); assert.equal(deviceForToken(token), null);
 assert.equal((await p.collect()).status, 403);
});

test("真实 Node HTTP 入口不会把明文回环识别为桌面 HTTPS", async () => {
 const f = fixture(false);
 const server = serve({ fetch: f.app.fetch, hostname: "127.0.0.1", port: 0 });
 try {
  if (!server.listening) await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/desktop-pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(challenge()) });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "desktop_https_entry_required" });
 } finally { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); }
});

test("取消、过期、结果丢失不留下有效授权；原手机正常流程不变", async () => {
 const f = fixture(), cancelled = await f.begin();
 await f.local("approve", { id: cancelled.id }); await f.local("cancel", { id: cancelled.id });
 assert.equal((await cancelled.collect()).status, 403);
 const lost = await f.begin(); await f.local("approve", { id: lost.id });
 const { token } = await (await lost.collect()).json();
 assert.equal(deviceForToken(token), null); assert.equal((await lost.collect()).status, 403);
 const expired = await f.begin(); await f.local("approve", { id: expired.id }); f.advance(300_000);
 assert.equal((await expired.collect()).status, 403);
 assert.equal((await f.call("confirm", { ...target, id: lost.id, receipt: token })).status, 403);
 const { code } = createPairCode(); const phone = claimPairCode(code, "合成手机", "fixture");
 assert.ok(phone.ok); assert.equal(pairStatus(phone.deviceId).status, "pending"); assert.ok(approveDevice(phone.deviceId));
 const result = pairStatus(phone.deviceId); assert.equal(deviceForToken(result.token), phone.deviceId);
 assert.equal(pairStatus(phone.deviceId).token, undefined); revokeDevice(phone.deviceId);
});
