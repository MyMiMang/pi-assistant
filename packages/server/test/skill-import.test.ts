/**
 * 技能外部导入隔离测试：本地目录 / zip 的安全边界与重复处理。
 * 数据目录由 test/setup.ts 强制临时目录；不联网、不执行技能里的任何脚本。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";

const { config } = await import("../src/config.ts");
const { externalSkillsDir, listSkills } = await import("../src/skills.ts");
const { ImportConflict, importSkillFromPath, importSkillFromZip, IMPORT_LIMITS } = await import("../src/skill-import.ts");

const md = (name: string, desc: string, body = "步骤") => `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`;

function writeSkillDir(name: string, desc: string, body?: string) {
	const dir = join(config.dataDir, "import-src", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), md(name, desc, body));
	return dir;
}

test("导入本地目录：落 external 来源，库存可见", () => {
	const dir = writeSkillDir("imp-dir", "从目录导入的技能，测试来源");
	const r = importSkillFromPath(dir);
	assert.equal(r.id, "external/imp-dir");
	assert.equal(r.reused, undefined);
	assert.ok(readFileSync(join(externalSkillsDir(), "imp-dir", "SKILL.md"), "utf8").includes("imp-dir"));
	const listed = listSkills().find((s) => s.name === "imp-dir")!;
	assert.equal(listed.source, "external");
	assert.equal(listed.id, "external/imp-dir");
});

test("同内容再导入：复用，不重复写文件", () => {
	const dir = writeSkillDir("imp-same", "同内容复用的技能");
	importSkillFromPath(dir);
	const again = importSkillFromPath(dir);
	assert.equal(again.reused, true);
	assert.equal(again.files, 0);
	assert.equal(again.id, "external/imp-same");
});

test("同名内容不同：默认报冲突，不静默覆盖", () => {
	writeSkillDir("imp-conflict", "第一版描述");
	importSkillFromPath(join(config.dataDir, "import-src", "imp-conflict"));
	const dir2 = join(config.dataDir, "import-src", "imp-conflict-v2");
	mkdirSync(dir2, { recursive: true });
	writeFileSync(join(dir2, "SKILL.md"), md("imp-conflict", "第二版描述，内容不同"));
	assert.throws(() => importSkillFromPath(dir2), (e) => e instanceof ImportConflict && (e as { existing: { id: string } }).existing.id === "external/imp-conflict");
});

test("mode=update：覆盖同名 external；mode=rename：另存新名", () => {
	writeSkillDir("imp-upd", "旧描述");
	importSkillFromPath(join(config.dataDir, "import-src", "imp-upd"));
	const dir2 = join(config.dataDir, "import-src", "imp-upd-v2");
	mkdirSync(dir2, { recursive: true });
	writeFileSync(join(dir2, "SKILL.md"), md("imp-upd", "新描述"));
	const upd = importSkillFromPath(dir2, { mode: "update" });
	assert.equal(upd.id, "external/imp-upd");
	assert.equal(listSkills().find((s) => s.name === "imp-upd")!.description, "新描述");
	const ren = importSkillFromPath(dir2, { mode: "rename", newName: "imp-upd-renamed" });
	assert.equal(ren.id, "external/imp-upd-renamed");
	assert.ok(listSkills().some((s) => s.name === "imp-upd-renamed"));
});

test("导入 zip：正常解压入库", async () => {
	const zip = zipSync({
		"my-skill/SKILL.md": strToU8(md("imp-zip", "从 zip 导入的技能")),
		"my-skill/references/x.md": strToU8("参考"),
	});
	const r = await importSkillFromZip(zip);
	assert.equal(r.id, "external/imp-zip");
	assert.equal(r.files, 2);
	assert.ok(readFileSync(join(externalSkillsDir(), "imp-zip", "references", "x.md"), "utf8").includes("参考"));
});

test("zip 安全：拒绝 ../ 逃逸路径", async () => {
	const zip = zipSync({ "../evil/SKILL.md": strToU8(md("evil", "逃逸")) });
	await assert.rejects(() => importSkillFromZip(zip), /不安全的路径/);
});

test("zip 安全：拒绝超单文件上限（bomb）", async () => {
	const big = new Uint8Array(IMPORT_LIMITS.maxFileBytes + 1024); // 全 0，压缩后很小
	const zip = zipSync({ "big/SKILL.md": strToU8(md("imp-big", "大文件")), "big/blob.bin": big });
	await assert.rejects(() => importSkillFromZip(zip), /过大|总量/);
});

test("没有 SKILL.md：报错", async () => {
	const zip = zipSync({ "x/readme.md": strToU8("no skill") });
	await assert.rejects(() => importSkillFromZip(zip), /没有找到 SKILL.md/);
});

test("缺 description：报错", async () => {
	const zip = zipSync({ "y/SKILL.md": strToU8("---\nname: imp-nodesc\n---\n\n正文") });
	await assert.rejects(() => importSkillFromZip(zip), /缺少 description/);
});
