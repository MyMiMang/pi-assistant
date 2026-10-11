/**
 * 隔离测试：我们只用自己打包的 Pi 与自己的数据目录。
 * 伪造一个“用户自己装过 Pi”的 HOME（~/.pi/agent 里有扩展/技能/auth/models，~/.agents/skills 里有技能），
 * 断言：会话不加载其中任何东西；HOME 里没有任何文件被创建或修改；Pi 的默认目录指向我们的数据目录。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
const fakeHome = mkdtempSync(join(tmpdir(), "pia-fake-home-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.PIA_MOCK = "1";
process.env.PI_CODING_AGENT_DIR = join(fakeHome, ".pi", "agent"); // 外部环境里的同名变量也必须被我们覆盖
const put = (p: string, c: string) => (mkdirSync(join(p, ".."), { recursive: true }), writeFileSync(p, c));
put(join(fakeHome, ".pi/agent/skills/evil-skill/SKILL.md"), "---\nname: evil-skill\ndescription: should never load\n---\nx");
put(join(fakeHome, ".agents/skills/evil-agents/SKILL.md"), "---\nname: evil-agents\ndescription: should never load\n---\nx");
put(join(fakeHome, ".pi/agent/extensions/evil.ts"), "export default () => { throw new Error('user extension loaded'); };");
put(join(fakeHome, ".pi/agent/auth.json"), '{"openai":{"type":"api_key","key":"sk-user"}}');
put(join(fakeHome, ".pi/agent/models.json"), '{"providers":{}}');
put(join(fakeHome, ".pi/agent/settings.json"), '{"defaultProvider":"openai"}');

function snapshot(dir: string) {
	const out: Record<string, string> = {};
	const walk = (d: string) => {
		for (const n of readdirSync(d)) {
			const p = join(d, n);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else out[relative(dir, p)] = `${st.size}:${st.mtimeMs}:${readFileSync(p, "utf8").length}`;
		}
	};
	walk(dir);
	return out;
}
const before = snapshot(fakeHome);

await import("./setup.ts");
const assert = (await import("node:assert/strict")).default;
const { test } = await import("node:test");
const { config } = await import("../src/config.ts");
const modelsMod = await import("../src/models.ts");
const { createPiSession, disposeSession, loadedResources } = await import("../src/pi-adapter/index.ts");
const { skillPaths } = await import("../src/skills.ts");

test("Pi 默认目录指向我们的数据目录", () => {
	assert.equal(process.env.PI_CODING_AGENT_DIR, join(config.dataDir, "pi-agent"));
	assert.ok(!process.env.PI_CODING_AGENT_DIR!.startsWith(fakeHome));
});

test("会话不加载用户自己的 Pi 扩展/技能，也不在 HOME 里读写任何文件", async () => {
	process.env.PIA_MOCK = "1";
	await modelsMod.initModels();
	const ws = join(config.workspaceRoot, "iso");
	mkdirSync(ws, { recursive: true });
	const session = await createPiSession({
		models: modelsMod.models,
		cwd: ws,
		agentDir: join(config.agentsDir, "iso"),
		sessionDir: join(config.agentsDir, "iso", "sessions"),
		model: { provider: "mock", id: "echo" },
		systemPromptAppend: ["你是测试助理。"],
		extensions: [],
		skillPaths: skillPaths(),
	});
	const r = loadedResources(session);
	assert.ok(r.skills.some((s) => s.name === "web-research"), "我们的内置技能已加载");
	assert.ok(!r.skills.some((s) => s.name.startsWith("evil")), `不应加载用户技能：${r.skills.map((s) => s.path).join(", ")}`);
	assert.ok(r.skills.every((s) => !s.path.startsWith(fakeHome)));
	assert.ok(r.extensions.every((p) => !p.startsWith(fakeHome)), `不应加载用户扩展：${r.extensions.join(", ")}`);
	await session.prompt("你好");
	disposeSession(session);
	assert.deepEqual(snapshot(fakeHome), before, "HOME 里不应有任何文件被创建或修改");
});
