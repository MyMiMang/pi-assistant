/**
 * 从消息另开会话分支（单聊）后端测试。
 *
 * 用**真实公开** Pi `createAgentSession` / `SessionManager`（不 mock SDK）+ Mock provider，
 * 临时数据目录（setup.ts）、内存凭据（不碰钥匙串）。见 docs/design/session-fork.md §8。
 * 要证：锚点映射可信、源会话文件不被改、新会话头 `parentSession` 指向源、分支是前缀、
 * 0 额外模型请求 / 0 工具调用、busy 时 409 不 abort、`clientId` 幂等只建 1 个对话、
 * 跨对话 / 非 user 锚点 fail-closed、新对话不复制旧用量、两个会话不共享可变状态。
 */
process.env.PIA_MOCK = "1";
import "./setup.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { config } from "../src/config.ts";
import { createConversation, getConversation } from "../src/conversations.ts";
import { db, now, setSetting } from "../src/db.ts";
import { ForkError, forkConversation } from "../src/fork.ts";
import { getMessage, insertMessage } from "../src/messages.ts";
import { initModels, models } from "../src/models.ts";
import { MOCK_MODEL, MOCK_PROVIDER, mockStats, registerMockProvider, resetMockStats } from "../src/pi-adapter/mock-provider.ts";
import { runtime } from "../src/runtime.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

await initModels(memoryCredentialStore());
// 显式注册 Mock provider（不依赖 PIA_MOCK 环境变量在 import 前置位，避免模块提升坑）
await registerMockProvider(models);
setSetting("defaultModel", { provider: MOCK_PROVIDER, id: MOCK_MODEL });

const AGENT = "fka";
db.prepare("INSERT INTO agents(id, name, avatar, color, created_at, model_provider, model_id, conversation_id) VALUES(?,?,?,?,?,?,?,?)").run(AGENT, "分支助理", "A", "#000", now(), MOCK_PROVIDER, MOCK_MODEL, null);

const waitFor = async (fn: () => boolean, ms = 15_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (fn()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return false;
};

const jsonl = (file: string) =>
	readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as { type: string; id?: string; parentId?: string | null; message?: { role?: string } });

