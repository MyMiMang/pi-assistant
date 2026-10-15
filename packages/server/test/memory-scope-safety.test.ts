/**
 * 记忆作用域安全（memory-scope-safety）测试：
 *   provenance + 写入分层 + task 草稿隔离 + 主会话晋升去重 + 归属删除 + 工具 annotation。
 *
 * 隔离：假 Hindsight（e2e/fixtures/fake-hindsight.mjs）+ 临时 PIA_DATA_DIR/PIA_WORKSPACE（setup.ts）
 * + 内存 CredentialStore（绝不碰真实 Hindsight / 钥匙串 / 真实数据目录）。
 */
process.env.PIA_MOCK = "1";
process.env.PIA_MEMORY_TIMEOUT_MS = "5000";
await import("./setup.ts");
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
const { memoryCredentialStore } = await import("./in-memory-credentials.ts");
const { db, setSetting } = await import("../src/db.ts");
const modelsMod = await import("../src/models.ts");
await modelsMod.initModels(memoryCredentialStore());
const { sidecar } = await import("../src/memory/hindsight/sidecar.ts");
const { flush, pendingCount, hindsightMemory } = await import("../src/memory/hindsight/provider.ts");
const settings = await import("../src/memory/hindsight/settings.ts");
const { memory, agentBank, USER_BANK } = await import("../src/memory/index.ts");
const { basicMemory } = await import("../src/memory/basic.ts");
const { memoryExtension } = await import("@pi-assistant/ext-memory");
const { evaluate } = await import("@pi-assistant/ext-approval");
// @ts-expect-error 测试夹具是 .mjs
const { fakeHindsight } = await import("../../../e2e/fixtures/fake-hindsight.mjs");

const DAY = 86_400_000;
const insertAgent = (id: string) =>
	db.prepare("INSERT OR IGNORE INTO agents(id, name, avatar, color, persona, created_at, memory_provider) VALUES(?,?,?,?,?,?,?)").run(id, id, "🧪", "#888", "", Date.now(), null);
setSetting("memoryProvider", "hindsight");

let fake: ReturnType<typeof fakeHindsight>;
before(async () => {
	fake = fakeHindsight("rk");
	const port = await fake.start();
	settings.saveHindsightSettings({ mode: "remote", remoteUrl: `http://127.0.0.1:${port}`, remoteKey: "rk" });
	await sidecar.restart();
	assert.equal(sidecar.status.state, "ready", sidecar.status.detail);
});
after(async () => {
	await sidecar.stop();
	await fake.stop();
});

test("写入分层：主/用户写 user(verified)，子代理/后台写 task 草稿（不落共享 user 库）", async () => {
	const A = "sa_scope";
	insertAgent(A);
	const main = await memory.remember(A, "conv1", { content: "用户叫灯灯大王", kind: "fact", actor: "main" });
	assert.equal(main.bank, USER_BANK);
	assert.equal(main.status, "verified");

	const child = await memory.remember(A, "conv1", { content: "子代理推测用户喜欢早起", kind: "fact", actor: "subagent", taskId: "t1", subagentId: "t1" });
	assert.equal(child.scope, "task");
	assert.equal(child.status, "draft");
	assert.notEqual(child.bank, USER_BANK, "子代理的 fact 不能进共享 user 库");

	const child2 = await memory.remember(A, "conv1", { content: "另一个子代理的临时推断", kind: "fact", actor: "subagent", taskId: "t2", subagentId: "t2" });
	// 工具/调用方伪造 status 不生效（status 由服务端按 actor 决定）
	const forged = await memory.remember(A, "conv1", { content: "伪造的已验证条目", kind: "fact", actor: "subagent", taskId: "t3", subagentId: "t3", status: "verified" } as never);
	assert.equal(forged.status, "draft");
	assert.notEqual(forged.bank, USER_BANK);
	// 后台来源同样不能写共享 user
	const bg = await memory.remember(A, "conv1", { content: "后台任务的结论", kind: "log", actor: "background", taskId: "bg1" });
	assert.notEqual(bg.bank, USER_BANK);
	assert.equal(bg.status, "draft");

	await flush();
	assert.equal(pendingCount(), 0, "队列应清空");
	assert.ok(fake.banks.has(USER_BANK), "user 库存在");
	assert.ok(fake.banks.has(agentBank(A)), "agent 库存在");

	const subView = await memory.recall(A, "conv1", "早起", 8, { taskId: "t1", parent: false });
	assert.ok(subView.some((i) => i.id === child.id), "子代理能读自己的 task 草稿");
	assert.ok(!subView.some((i) => i.id === child2.id), "子代理读不到兄弟草稿");
	const subList = await memory.list(A, "conv1", undefined, { taskId: "t1", parent: false });
	assert.ok(!subList.some((i) => i.id === child2.id), "list 也隔离兄弟草稿");
	const parentList = await memory.list(A, "conv1", undefined, { parent: true });
	assert.ok(parentList.some((i) => i.id === child.id) && parentList.some((i) => i.id === child2.id), "父视角能读全部草稿");
	// 另一助理读不到本助理的草稿，但能读到共享 user
	const B = "sa_other";
	insertAgent(B);
	const bList = await memory.list(B, "convB", undefined, { parent: true });
	assert.ok(!bList.some((i) => i.bank === agentBank(A)), "跨助理 agent 库隔离");
	const bRecall = await memory.recall(B, "convB", "灯灯大王", 8, { parent: true });
	assert.ok(bRecall.some((i) => i.bank === USER_BANK && i.text.includes("灯灯"), "user 库共享"));
});

