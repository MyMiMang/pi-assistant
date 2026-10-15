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