test("从 user 消息另开分支：前缀正确、父关系、源不变、0 额外请求、幂等、拒绝跨范围", async () => {
	const conv = createConversation(AGENT, "源对话");
	// 两轮真实对话（Mock provider）：每条 user 消息都应拿到可信的 meta.piEntryId
	const u1 = insertMessage({ agentId: AGENT, conversationId: conv.id, role: "user", content: "你好，第一轮" });
	await runtime(AGENT, conv.id).send("你好，第一轮", undefined, { messageId: u1.id });
	await waitFor(() => !runtime(AGENT, conv.id).busy);
	const u2 = insertMessage({ agentId: AGENT, conversationId: conv.id, role: "user", content: "第二轮问题" });
	await runtime(AGENT, conv.id).send("第二轮问题", undefined, { messageId: u2.id });
	await waitFor(() => !runtime(AGENT, conv.id).busy);

	const m1 = getMessage(u1.id)!;
	const m2 = getMessage(u2.id)!;
	assert.equal(typeof m1.meta.piEntryId, "string", "第一条 user 消息拿到 Pi entry id");
	assert.equal(typeof m2.meta.piEntryId, "string", "第二条 user 消息拿到 Pi entry id");
	assert.notEqual(m1.meta.piEntryId, m2.meta.piEntryId);

	const srcFile = getConversation(conv.id)!.session_file!;
	assert.ok(srcFile && existsSync(srcFile));

	// 锚点：引用快照也要保（contextquotes）
	const quoted = insertMessage({
		agentId: AGENT, conversationId: conv.id, role: "user", content: "带引用的第三轮",
		replyToId: m2.id,
		replySnapshot: { messageId: m2.id, author: { id: "", name: "我", role: "user" }, source: { kind: "conversation", id: conv.id }, excerpt: "第二轮问题", truncated: false, edited: false, createdAt: now() },
	});
	await runtime(AGENT, conv.id).send("带引用的第三轮", undefined, { messageId: quoted.id });
	await waitFor(() => !runtime(AGENT, conv.id).busy);
	const statsBefore = mockStats.steps;
	// fork 前的源会话快照（上面三轮已全部落盘）
	const before = { size: statSync(srcFile).size, bytes: readFileSync(srcFile, "utf8"), ids: jsonl(srcFile).filter((e) => e.type !== "session").map((e) => e.id).filter(Boolean) as string[] };

	// ① 从第二条 user 消息另开（分支点 = 它之前的 assistant 消息）
	const r = forkConversation({ conversationId: conv.id, messageId: u2.id, clientId: "ck-1" });
	assert.equal(r.created, true);
	assert.equal(r.draft, "第二轮问题", "被分支消息正文放回输入框（不自动发送）");
	assert.equal(mockStats.steps, statsBefore, "fork 不产生任何模型请求");

	const newConv = getConversation(r.conversationId)!;
	assert.equal(newConv.agent_id, AGENT);
	const newFile = newConv.session_file!;
	assert.ok(newFile && existsSync(newFile));
	const entries = jsonl(newFile);
	assert.equal(entries[0].type, "session");
	assert.equal((entries[0] as { parentSession?: string }).parentSession, srcFile, "新会话头 parentSession 指向源会话");
	assert.equal(statSync(srcFile).size, before.size, "源会话文件字节数不变");
	assert.equal(readFileSync(srcFile, "utf8"), before.bytes, "源会话文件内容不变");

	// 分支 = 根到「第二条 user 消息的父 entry」这一条路径（即该消息之前的全部历史）：新会话里没有 u2
	const newMsgEntries = entries.filter((e) => e.type === "message");
	const newTexts = newMsgEntries.map((e) => JSON.stringify((e as { message?: unknown }).message ?? ""));
	assert.ok(!newTexts.some((t) => t.includes("第二轮问题")), "被分支的消息本身不在新会话历史里（另开并编辑语义）");
	assert.ok(newTexts.some((t) => t.includes("第一轮")), "分支保留了更早的历史");
	// 新会话的 entry 全部来自源会话，且严格短于源（是前缀而不是全量克隆）
	const newIds = entries.filter((e) => e.type !== "session").map((e) => e.id).filter(Boolean) as string[];
	assert.ok(newIds.every((id) => before.ids.includes(id)), "分支 entry 都是源会话已有的 entry");
	assert.ok(newIds.length < before.ids.length, "分支是源会话的严格前缀，不是全量克隆");
	assert.deepEqual(newIds, before.ids.slice(0, newIds.length), "分支与源会话顺序一致（前缀）");

	// 新对话的消息行：只读、去掉旧用量、带 forked 来源；不含被分支那条
	const rows = db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at").all(r.conversationId) as { content: string; meta: string; role: string }[];
	assert.ok(rows.length >= 2, "前缀投影出消息行");
	assert.ok(!rows.some((x) => x.content.includes("第二轮问题")), "被分支的消息不复制进新对话");
	for (const row of rows) {
		const meta = JSON.parse(row.meta) as { readonly?: boolean; forked?: unknown; usage?: unknown };
		assert.equal(meta.readonly, true, "旧上下文只读");
		assert.ok(meta.forked, "带 forked 来源 metadata");
		assert.equal(meta.usage, undefined, "不把旧对话的用量混进新对话");
	}

	// ② 幂等：同 clientId 再来一次 → 同一个对话、created=false、不再建文件
	const again = forkConversation({ conversationId: conv.id, messageId: u2.id, clientId: "ck-1" });
	assert.equal(again.created, false);
	assert.equal(again.conversationId, r.conversationId);

	// ③ 跨对话 / 非 user 锚点 fail-closed
	const other = createConversation(AGENT, "另一个对话", { makeCurrent: false });
	assert.throws(() => forkConversation({ conversationId: other.id, messageId: u2.id }), (e) => e instanceof ForkError && e.code === "fork_cross_scope" && e.status === 403);
	const assistantMsg = db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' LIMIT 1").get(conv.id) as { id: string };
	assert.throws(() => forkConversation({ conversationId: conv.id, messageId: assistantMsg.id }), (e) => e instanceof ForkError && e.code === "fork_anchor_not_supported");

	// ④ 新对话是独立的可变状态：自己的会话文件、自己的 AgentSession，且不额外调用模型
	const news = await runtime(AGENT, r.conversationId).ensure();
	const src = await runtime(AGENT, conv.id).ensure();
	assert.ok(news && src && news !== src, "两个对话是各自的 AgentSession，不共享可变状态");
	assert.notEqual(news!.sessionFile, src!.sessionFile);
	assert.equal((news!.model as { id?: string }).id, MOCK_MODEL, "继承原 agent 的模型选择");
	assert.equal(mockStats.steps, statsBefore, "建新会话 / fork 全程 0 额外模型请求");
});

