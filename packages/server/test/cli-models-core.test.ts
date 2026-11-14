import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { isContextOverflow, normalizeContext, type Message, type Model, type Api } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { createCliChannel, type CliBackend, type CliLive, type LaunchRequest, type Step } from "../src/pi-adapter/cli-models/channel-core.ts";
import { EventQueue } from "../src/pi-adapter/cli-models/event-queue.ts";
import { makeSyncEntry, SyncStore } from "../src/pi-adapter/cli-models/sync-map.ts";

const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });
const model = { id: "fake", api: "fake", provider: "fake", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as unknown as Model<Api>;
function fixture(max?: number) {
 const requests: LaunchRequest[] = [];
 const store = new SyncStore(null);
 let steps: Step[] = [{ type: "finish", reason: "stop", sessionId: "saved" }];
 let launchError = false;
 const backend: CliBackend<CliLive> = {
  label: "fake", freshInputMaxChars: max, composite: () => "same",
  async launch(req) {
   requests.push(req);
   if (launchError && req.resumeSessionId) throw new Error("missing");
   const queue = new EventQueue<{ type: string }>();
   queue.push({ type: "event" });
   return { key: req.key, queue, dead: false, offs: [], pendingIds: new Set(), composite: req.composite };
  },
  async resume() {}, abort() {}, step: () => steps, isResumeFailure: (m) => m === "missing",
 };
 const channel = createCliChannel(backend, store);
 async function run(messages: Message[], tools = true) {
  const stream = channel.streamSimple(model, normalizeContext({ messages, tools: tools ? [{ name: "echo", description: "echo", parameters: { type: "object", properties: {} } }] : [] }), { sessionId: "key" });
  for await (const _ of stream) { /* drain */ }
  return stream.result();
 }
 return { requests, store, run, setSteps: (s: Step[]) => { steps = s; }, missing: () => { launchError = true; } };
}

test("fresh 超限先交 Pi 整理；公开转换的摘要允许淘汰历史；未超与 oneShot 正常", async () => {
 const f = fixture(200);
 const first = await f.run([user("旧".repeat(500)), user("当前")]);
 assert.equal(first.stopReason, "error");
 assert.match(first.errorMessage!, /context window exceeded/);
 assert.equal(isContextOverflow(first), true);
 assert.equal(f.requests.length, 0);
 const summary = convertToLlm([{ role: "compactionSummary", summary: "旧".repeat(500), tokensBefore: 1000, timestamp: 0 }])[0];
 // 摘要在历史中，最后一条助理消息将当前输入与历史分开。
 const reply = await fixture().run([user("种子")]);
 await f.run([summary, reply, user("当前")]);
 assert.match(JSON.stringify(f.requests[0].input), /更早的/);
 assert.match(JSON.stringify(f.requests[0].input), /当前/);
 const short = fixture(200);
 assert.equal((await short.run([user("短消息")])).stopReason, "stop");
 assert.equal(short.requests.length, 1);
 const one = fixture(200);
 await one.run([user("长".repeat(500))], false);
 assert.equal(one.requests.length, 1);
});

test("空内容 fail 保留对照记录，下次仍 resume 且只发新增消息", async () => {
 const f = fixture();
 const first = await f.run([user("第一轮")]);
 const messages = [user("第一轮"), first, user("第二轮")];
 f.setSteps([{ type: "fail", reason: "error", message: "暂时不可用" }]);
 const entry = f.store.get("key");
 await f.run(messages);
 assert.equal(f.store.get("key"), entry);
 await f.run(messages);
 assert.equal(f.requests.at(-1)!.resumeSessionId, "saved");
 assert.deepEqual(f.requests.at(-1)!.input, [{ type: "text", text: "第二轮" }]);
});

for (const mode of ["partial", "resumeFailed", "aborted"] as const) test(`${mode} fail 删除记录`, async () => {
 const f = fixture();
 const first = await f.run([user("第一轮")]);
 const messages = [user("第一轮"), first, user("第二轮")];
 const fail: Step = { type: "fail", reason: mode === "aborted" ? "aborted" : "error", message: "失败", resumeFailed: mode === "resumeFailed" };
 f.setSteps(mode === "partial" ? [{ type: "content", ev: { type: "text_delta", text: "部分" } }, fail] : [fail]);
 await f.run(messages);
 assert.equal(f.store.get("key"), undefined);
});

test("续用启动失败后的 fresh 同样先整理且不启动第二次", async () => {
 const f = fixture(200);
 const first = await fixture().run([user("旧".repeat(500))]);
 const messages = [user("旧".repeat(500)), first, user("当前")];
 f.store.set("key", makeSyncEntry("saved", "same", messages.slice(0, 1), first));
 f.missing();
 const result = await f.run(messages);
 assert.equal(isContextOverflow(result), true);
 assert.equal(f.requests.length, 1);
 const event = fixture(200);
 event.store.set("key", makeSyncEntry("saved", "same", messages.slice(0, 1), first));
 event.setSteps([{ type: "fail", reason: "error", message: "missing", resumeFailed: true }]);
 assert.equal(isContextOverflow(await event.run(messages)), true);
 assert.equal(event.requests.length, 1);
});