test("主会话晋升：写 provenance、可幂等、命中去重不新增不覆盖", async () => {
	const A = "sa_promote";
	insertAgent(A);
	const draft = await memory.remember(A, "convP", { content: "用户喜欢深烘咖啡", kind: "fact", actor: "subagent", taskId: "p1", subagentId: "p1" });
	const r1 = await memory.promote(A, draft.id, { scope: "user", actor: "main", conversationId: "convP" });
	assert.equal(r1.promoted, true);
	assert.equal(r1.deduped, false);

	const parentAll = await memory.list(A, undefined, undefined, { parent: true });
	const promoted = parentAll.find((i) => i.id === r1.id)!;
	assert.equal(promoted.bank, USER_BANK);
	assert.equal(promoted.status, "verified");
	assert.equal(promoted.origin?.source, "promotion");
	assert.equal(promoted.origin?.evidenceRef, draft.id, "晋升保存来源证据（安全 id）");
	// 草稿本身标记为 promoted，不再作为草稿/列表项出现
	assert.ok(!parentAll.some((i) => i.id === draft.id), "已晋升草稿不再出现在列表");
	assert.ok(!(await memory.listDrafts(A)).some((i) => i.id === draft.id), "已晋升草稿不再待核验");

	// 幂等：再晋升同一草稿，不新增
	const r2 = await memory.promote(A, draft.id, { scope: "user", actor: "main" });
	assert.equal(r2.id, r1.id);
	assert.equal(r2.promoted, false);
	assert.equal(r2.deduped, true);

	// 去重：同文本再写一条草稿并晋升 → 命中已有，不新增、不覆盖
	const beforeCount = (await memory.list(A, undefined, undefined, { parent: true })).filter((i) => i.status !== "draft" && i.bank === USER_BANK).length;
	const draft2 = await memory.remember(A, "convP", { content: "用户喜欢深烘咖啡", kind: "fact", actor: "background", taskId: "p2" });
	const r3 = await memory.promote(A, draft2.id, { scope: "user", actor: "main" });
	assert.equal(r3.deduped, true);
	assert.equal(r3.id, r1.id, "命中已有事实");
	const afterCount = (await memory.list(A, undefined, undefined, { parent: true })).filter((i) => i.status !== "draft" && i.bank === USER_BANK).length;
	assert.equal(afterCount, beforeCount, "不重复写入");
});

test("晋升去重只对已确认条目：同文本的两个草稿不会互相吞掉，合并保留全部证据", async () => {
	const A = "sa_dedup2";
	insertAgent(A);
	const d1 = await memory.remember(A, "convD", { content: "用户喜欢 Espresso", kind: "fact", actor: "subagent", taskId: "d1", subagentId: "d1" });
	const d2 = await memory.remember(A, "convD", { content: "用户喜欢 espresso", kind: "fact", actor: "subagent", taskId: "d2", subagentId: "d2" });
	assert.notEqual(d1.id, d2.id, "字面不同的两条草稿是两条账本条目");
	// 晋升 d2 时 d1 仍是草稿：不能把 d2 合并进 d1（否则 d1 还在待核验、d2 内容丢失）
	const r2 = await memory.promote(A, d2.id, { scope: "agent", actor: "main" });
	assert.equal(r2.promoted, true, "没有已确认同文本条目时应新建，而不是并入另一个草稿");
	assert.notEqual(r2.id, d1.id);
	const promotedItem = (await memory.list(A, undefined, undefined, { parent: true })).find((i) => i.id === r2.id);
	assert.ok(promotedItem && promotedItem.status === "verified" && promotedItem.scope === "agent", "agent 级晋升原地转正且可见（不被账本去重吞掉）");
	assert.ok((await memory.listDrafts(A)).some((i) => i.id === d1.id), "另一个草稿仍待核验");
	// 再晋升 d1：此时已有 verified 同文本条目 → 合并，证据累积、不覆盖正文
	const r1 = await memory.promote(A, d1.id, { scope: "agent", actor: "main" });
	assert.equal(r1.deduped, true);
	assert.equal(r1.id, r2.id);
	const item = (await memory.list(A, undefined, undefined, { parent: true })).find((i) => i.id === r2.id)!;
	const refs = new Set([...(item.origin?.evidenceRefs ?? []), item.origin?.evidenceRef].filter(Boolean));
	assert.ok(refs.has(d2.id) && refs.has(d1.id), "两条草稿的证据都保留");
});

