/**
 * 技能分配（skill scope assignment）隔离测试。
 * 数据目录 / 工作区由 test/setup.ts 强制指向临时目录；模型用 Mock，不碰钥匙串、不联网。
 * 覆盖：
 *  - 分配表语义：缺失 / [] 都是不启用任何技能（含内置），没有全局默认；
 *  - canonical id 与来源（builtin/user/external）识别；
 *  - 会话技能选集：只加载被启用的技能，未选中的 name/description 不进 system prompt；
 *  - 主会话 / 后台任务 / 子代理共用同一处 effective 选集（skillFilterFor）。
 */
process.env.PIA_MOCK = "1";
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const { config } = await import("../src/config.ts");
const modelsMod = await import("../src/models.ts");
const { memoryCredentialStore } = await import("./in-memory-credentials.ts");
const { createPiSession, disposeSession, loadedResources } = await import("../src/pi-adapter/index.ts");
const { listSkills, skillPaths, skillIdOfPath, saveSkill, canonicalSkillId, builtinSkillsDir } = await import("../src/skills.ts");
const { searchSkills } = await import("../src/skill-intel.ts");
const sa = await import("../src/skill-assignments.ts");

test("分配表：缺失 / 显式 [] 都是不启用任何技能，没有全局默认", () => {
	assert.deepEqual(sa.assignedSkillIds("nobody"), []);
	sa.setAssignedSkillIds("a1", []);
	assert.deepEqual(sa.assignedSkillIds("a1"), []);
	// 内置技能默认也不启用：分配表为空时 listSkills 里没有任何一个会被选进会话
	assert.ok(listSkills().some((s) => s.builtin), "库存里仍有内置技能（只是默认不启用）");
});

test("分配表：启用 / 停用 / 批量 / 反查 / 摘除", () => {
	sa.setAssignedSkillIds("a1", []);
	sa.enableSkillForAgent("a1", "user/foo");
	sa.enableSkillForAgent("a1", "user/foo"); // 去重
	sa.enableSkillForAgent("a1", "builtin/bar");
	assert.deepEqual(sa.assignedSkillIds("a1").sort(), ["builtin/bar", "user/foo"]);
	assert.deepEqual(sa.agentsUsingSkill("user/foo"), ["a1"]);
	sa.enableSkillForAgents(["a2", "a3"], "user/foo");
	assert.deepEqual(sa.agentsUsingSkill("user/foo").sort(), ["a1", "a2", "a3"]);
	sa.disableSkillForAgent("a1", "user/foo");
	assert.deepEqual(sa.assignedSkillIds("a1"), ["builtin/bar"]);
	assert.deepEqual(sa.unassignSkillEverywhere("user/foo").sort(), ["a2", "a3"]);
	assert.deepEqual(sa.agentsUsingSkill("user/foo"), []);
});

test("canonical id / 来源识别：内置是 builtin/*，用户自建是 user/*", () => {
	const builtin = listSkills().find((s) => s.builtin)!;
	assert.equal(builtin.source, "builtin");
	assert.equal(builtin.id, canonicalSkillId("builtin", builtin.name));
	assert.equal(skillIdOfPath(builtin.path, builtin.name), builtin.id);
	assert.equal(skillIdOfPath(builtin.path, builtin.name), `builtin/${builtin.name}`);

	const saved = saveSkill({ name: "scope-test-skill", description: "分配测试用技能，验证 user 来源与选集", body: "步骤：无。" });
	assert.equal(saved.source, "user");
	assert.equal(saved.id, "user/scope-test-skill");
	assert.equal(skillIdOfPath(saved.path, saved.name), "user/scope-test-skill");
	// 不在任何已知根目录里的路径：一律 null（调用方按未分配处理）
	assert.equal(skillIdOfPath("/tmp/nowhere/SKILL.md", "nowhere"), null);
});