test("源对话正在流式输出：fork 返回 409，不 abort 用户任务", async () => {
	const conv = createConversation(AGENT, "忙时分支");
	const u1 = insertMessage({ agentId: AGENT, conversationId: conv.id, role: "user", content: "先问一句" });
	await runtime(AGENT, conv.id).send("先问一句", undefined, { messageId: u1.id });
	await waitFor(() => !runtime(AGENT, conv.id).busy);

	// 起一个多步任务（Mock 的「慢慢数」会连着调工具），制造 streaming
	const u2 = insertMessage({ agentId: AGENT, conversationId: conv.id, role: "user", content: "慢慢数到 5" });
	void runtime(AGENT, conv.id).send("慢慢数到 5", undefined, { messageId: u2.id });
	assert.ok(await waitFor(() => runtime(AGENT, conv.id).busy, 10_000), "任务开始流式输出");

	resetMockStats();
	assert.throws(() => forkConversation({ conversationId: conv.id, messageId: u1.id }), (e) => e instanceof ForkError && e.code === "fork_busy" && e.status === 409);
	assert.equal(mockStats.steps, 0, "busy 时被拒的 fork 不发任何请求");
	assert.equal(runtime(AGENT, conv.id).busy, true, "用户任务没有被 abort");

	await runtime(AGENT, conv.id).abort();
	await waitFor(() => !runtime(AGENT, conv.id).busy);
});

test("锚点没有 piEntryId（Pi 会话文件被清理 / 消息没送达）：fail-closed 不静默从别的消息分支", () => {
	const conv = createConversation(AGENT, "无映射");
	const orphan = insertMessage({ agentId: AGENT, conversationId: conv.id, role: "user", content: "没送进 Pi" });
	assert.throws(() => forkConversation({ conversationId: conv.id, messageId: orphan.id }), (e) => e instanceof ForkError && e.code === "fork_anchor_unmapped");
	// 有映射但会话文件不存在 → fork_no_session（数据目录是临时的，路径一定不是真文件）
	db.prepare("UPDATE conversations SET session_file = ? WHERE id = ?").run(`${config.agentsDir}/fka/sessions/missing.jsonl`, conv.id);
	const withEntry = insertMessage({ agentId: AGENT, conversationId: conv.id, role: "user", content: "有 entry 但文件没了", meta: { piEntryId: "deadbeef" } });
	assert.throws(() => forkConversation({ conversationId: conv.id, messageId: withEntry.id }), (e) => e instanceof ForkError && e.code === "fork_no_session");
});

test("连发同文本的插话（都还没落盘）：每条 app 消息映射到自己的 Pi entry，不串（FIFO）", async () => {
	const conv = createConversation(AGENT, "同文本映射");
	// 「月度汇总」是多步任务：插话里再提一次会继续调用工具，保证两条插话都会在工具边界被送达
	const u1 = insertMessage({ agentId: AGENT, conversationId: conv.id, role: "user", content: "月度汇总" });
	void runtime(AGENT, conv.id).send("月度汇总", undefined, { messageId: u1.id });
	assert.ok(await waitFor(() => runtime(AGENT, conv.id).busy, 10_000), "任务开始流式输出");

	// 两条**同文本**插话，都在第一条落盘之前发出：两条 app 消息都还没 piEntryId
	const s1 = insertMessage({ agentId: AGENT, conversationId: conv.id, role: "user", content: "月度汇总" });
	void runtime(AGENT, conv.id).send("月度汇总", undefined, { messageId: s1.id });
	const s2 = insertMessage({ agentId: AGENT, conversationId: conv.id, role: "user", content: "月度汇总" });
	void runtime(AGENT, conv.id).send("月度汇总", undefined, { messageId: s2.id });

	assert.ok(await waitFor(() => !runtime(AGENT, conv.id).busy, 40_000), "任务结束");

	const e1 = getMessage(s1.id)!.meta.piEntryId as string | undefined;
	const e2 = getMessage(s2.id)!.meta.piEntryId as string | undefined;
	assert.equal(typeof e1, "string", "第一条插话拿到 piEntryId");
	assert.equal(typeof e2, "string", "第二条插话拿到 piEntryId");
	assert.notEqual(e1, e2, "两条同文本插话映射到不同的 Pi entry（不互相顶替）");

	// 映射顺序必须与发送顺序一致（同文本不能靠文本猜；这里用会话文件里的 entry 顺序验证）
	const file = getConversation(conv.id)!.session_file!;
	const ids = jsonl(file).map((x) => x.id).filter(Boolean) as string[];
	const i1 = ids.indexOf(e1!);
	const i2 = ids.indexOf(e2!);
	assert.ok(i1 >= 0 && i2 >= 0, "两个 entry 都在源会话文件里");
	assert.ok(i1 < i2, "先发的插话映射到更早的 Pi entry（顺序正确，没有对调）");
});
