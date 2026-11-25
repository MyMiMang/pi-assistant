import assert from "node:assert/strict";
import { test } from "node:test";
import { createDesktopPeerSession, type PeerMessage } from "../../../apps/web/src/desktop-peer-session.ts";

const a = { peer: "A", agent: "same", conversation: "same" };
const b = { ...a, peer: "B" };
function deferred<T>() {
 let resolve!: (value: T) => void;
 const promise = new Promise<T>(done => { resolve = done; });
 return { promise, resolve };
}
test("同 ID 草稿互相隔离，迟到响应不进入切回的会话", async () => {
 const late = deferred<PeerMessage[]>();
 const session = createDesktopPeerSession({ read: p => p.peer === "B" ? late.promise : Promise.resolve([]), async send() {} });
 session.setConnection("A", "online"); session.setConnection("B", "online");
 session.select(a); session.setDraft("本机草稿");
 session.select(b); session.setDraft("远端草稿");
 const pending = session.refresh(() => assert.fail("迟到 B 不应进入 A"));
 session.select(a);
 late.resolve([{ id: "synthetic", role: "assistant", content: "B" }]); await pending;
 assert.equal(session.draft(), "本机草稿");
 session.select(b); assert.equal(session.draft(), "远端草稿");
});

test("断线禁发、重连不重发、撤销不复活；已发任务不因切换中止", async () => {
 const accepted = deferred<void>();
 const calls: unknown[] = [];
 const session = createDesktopPeerSession({ async read() { return []; }, send(target, text, id) { calls.push([target, text, id]); return accepted.promise; } });
 session.select(b); session.setDraft("远端任务");
 assert.equal(await session.send(() => "never"), false);
 session.setConnection("B", "online"); assert.equal(calls.length, 0);
 const sending = session.send(() => "message-one");
 session.setConnection("B", "offline"); assert.equal(await session.send(() => "never"), false);
 assert.equal(session.draft(), "远端任务");
 session.select(a); session.setDraft("本机草稿"); accepted.resolve(); assert.equal(await sending, true);
 assert.equal(session.draft(), "本机草稿");
 session.setConnection("B", "online"); assert.deepEqual(calls, [[b, "远端任务", "message-one"]]);
 session.setConnection("B", "revoked"); session.setConnection("B", "online"); session.select(b);
 assert.equal(session.draft(), ""); session.setDraft("不能保存"); assert.equal(await session.send(() => "never"), false);
});
