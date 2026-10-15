/**
 * 审计补充测试（只测记忆作用域，不改业务代码）：
 *   Hindsight 记忆库（bank / namespace）的共享与隔离矩阵。
 *
 * 覆盖：
 *   1. scope=user  → bank `user`，所有助理共享；
 *   2. scope=agent → bank `agent_<id>`，只有该助理看得到，别的助理看不到；
 *   3. scope=conversation → 条目落在 `agent_<id>` 库里，按 conversationId 过滤，别的对话看不到；
 *   4. 主会话与子代理用同一个 (agentId, conversationId)（见 runtime.ts extensionsFor）→
 *      同一批库、互相可见（这就是“子代理共享记忆”的机制证据）。
 *
 * 只连本机假 Hindsight（e2e/fixtures/fake-hindsight.mjs，远程模式），不碰真实 Hindsight、
 * 不读真实记忆、不用系统钥匙串（注入内存 CredentialStore）。
 */
process.env.PIA_MOCK = "1";
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
const { memoryCredentialStore } = await import("./in-memory-credentials.ts");
const { db, setSetting } = await import("../src/db.ts");
const modelsMod = await import("../src/models.ts");
await modelsMod.initModels(memoryCredentialStore());
const { sidecar } = await import("../src/memory/hindsight/sidecar.ts");
const { flush, pendingCount } = await import("../src/memory/hindsight/provider.ts");
const settings = await import("../src/memory/hindsight/settings.ts");
const { memory } = await import("../src/memory/index.ts");
// @ts-expect-error 测试夹具是 .mjs
const { fakeHindsight } = await import("../../../e2e/fixtures/fake-hindsight.mjs");

const A = "scope_a";
const B = "scope_b";
const convA1 = "conv_a1";
const convA2 = "conv_a2";
for (const id of [A, B])
	db.prepare("INSERT OR IGNORE INTO agents(id, name, avatar, color, persona, created_at, memory_provider) VALUES(?,?,?,?,?,?,?)").run(id, id, "🧪", "#888", "", Date.now(), null);
setSetting("memoryProvider", "hindsight");

test("Hindsight bank 作用域：user 共享 / agent 隔离 / conversation 按对话过滤 / 子代理共享", async () => {
	const fake = fakeHindsight("rk");
	const port = await fake.start();
	settings.saveHindsightSettings({ mode: "remote", remoteUrl: `http://127.0.0.1:${port}`, remoteKey: "rk" });
	try {
		await sidecar.restart();
		assert.equal(sidecar.status.state, "ready", sidecar.status.detail);

		// 1) user 作用域：写进 `user` 库
		const u = await memory.remember(A, null, { content: "用户叫邓邓", kind: "fact", scope: "user" });
		assert.equal(u.bank, "user");
		// 2) agent 作用域：写进 `agent_A`
		const ga = await memory.remember(A, null, { content: "甲助理知道的口令是甲", kind: "fact", scope: "agent" });
		assert.equal(ga.bank, `agent_${A}`);
		// 3) conversation 作用域：仍落在 agent_A 库，带 conversationId
		const c1 = await memory.remember(A, convA1, { content: "甲助理在对话一里说的话", kind: "note", scope: "conversation" });
		assert.equal(c1.bank, `agent_${A}`);
		await flush();
		assert.equal(pendingCount(), 0, "队列应已清空");

		// 假 Hindsight 里只应出现 user 与 agent_A 两个库，不该有 agent_B
		const banks = [...fake.banks.keys()].sort();
		assert.deepEqual(banks, ["agent_scope_a", "user"], `实际 bank：${banks.join(",")}`);

		// 共享：B 也能读到 user 库（所有助理共享）
		const bUser = await memory.recall(B, null, "邓邓", 8);
		assert.ok(bUser.some((x) => x.text.includes("邓邓")), "user 库应被所有助理共享");
		// 隔离：B 读不到 A 的 agent 作用域记忆
		const bAgent = await memory.recall(B, null, "口令", 8);
		assert.ok(!bAgent.some((x) => x.text.includes("甲")), "agent 库不应跨助理可见");

		// conversation 过滤：A 在 convA1 能看到，在 convA2 看不到
		const inA1 = await memory.recall(A, convA1, "对话一", 8);
		assert.ok(inA1.some((x) => x.text.includes("对话一")), "本对话的 conversation 记忆应可见");
		const inA2 = await memory.recall(A, convA2, "对话一", 8);
		assert.ok(!inA2.some((x) => x.text.includes("对话一")), "别的对话不应看到 conversation 记忆");

		// 子代理共享：子代理用同一个 (agentId=A, conversationId=convA1)（runtime.ts extensionsFor），
		// 因此它看到的东西和主会话完全一致——这里直接以同一参数调用即代表子代理视角。
		const subAgentView = await memory.recall(A, convA1, "口令", 8);
		assert.ok(subAgentView.some((x) => x.text.includes("甲")), "子代理与主会话共享 agent 库");
		const subConvView = await memory.recall(A, convA1, "对话一", 8);
		assert.ok(subConvView.some((x) => x.text.includes("对话一")), "子代理与主会话共享同一对话的 conversation 记忆");

		// 假 Hindsight 确实收到过 retain（写入）请求，证明走的是 Hindsight 而不是仅本地账本
		assert.ok(fake.calls.some((c: string) => c.endsWith("/memories") && c.startsWith("POST")), `fake 收到：${fake.calls.join(" | ")}`);
	} finally {
		await sidecar.stop();
		await fake.stop();
	}
});