test("归属删除：子代理不能删共享/他人条目（含完全权限档位语义），只能删自己的草稿", async () => {
	const A = "sa_forget";
	insertAgent(A);
	const shared = await memory.remember(A, "convF", { content: "共享的用户事实", kind: "fact", actor: "main" });
	const draft = await memory.remember(A, "convF", { content: "子代理自己的草稿", kind: "fact", actor: "subagent", taskId: "f1", subagentId: "f1" });
	const other = await memory.remember(A, "convF", { content: "另一个子代理的草稿", kind: "fact", actor: "subagent", taskId: "f2", subagentId: "f2" });
	// 完全权限档位也不改变服务端语义：子代理删共享 user 仍被拒
	await assert.rejects(() => memory.forget(A, shared.id, { actor: "subagent", taskId: "f1", subagentId: "f1" }), /主会话或用户/);
	// 删自己的草稿可以
	assert.equal(await memory.forget(A, draft.id, { actor: "subagent", taskId: "f1", subagentId: "f1" }), true);
	// 删兄弟草稿：子代理看不到 → false（不会误删）
	assert.equal(await memory.forget(A, other.id, { actor: "subagent", taskId: "f1", subagentId: "f1" }), false);
	// 主会话可以删共享条目
	assert.equal(await memory.forget(A, shared.id, { actor: "main" }), true);
});

test("旧记忆 legacy 保留可读、TTL 到期隐藏、task 草稿有默认 TTL", async () => {
	const A = "sa_legacy";
	insertAgent(A);
	// 模拟旧版本写入（无 origin）：直接落账本
	const legacy = await basicMemory.remember(agentBank(A), { content: "旧版本写下的记忆", meta: { kind: "fact" } });
	const legacyId = legacy.ids![0];
	const past = await basicMemory.remember(agentBank(A), { content: "已过期的便签", meta: { kind: "note", expiresAt: Date.now() - 1000, origin: { actor: "user", assistantId: A, createdAt: new Date().toISOString(), status: "verified" } } });

	const parentAll = await memory.list(A, undefined, undefined, { parent: true });
	const legacyItem = parentAll.find((i) => i.id === legacyId)!;
	assert.equal(legacyItem.status, "legacy", "旧记忆标 legacy");
	assert.equal(legacyItem.scope, "agent");
	assert.ok(!parentAll.some((i) => i.id === past.ids![0]), "过期记忆不显示");
	// 子代理视角也能读到 legacy（保持原 scope 读可见）
	const subList = await memory.list(A, "convL", undefined, { taskId: "l1", parent: false });
	assert.ok(subList.some((i) => i.id === legacyId), "legacy 保持原作用域可读");

	// task 草稿默认 TTL 约 7 天
	const draft = await memory.remember(A, "convL", { content: "任务草稿有 TTL", kind: "fact", actor: "subagent", taskId: "l1", subagentId: "l1" });
	const item = (await memory.list(A, "convL", undefined, { parent: true })).find((i) => i.id === draft.id)!;
	assert.ok(item.expiresAt && item.expiresAt > Date.now() + 6 * DAY, "task 草稿默认 7 天 TTL");
});

