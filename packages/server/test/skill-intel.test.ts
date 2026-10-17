import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../src/db.ts";

const si = await import("../src/skill-intel.ts");
const { getSkill } = await import("../src/skills.ts");
const reset = () => db.exec("DELETE FROM skill_suggestions; DELETE FROM task_patterns;");

test("技能版本：保存记版本、diff、回滚", () => {
	const a = si.saveSkillVersioned({ name: "csv-merge", description: "合并多个 CSV 表格。用户说“合并表格”时使用。", body: "1. 读取\n2. 合并" }, "user");
	assert.equal(a.version, 1);
	const b = si.saveSkillVersioned({ name: "csv-merge", description: a.description, body: "1. 读取\n2. 去重\n3. 合并" }, "agent");
	assert.equal(b.version, 2);
	// 内容不变不记新版本
	assert.equal(si.saveSkillVersioned({ name: "csv-merge", description: a.description, body: "1. 读取\n2. 去重\n3. 合并" }, "user").version, 2);
	const vs = si.listVersions("csv-merge");
	assert.deepEqual(vs.map((v) => v.version), [2, 1]);
	const d = si.skillDiff("csv-merge", vs[1], vs[0]);
	assert.match(d, /^\+2\. 去重$/m);
	const r = si.rollbackSkill("csv-merge", 1);
	assert.equal(r.version, 3);
	assert.equal(getSkill("csv-merge")!.body.trim(), "1. 读取\n2. 合并");
	assert.equal(si.listVersions("csv-merge")[0].source, "rollback");
});

test("相似技能检索（中文）与查重阈值", () => {
	si.saveSkillVersioned({ name: "weekly-sales", description: "汇总每周销售数据并画图。用户说“周销售汇总”时使用。", body: "1. 读表\n2. 汇总" }, "user");
	const hits = si.searchSkills("帮我做一下每周的销售数据汇总");
	assert.equal(hits[0].name, "weekly-sales");
	assert.ok(hits[0].score >= si.DUP_THRESHOLD, `score ${hits[0].score}`);
	assert.ok(!si.searchSkills("给猫咪起个名字").some((h) => h.name === "weekly-sales" && h.score >= si.DUP_THRESHOLD));
});

const turn = (o: Partial<Parameters<typeof si.observeTurn>[0]>) => si.observeTurn({ agentId: "a", conversationId: "c1", userText: "", tools: [], usedSkills: [], ...o });

test("建议：长流程 → 建议新建；节流；拒绝过的话题不再提；可关闭", () => {
	reset();
	assert.equal(turn({ userText: "你好", tools: [] }), null);
	assert.equal(turn({ userText: "看看文件", tools: ["ls", "read"] }), null);
	const s = turn({ userText: "把发票照片整理成报销单", tools: ["ls", "read", "bash", "bash", "write"] });
	assert.deepEqual(s, { kind: "create", topic: "把发票照片整理成报销单" });
	const id = si.recordSuggestion("a", "c1", s!);
	// 同一对话 / 2 小时内不再提
	assert.equal(turn({ userText: "把发票照片整理成报销单", tools: ["ls", "read", "bash", "bash", "write"], conversationId: "c2" }), null);
	si.resolveSuggestion(id, "declined");
	db.exec("UPDATE skill_suggestions SET created_at = created_at - 3*86400000");
	// 拒绝过的同类话题不再提
	assert.equal(turn({ userText: "把这些发票照片整理成报销单吧", tools: ["ls", "read", "bash", "bash", "write"], conversationId: "c3" }), null);
	// 不同话题可以提
	assert.equal(turn({ userText: "把会议录音转成纪要", tools: ["ls", "read", "bash", "bash", "write"], conversationId: "c4" })?.kind, "create");
	reset();
	si.setSuggestSettings({ enabled: false });
	assert.equal(turn({ userText: "把会议录音转成纪要", tools: ["ls", "read", "bash", "bash", "write"] }), null);
	si.setSuggestSettings({ enabled: true });
});

test("建议：跨对话重复的任务（步数不多也提）", () => {
	reset();
	assert.equal(turn({ userText: "把今天的日报发给我看看格式", tools: ["read", "bash", "write"], conversationId: "x1" }), null);
	const s = turn({ userText: "把今天的日报整理一下格式", tools: ["read", "bash", "write"], conversationId: "x2" });
	assert.equal(s?.kind, "create");
});

