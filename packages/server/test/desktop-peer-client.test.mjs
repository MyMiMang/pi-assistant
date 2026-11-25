import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createDesktopPeerClient } from "../src/desktop-peer-client.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const peer = { origin: "https://peer.fixture.test", serverId: "fixture", publicKey: publicKey.export({ format: "jwk" }).x, code: "abcdefghijklmnop", expires: Date.now() + 60_000 };
const credential = `hh_${"B".repeat(43)}`;
function fixture(mismatch = false) {
 const calls = [];
 const run = createDesktopPeerClient(async (raw, options) => {
  const url = new URL(raw); calls.push({ url, options });
  assert.equal(url.origin, peer.origin); assert.equal(options.redirect, "error");
  if (url.pathname.endsWith("/identity")) {
   assert.equal(options.headers.authorization, undefined);
   const message = JSON.stringify(["pia-desktop-edge-v1", peer.origin, peer.serverId, peer.publicKey, mismatch ? "wrong" : url.searchParams.get("nonce")]);
   return Response.json({ origin: peer.origin, serverId: peer.serverId, publicKey: peer.publicKey, signature: sign(null, Buffer.from(message), privateKey).toString("base64url") });
  }
  if (url.pathname.endsWith("/claim")) return Response.json({ id: "claim_fixture" });
  if (url.pathname.endsWith("/messages")) return Response.json({ id: "msg", agent_id: "same", conversation_id: "chat", role: "user" });
  return Response.json({}, { status: 401 });
 });
 return { run, calls };
}

test("生产客户端验证签名和目标之后，才具名绑定会话发送", async () => {
 const { run, calls } = fixture();
 assert.equal((await run({op:"preview",invite:JSON.stringify(peer)})).origin, peer.origin);
 assert.equal((await run({op:"claim",peer,name:"Fixture"})).checkCode.length, 12);
 assert.equal(calls[2].options.headers.authorization, undefined);
 assert.deepEqual(await run({ op:"send", peer:{...peer,token:credential}, agent:"same",conversation:"chat",text:"synthetic",clientId:"id" }), { id: "msg", agent: "same", conversation: "chat" });
 const sent = calls.at(-1);
 assert.equal(sent.url.pathname, "/api/agents/same/messages");
 assert.deepEqual(JSON.parse(sent.options.body), {conversationId:"chat",text:"synthetic",clientId:"id"});
 assert.equal(sent.options.headers.authorization, `Bearer ${credential}`);
 await assert.rejects(run({op:"status",peer:{...peer,token:credential}}), /revoked/);
});

test("错误签名无授权请求；捆绑进程对坏输入不吐回原文", async () => {
 const { run, calls } = fixture(true);
 await assert.rejects(run({op:"send",peer:{...peer,token:credential},agent:"same",conversation:"chat"}), /identity_mismatch/);
 assert.equal(calls.length, 1);
 const script = fileURLToPath(new URL("../src/desktop-peer-client.mjs",import.meta.url));
 const out = spawnSync(process.execPath, [script], { env: {}, encoding: "utf8", input: '{"op":"preview","invite":"not-valid"}\n', timeout: 3000 });
 assert.equal(out.status, 0); assert.equal(out.stderr, "");
 assert.deepEqual(JSON.parse(out.stdout), {error:"peer_request_failed"});
});
