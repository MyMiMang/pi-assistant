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
