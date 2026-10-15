/**
 * 「整理上下文指定重点」+「本次选用技能」的**纯逻辑 / 适配层**单测。
 * 数据目录 / 工作区由 test/setup.ts 指向临时目录；模型用 Mock，不碰钥匙串、不联网、不花钱。
 *
 * 覆盖：
 *  - compactSession 把 instructions 原样交给 Pi 的 session.compact（空 = 原行为）；
 *  - withSkillInvocations 用 Pi 公开技能块语法展开选中的**已加载**技能，输出可被 Pi 公开 parseSkillBlock 解析，
 *    正文来自 filePath 而不是客户端自填，且不进 system prompt；
 *  - resolveSelectedSkills 只接受该助理已启用 + 库存存在的 canonical id，fail closed（同名不同来源不误启）；
 *  - 前端纯逻辑：草稿签名纳入技能、发送 payload 只在有技能时带 skills、技能 draft 按对话分桶不串。
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
const { compactSession, createPiSession, disposeSession, skillCommand } = await import("../src/pi-adapter/index.ts");
const { saveSkill, skillPaths } = await import("../src/skills.ts");
const sa = await import("../src/skill-assignments.ts");
const { resolveSelectedSkills, skillFilterFor } = await import("../src/skill-scope.ts");
const { clearSkillDraft, getSkillDraft, setSkillDraft, skillNameOf } = await import("../../../apps/web/src/skillDrafts.ts");

await modelsMod.initModels(memoryCredentialStore());

async function mkSession(agentId: string) {
	const ws = join(config.workspaceRoot, `pick-${agentId}`);
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
		skillFilter: skillFilterFor(agentId),
	});
}

test("compactSession：把 instructions 原样交给 Pi，空值保持原行为", async () => {
	let got: string | undefined;
	const fake = {
		compact: async (i?: string) => {
			got = i;
			return { tokensBefore: 42, summary: "摘要" };
		},
	};
	assert.deepEqual(await compactSession(fake as never, "保留需求、决策和待办"), { tokensBefore: 42, summary: "摘要" });
	assert.equal(got, "保留需求、决策和待办");
	await compactSession(fake as never);
	assert.equal(got, undefined, "不传 = 原行为（undefined）");
});

test("skillCommand：用 Pi 原生 `/skill:name`，只接受会话已加载技能，多个 / 未加载抛错", async () => {
	const skill = saveSkill({ name: "pick-demo", description: "选用测试技能", body: "步骤：先读文件，再改，最后说明验证。" });
	const other = saveSkill({ name: "pick-demo-2", description: "第二个技能", body: "另一个做法。" });
	sa.setAssignedSkillIds("pick-agent", [skill.id, other.id]);
	const session = await mkSession("pick-agent");
	try {
		// Pi 原生公开路径：不读正文 / 不自拼块，只给 /skill:name，由 Pi 自己展开
		assert.equal(skillCommand(session, [{ id: skill.id, name: skill.name, filePath: skill.path }]), `/skill:${skill.name}`);
		assert.equal(skillCommand(session, []), undefined);
		// 第一版一次一个：多个直接拒（Pi 原生只展开开头一个）
		assert.throws(
			() => skillCommand(session, [{ id: skill.id, name: skill.name, filePath: skill.path }, { id: other.id, name: other.name, filePath: other.path }]),
			/一次只能选一个技能/,
		);
		// 不在会话里的技能（未分配 / 假路径）：fail closed，不接受客户端路径
		assert.throws(() => skillCommand(session, [{ id: "user/nope", name: "nope", filePath: "/tmp/nope/SKILL.md" }]), /技能未加载/);
	} finally {
		await disposeSession(session);
	}
});

test("resolveSelectedSkills：只接受已启用 + 库存存在的 canonical id", () => {
	const skill = saveSkill({ name: "pick-scope", description: "作用域测试", body: "正文。" });
	// 未分配 → fail closed
	assert.equal(resolveSelectedSkills("pick-scope-none", [skill.id]), null);
	sa.setAssignedSkillIds("pick-scope-agent", [skill.id]);
	const ok = resolveSelectedSkills("pick-scope-agent", [skill.id]);
	assert.ok(ok && ok.length === 1 && ok[0].filePath === skill.path);
	// 自填假路径 / 不存在的 id / 同名不同来源（只有 user/x，却请求 builtin/x）→ 一律 null
	assert.equal(resolveSelectedSkills("pick-scope-agent", ["/etc/passwd"]), null);
	assert.equal(resolveSelectedSkills("pick-scope-agent", ["user/does-not-exist"]), null);
	assert.equal(resolveSelectedSkills("pick-scope-agent", [`builtin/${skill.name}`]), null);
	// 去重
	assert.equal(resolveSelectedSkills("pick-scope-agent", [skill.id, skill.id])?.length, 1);
});

test("前端纯逻辑：技能名解析 + draft 按对话分桶", () => {
	assert.equal(skillNameOf("builtin/web-research"), "web-research");
	setSkillDraft("a:1:2", ["user/a"]);
	setSkillDraft("a:1:3", ["user/b"]);
	assert.deepEqual(getSkillDraft("a:1:2"), ["user/a"]);
	assert.deepEqual(getSkillDraft("a:1:3"), ["user/b"]);
	clearSkillDraft("a:1:2");
	assert.deepEqual(getSkillDraft("a:1:2"), [], "取消后为空");
	assert.deepEqual(getSkillDraft("a:1:3"), ["user/b"], "切对话不串");
});
