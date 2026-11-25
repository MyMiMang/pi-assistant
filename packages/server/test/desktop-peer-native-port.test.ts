import assert from "node:assert/strict";
import { test } from "node:test";
import { openNativeDesktopPeerPort } from "../../../apps/web/src/desktop-peer-port.ts";

test("正式 UI 适配器只调用具名原生命令，浏览器没有后备传输", async () => {
 assert.equal(await openNativeDesktopPeerPort(), undefined);
 const calls: unknown[] = [];
 const controller = new AbortController();
 Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: { async invoke(cmd: string, args: { request: { op: string } }) {
  assert.equal(cmd, "desktop_peer"); calls.push(args.request);
  if (args.request.op === "available") return true;
  if (args.request.op === "preview") return { id: "pending", origin: "https://fixture.test", serverId: "B", publicKey: "public" };
  if (args.request.op === "read") controller.abort();
 } } } });
 try {
  const port = await openNativeDesktopPeerPort();
  assert.ok(port?.invitation && port.forget);
  const preview = await port.invitation.preview({ invite: "synthetic" });
  await port.invitation.claim({ id: preview.id, name: "B" });
  const target = { peer: "device", agent: "same", conversation: "same" };
  await assert.rejects(port.read(target, controller.signal), { name: "AbortError" });
  await port.send(target,"synthetic","once");
  await port.forget({id:"device"});
  assert.deepEqual(calls,[{op:"available"},{op:"preview",invite:"synthetic"},{op:"claim",id:"pending",name:"B"},{op:"read",target},{op:"send",target,text:"synthetic",clientId:"once"},{op:"forget",id:"device"}]);
 } finally { Reflect.deleteProperty(globalThis,"window"); }
});