test("reflect 源端隔离：子代理 reflect 请求按 provenance tag 过滤，兄弟 task 草稿不进入服务端上下文（不只是下游删输出）", async () => {
	const A = "sa_reflect";
	insertAgent(A);
	await memory.remember(A, "convR", { content: "本任务草稿：用户提到想去看海", kind: "fact", actor: "subagent", taskId: "r1", subagentId: "r1" });
	await memory.remember(A, "convR", { content: "兄弟草稿机密：用户的私钥线索甲乙丙", kind: "fact", actor: "subagent", taskId: "r2", subagentId: "r2" });
	await memory.remember(A, "convR", { content: "已核验的助理级事实：用户喜欢海边", kind: "fact", actor: "main", scope: "agent" });
	await flush();
	assert.equal(pendingCount(), 0, "队列应清空");

	const agentBankId = agentBank(A);
	const reflectCount = () => fake.reflects.filter((x: { bank: string }) => x.bank === agentBankId).length;
	const before = reflectCount();
	const r = await memory.reflect(A, "用户喜欢什么", { actor: "subagent", conversationId: "convR", taskId: "r1" });
	const reqs = fake.reflects.filter((x: { bank: string }) => x.bank === agentBankId);
	assert.equal(reqs.length, before + 1, "agent 库应收到一次 reflect 请求");
	const req = reqs[reqs.length - 1];
	// 请求在发出时就限定范围（源端过滤），不是空过滤
	assert.ok(Array.isArray(req.body.tag_groups) && req.body.tag_groups.length, "子代理 reflect 必须带服务端 tag_groups 过滤");
	const filter = JSON.stringify(req.body.tag_groups);
	assert.ok(filter.includes("task:r1"), "过滤允许本任务草稿");
	assert.ok(!filter.includes("task:r2"), "过滤不允许兄弟任务");
	assert.ok(filter.includes("status:verified"), "过滤允许已核验事实");
	// 服务端（fake）按过滤命中：真正送给模型的依据里根本没有兄弟草稿
	assert.ok(!req.hits.some((h: { text: string }) => h.text.includes("私钥线索")), "兄弟草稿不进入 reflect 上下文");
	assert.ok(!JSON.stringify(req.body).includes("私钥线索"), "reflect 请求正文不含兄弟草稿正文");
	assert.ok(req.hits.some((h: { text: string }) => h.text.includes("想去看海")), "本任务草稿可见");
	assert.ok(req.hits.some((h: { text: string }) => h.text.includes("喜欢海边")), "已核验助理级事实可见");
	assert.ok(r && !r.answer.includes("私钥线索"), "答案不含兄弟草稿");

	// 主会话核验视角：不限制（可读本助理下全部草稿），但落到的库仍是 agent 库
	const beforeParent = reflectCount();
	await memory.reflect(A, "用户喜欢什么", { actor: "main", conversationId: "convR", parent: true });
	const parentReq = fake.reflects.filter((x: { bank: string }) => x.bank === agentBankId).slice(-1)[0];
	assert.equal(reflectCount(), beforeParent + 1);
	assert.ok(!parentReq.body.tag_groups, "主会话核验视角不做 tag 限制");
});

test("reflect fail closed + 跨助理隔离：未限定作用域直接拒绝；别的助理的草稿不进入本助理 reflect", async () => {
	const A = "sa_refl_a";
	const B = "sa_refl_b";
	insertAgent(A);
	insertAgent(B);
	await memory.remember(B, "convB", { content: "B助理草稿：用户的备用邮箱是 b@example.com", kind: "fact", actor: "subagent", taskId: "b1", subagentId: "b1" });
	await flush();
	// fail closed：provider 没拿到显式作用域就不反思（不把整库送回模型）
	await assert.rejects(() => (hindsightMemory.reflect as (b: string, q: string, s?: unknown) => Promise<unknown>)(agentBank(A), "邮箱", undefined), /未限定作用域/);
	// 跨助理：A 的 reflect 只落到 A 自己的库，B 的草稿不在 A 的上下文里
	await memory.reflect(A, "邮箱", { actor: "subagent", conversationId: "convA", taskId: "a1" });
	const aReq = fake.reflects.filter((x: { bank: string }) => x.bank === agentBank(A)).slice(-1)[0];
	assert.ok(aReq, "A 的 agent 库收到 reflect");
	assert.ok(!JSON.stringify(aReq.hits).includes("备用邮箱"), "B 的草稿不在 A 的 reflect 上下文");
});

test("工具 annotation：recall/reflect 只读不误拦；remember 真实写入但不弹；forget 破坏性、完全权限仍放行", () => {
	const tools: { name: string; annotations?: Record<string, unknown> }[] = [];
	const pi = { on: () => {}, registerTool: (t: never) => tools.push(t) } as never;
	const host = {
		context: async () => "",
		remember: async () => ({ id: "x", status: "draft" }),
		recall: async () => [],
		forget: async () => true,
		reflect: async () => ({ answer: "" }),
		review: { list: async () => [], promote: async () => ({ id: "x", promoted: true, deduped: false }), reject: async () => true },
	};
	memoryExtension(host as never)(pi);
	const ann = (n: string) => tools.find((t) => t.name === n)?.annotations;
	assert.ok(tools.some((t) => t.name === "memory_review"), "主会话注入 memory_review");
	const ws = "/tmp/ws";
	assert.equal(evaluate("memory_recall", {}, ann("memory_recall"), ws, false).kind, "allow");
	assert.equal(evaluate("memory_reflect", {}, ann("memory_reflect"), ws, false).kind, "allow");
	assert.equal(evaluate("memory_remember", {}, ann("memory_remember"), ws, false).kind, "allow", "真实写入但不弹审批（不把每条记忆都弹）");
	assert.equal(evaluate("memory_forget", {}, ann("memory_forget"), ws, false).kind, "ask", "破坏性操作按档位审批");
	assert.equal(evaluate("memory_forget", {}, ann("memory_forget"), ws, true).kind, "allow", "完全权限仍免审批");
});