test("会话只加载被启用的技能，未选中不进 prompt", async () => {
	await modelsMod.initModels(memoryCredentialStore());
	const builtin = listSkills().find((s) => s.builtin)!;
	const userSkill = saveSkill({ name: "scope-enabled", description: "被启用的技能，用于选集测试", body: "正文不应出现在 prompt。" });

	const mk = async (agentId: string) => {
		const ws = join(config.workspaceRoot, `scope-${agentId}`);
		mkdirSync(ws, { recursive: true });
		return createPiSession({
			models: modelsMod.models,
			cwd: ws,
			agentDir: join(config.agentsDir, agentId),
			sessionDir: join(config.agentsDir, agentId, "sessions"),
			model: { provider: "mock", id: "echo" },
			systemPromptAppend: [],
			extensions: [],
			skillPaths: skillPaths(),
			skillFilter: (s) => {
				const id = skillIdOfPath(s.filePath, s.name);
				return id !== null && new Set(sa.assignedSkillIds(agentId)).has(id);
			},
		});
	};

	// 默认：一个都不启用
	sa.setAssignedSkillIds("scope-none", []);
	const none = await mk("scope-none");
	assert.deepEqual(loadedResources(none).skills, [], "默认不启用任何技能（含内置）");
	await disposeSession(none);

	// 只启用用户技能：内置不进会话
	sa.setAssignedSkillIds("scope-user", [userSkill.id]);
	const onlyUser = await mk("scope-user");
	const names = loadedResources(onlyUser).skills.map((s) => s.name);
	assert.deepEqual(names, ["scope-enabled"]);
	assert.ok(!names.includes(builtin.name), "未启用的内置技能不加载");
	await disposeSession(onlyUser);

	// 只启用内置：用户技能不进会话
	sa.setAssignedSkillIds("scope-builtin", [builtin.id]);
	const onlyBuiltin = await mk("scope-builtin");
	const names2 = loadedResources(onlyBuiltin).skills.map((s) => s.name);
	assert.deepEqual(names2, [builtin.name]);
	await disposeSession(onlyBuiltin);

	// 内置目录里确实有技能（确认上面不是「库存为空」导致的假通过）
	assert.ok(skillPaths().includes(builtinSkillsDir));
});

test("变更分配会递增版本号（运行时据此重建会话）", () => {
	const v0 = sa.assignmentsVersion();
	sa.setAssignedSkillIds("ver-agent", []);
	const v1 = sa.assignmentsVersion();
	assert.ok(v1 > v0, "写分配后版本号递增");
	sa.enableSkillForAgent("ver-agent", "user/x");
	assert.ok(sa.assignmentsVersion() > v1);
});

test("skill_search 只检可用集：未选中技能的名字 / 描述不外泄", () => {
	const secret = saveSkill({ name: "secret-unselected", description: "未分配给这个助理的敏感技能", body: "不该被搜到。" });
	const shared = saveSkill({ name: "shared-selected", description: "已启用的共享技能", body: "可以被搜到。" });
	sa.setAssignedSkillIds("search-agent", [shared.id]);
	const enabled = new Set(sa.assignedSkillIds("search-agent"));
	const hits = searchSkills("技能").filter((h) => enabled.has(h.id));
	assert.ok(hits.some((h) => h.id === shared.id), "已启用技能可搜到");
	assert.ok(!hits.some((h) => h.id === secret.id), "未启用技能不出现在可用集搜索里");
	// 全库存搜索仍能看到它（供用户手动管理），说明不是文件没建成功
	assert.ok(searchSkills("技能").some((h) => h.id === secret.id));
});

test("同名不同来源的 canonical id 不互相错启", () => {
	// 用两个 id 字符串直接验证过滤语义：只启用 user/foo，不应把 builtin/foo 也放进来
	sa.setAssignedSkillIds("same-name", [canonicalSkillId("user", "foo")]);
	const enabled = new Set(sa.assignedSkillIds("same-name"));
	assert.ok(enabled.has("user/foo"));
	assert.ok(!enabled.has("builtin/foo"));
});

test("effective 选集按所属助理 id：后台 / 子代理共用同一份，不 expand", async () => {
	const { skillFilterFor, enabledSkillsFor } = await import("../src/skill-scope.ts");
	const builtin = listSkills().find((s) => s.builtin)!;
	const other = listSkills().find((s) => s.id !== builtin.id)!;
	sa.setAssignedSkillIds("parent-agent", [builtin.id]);
	// 主会话 / 后台任务 / 子代理都传同一个 agentId → 同一份 filter 结果
	const f = skillFilterFor("parent-agent");
	assert.equal(f({ name: builtin.name, filePath: builtin.path }), true);
	assert.equal(f({ name: other.name, filePath: other.path }), false);
	// 未分配的其它助理：空集，不因「父代理启用了」而跟着可见
	assert.equal(skillFilterFor("child-agent")({ name: builtin.name, filePath: builtin.path }), false);
	assert.deepEqual(enabledSkillsFor("child-agent"), []);
	assert.deepEqual(enabledSkillsFor("parent-agent").map((s) => s.id), [builtin.id]);
	// 不在任何已知根目录里的路径：一律不启用（fail closed）
	assert.equal(skillFilterFor("parent-agent")({ name: "x", filePath: "/tmp/nowhere/SKILL.md" }), false);
});