test("建议：已有相似技能 → 建议更新；用了技能又被纠正 → 建议更新该技能", () => {
	reset();
	const s = turn({ userText: "做一下每周的销售数据汇总", tools: ["ls", "read", "bash", "bash", "write"] });
	assert.deepEqual(s, { kind: "update", topic: "做一下每周的销售数据汇总", skill: "weekly-sales" });
	reset();
	assert.equal(turn({ userText: "周销售汇总", tools: ["read", "bash"], usedSkills: ["weekly-sales"] }), null);
	const u = turn({ userText: "不对，以后都先按地区分组再汇总", tools: ["read", "bash"], usedSkills: ["weekly-sales"], conversationId: "y" });
	assert.deepEqual(u, { kind: "update", topic: "不对，以后都先按地区分组再汇总", skill: "weekly-sales" });
	// 内置技能不触发
	reset();
	assert.equal(turn({ userText: "不对，改成表格", tools: ["read"], usedSkills: ["web-research"] }), null);
});

test("用户同意建议后 30 分钟内新建技能免二次确认", () => {
	reset();
	assert.equal(si.hasCreateGrant("g1"), false);
	const id = si.recordSuggestion("a", "g1", { kind: "create", topic: "x" });
	si.resolveSuggestion(id, "accepted");
	assert.equal(si.hasCreateGrant("g1"), true);
	assert.equal(si.hasCreateGrant("g2"), false);
});

// ---------------------------------------------------------------- 具体用途 + 提议（skill_propose）

const good = { subject: "会议纪要整理", does: "从录音整理议题、决定和负责人", when: "下次整理会议录音", gives: "带待办清单的纪要" };

test("用途校验：具体内容通过；工具名/通用模板/空字段/超长拒绝", () => {
	assert.equal(si.validatePurpose(good), null);
	assert.match(si.validatePurpose({ ...good, does: "读文件、写文件、运行命令" })!, /工具名/);
	assert.match(si.validatePurpose({ ...good, does: "读文件" })!, /工具名/);
	assert.match(si.validatePurpose({ ...good, subject: "处理" })!, /太笼统/);
	assert.match(si.validatePurpose({ ...good, when: "下次同类任务" })!, /太笼统/);
	assert.match(si.validatePurpose({ ...good, subject: "  " })!, /不能为空/);
	assert.match(si.validatePurpose({ ...good, does: "继续" })!, /太笼统|长度/);
	assert.match(si.validatePurpose({ ...good, gives: "x".repeat(120) })!, /长度/);
});

test("卡片正文用具体内容（做什么/什么时候用/能给你），不写工具列表也不断言“做完了”", () => {
	const q = si.suggestionQuestion(good);
	assert.match(q, /把「会议纪要整理」存成技能？/);
	assert.match(q, /做什么：从录音整理议题、决定和负责人/);
	assert.match(q, /什么时候用：下次整理会议录音/);
	assert.match(q, /能给你：带待办清单的纪要/);
	assert.ok(!/读文件|写文件|运行命令/.test(q));
	assert.ok(!/做完了/.test(q));
});

test("提议：只接受本助理本对话的那条候选，一次性、过期作废", () => {
	reset();
	const id = si.beginProposal("a", "c1", { kind: "create", topic: "把会议录音转成纪要" });
	assert.equal(si.suggestionById(id)!.status, "proposing");
	// 伪造 id / 别的助理 / 别的对话都不行
	assert.equal(si.submitProposal({ agentId: "a", conversationId: "c1", suggestionId: "sg_fake", purpose: good }).ok, false);
	assert.equal(si.submitProposal({ agentId: "b", conversationId: "c1", suggestionId: id, purpose: good }).ok, false);
	assert.equal(si.submitProposal({ agentId: "a", conversationId: "c2", suggestionId: id, purpose: good }).ok, false);
	// 校验不过时不消耗候选（可以在 TTL 内改好再提交）
	assert.equal(si.submitProposal({ agentId: "a", conversationId: "c1", suggestionId: id, purpose: { ...good, does: "写文件" } }).ok, false);
	assert.equal(si.suggestionById(id)!.status, "proposing");
	const ok = si.submitProposal({ agentId: "a", conversationId: "c1", suggestionId: id, purpose: good });
	assert.ok(ok.ok);
	assert.match((ok as { question: string }).question, /会议纪要整理/);
	assert.equal(si.suggestionById(id)!.status, "pending");
	// 一次性：同一条不能再提交
	assert.equal(si.submitProposal({ agentId: "a", conversationId: "c1", suggestionId: id, purpose: good }).ok, false);
	// 过期：超过 TTL 的 proposing 直接作废
	const old = si.beginProposal("a", "c1", { kind: "create", topic: "整理报销单" });
	db.prepare("UPDATE skill_suggestions SET created_at = created_at - ? WHERE id = ?").run(si.PROPOSAL_TTL + 1000, old);
	assert.equal(si.submitProposal({ agentId: "a", conversationId: "c1", suggestionId: old, purpose: good }).ok, false);
	assert.equal(si.suggestionById(old)!.status, "expired");
});

