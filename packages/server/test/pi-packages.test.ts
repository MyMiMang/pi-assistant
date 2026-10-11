process.env.PIA_MOCK = "1";
await import("./setup.ts");
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const { config } = await import("../src/config.ts");
const pk = await import("../src/pi-packages.ts");
const modelsMod = await import("../src/models.ts");
const { createPiSession, disposeSession, loadedResources } = await import("../src/pi-adapter/index.ts");

const dir = mkdtempSync(join(tmpdir(), "pia-pkg-"));
mkdirSync(join(dir, "extensions"), { recursive: true });
mkdirSync(join(dir, "skills", "pkg-skill"), { recursive: true });
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo-pi-package", version: "0.1.0", description: "测试包", keywords: ["pi-package"] }));
writeFileSync(join(dir, "skills", "pkg-skill", "SKILL.md"), "---\nname: pkg-skill\ndescription: 来自扩展包的技能\n---\n步骤");
writeFileSync(
	join(dir, "extensions", "hello.ts"),
	`export default function (pi) { pi.registerTool({ name: "pkg_hello", label: "hello", description: "来自扩展包的工具", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "hi" }], details: undefined }; } }); }`,
);

test("来源格式", () => {
	assert.equal(pk.normalizeSource("@scope/pkg@1.2.0"), "npm:@scope/pkg@1.2.0");
	assert.equal(pk.normalizeSource("git:github.com/a/b@v1"), "git:github.com/a/b@v1");
	assert.throws(() => pk.normalizeSource("rm -rf /"));
});

test("添加本机包 → 识别资源 → 会话加载其中的扩展和技能；按助理启用", async () => {
	const p = await pk.addPackage(dir);
	for (let i = 0; i < 50 && pk.getPackage(p.id)!.status === "installing"; i++) await new Promise((r) => setTimeout(r, 50));
	const row = pk.getPackage(p.id)!;
	assert.equal(row.status, "installed", row.error ?? "");
	assert.deepEqual(JSON.parse(row.resources!), { name: "demo-pi-package", version: "0.1.0", description: "测试包", extensions: 1, skills: 1, prompts: 0 });
	await assert.rejects(() => pk.addPackage(dir), /添加过/);
	assert.deepEqual(pk.packagePathsFor("a1"), [dir]);
	pk.setPackageEnabled(p.id, true, ["a2"]);
	assert.deepEqual(pk.packagePathsFor("a1"), []);
	pk.setPackageEnabled(p.id, true, null);

	await modelsMod.initModels();
	const ws = join(config.workspaceRoot, "pkg");
	mkdirSync(ws, { recursive: true });
	const session = await createPiSession({
		models: modelsMod.models,
		cwd: ws,
		agentDir: join(config.agentsDir, "pkg"),
		sessionDir: join(config.agentsDir, "pkg", "sessions"),
		model: { provider: "mock", id: "echo" },
		systemPromptAppend: [],
		extensions: [],
		packagePaths: pk.packagePathsFor("a1"),
	});
	const r = loadedResources(session);
	assert.ok(r.skills.some((s) => s.name === "pkg-skill"), JSON.stringify(r.skills));
	assert.ok(session.getAllTools().some((t) => t.name === "pkg_hello"), "扩展包里的工具应已注册");
	await disposeSession(session);
	assert.ok(await pk.removePackage(p.id));
	assert.equal(pk.listPackages().length, 0);
});