test("提议：nudge 结束未提交 → 作废；已出卡片保持 pending；同意给创建 grant", async () => {
	reset();
	const id = si.beginProposal("a", "c1", { kind: "create", topic: "把会议录音转成纪要" });
	// 模拟 nudge 结束模型没提交
	si.expireProposal(id);
	assert.equal(si.suggestionById(id)!.status, "expired");
	assert.equal(si.submitProposal({ agentId: "a", conversationId: "c1", suggestionId: id, purpose: good }).ok, false);
	// 用户同意
	const id2 = si.beginProposal("a", "c1", { kind: "create", topic: "把会议录音转成纪要" });
	const r = await si.proposeAndAsk({ agentId: "a", conversationId: "c1", suggestionId: id2, purpose: good, ask: async () => "做成技能" });
	assert.equal(r.status, "accepted");
	assert.equal(si.hasCreateGrant("c1"), true);
	// 拒绝 / 静音 / 没回答
	const id3 = si.beginProposal("a", "c1", { kind: "create", topic: "整理发票" });
	assert.equal((await si.proposeAndAsk({ agentId: "a", conversationId: "c1", suggestionId: id3, purpose: good, ask: async () => "这次不用" })).status, "declined");
	assert.equal(si.suggestionById(id3)!.status, "declined");
	const id4 = si.beginProposal("a", "c1", { kind: "create", topic: "整理发票" });
	assert.equal((await si.proposeAndAsk({ agentId: "a", conversationId: "c1", suggestionId: id4, purpose: good, ask: async () => "别再提醒" })).status, "muted");
	assert.equal(si.suggestionById(id4)!.status, "muted");
	const id5 = si.beginProposal("a", "c1", { kind: "create", topic: "整理发票" });
	assert.equal((await si.proposeAndAsk({ agentId: "a", conversationId: "c1", suggestionId: id5, purpose: good, ask: async () => undefined })).status, "expired");
	const failed = si.beginProposal("a", "c1", { kind: "create", topic: "整理发票" });
	assert.equal((await si.proposeAndAsk({ agentId: "a", conversationId: "c1", suggestionId: failed, purpose: good, ask: async () => { throw new Error("question failed"); } })).status, "expired");
	assert.equal(si.suggestionById(failed)!.status, "expired");
	const stopped = si.beginProposal("a", "c1", { kind: "create", topic: "整理发票" });
	assert.equal((await si.proposeAndAsk({ agentId: "a", conversationId: "c1", suggestionId: stopped, purpose: good, ask: async () => "（用户已停止）" })).status, "expired");
	reset();
	const stale = si.beginProposal("a", "c1", { kind: "create", topic: "整理发票" });
	si.expireStaleSuggestions();
	assert.equal(si.suggestionById(stale)!.status, "expired");
	assert.equal(turn({ userText: "把发票照片整理成报销单", tools: ["ls", "read", "bash", "bash", "write"] })?.kind, "create", "未出卡的过期候选不消耗节流");
});

test("候选：泛泛继续/证据不足/这一轮失败都不提；候选本身不带猜出来的用途", () => {
	reset();
	assert.equal(turn({ userText: "继续", tools: ["ls", "read", "bash", "bash", "write"] }), null);
	assert.equal(turn({ userText: "再看看", tools: ["ls", "read", "bash", "bash", "write"] }), null);
	assert.equal(turn({ userText: "把发票照片整理成报销单", tools: ["ls", "read", "bash", "bash", "write"], ok: false }), null);
	assert.equal(turn({ userText: "把发票照片整理成报销单", tools: ["ls", "read", "bash", "bash", "write"], reply: "抱歉，这次没能完成，文件读不出来" }), null);
	assert.equal(turn({ userText: "把发票照片整理成报销单", tools: ["ls", "read", "bash", "bash", "write"], reply: "这次没能完成，文件读不出来", ok: true }), null);
	const s = turn({ userText: "把发票照片整理成报销单", tools: ["ls", "read", "bash", "bash", "write"], ok: true });
	assert.deepEqual(s, { kind: "create", topic: "把发票照片整理成报销单" });
	assert.ok(!("purpose" in s!));
});
