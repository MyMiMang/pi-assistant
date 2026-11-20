await import("./setup.ts");
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { unzipSync, zipSync } from "fflate";

const { exportSkillZip } = await import("../src/skill-export.ts");
const { ImportConflict, importSkillFromPath, importSkillFromZip } = await import("../src/skill-import.ts");
const { userSkillsDir, externalSkillsDir, builtinSkillsDir } = await import("../src/skills.ts");
const md = (name: string) => Buffer.from(`---\r\nname: '${name}'\r\ndescription: 中文示例\r\n---\r\n\r\n正文\r\n`);
function fixture(root: string, name: string, files: Record<string, Buffer> = {}) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), md(name));
	for (const [rel, bytes] of Object.entries(files)) {
		mkdirSync(join(dir, rel, ".."), { recursive: true });
		writeFileSync(join(dir, rel), bytes);
	}
	return dir;
}

test("按来源选择技能，只打包一个目录，保留原中文和多层附件字节", () => {
	const name = "scope-fixture";
	fixture(userSkillsDir(), name, { "模板/一/样例.txt": Buffer.from("自建内容\n") });
	fixture(externalSkillsDir(), name, { "refs/other.txt": Buffer.from("外部内容") });
	fixture(userSkillsDir(), "not-selected");
	const zip = exportSkillZip(`user/${name}`)!;
	assert.equal(zip.name, `${name}.zip`);
	const files = unzipSync(zip.bytes);
	assert.deepEqual(Object.keys(files).sort(), ["SKILL.md", "模板/一/样例.txt"]);
	assert.deepEqual(Buffer.from(files["SKILL.md"]), md(name));
	assert.equal(Buffer.from(files["模板/一/样例.txt"]).toString(), "自建内容\n");
	assert.deepEqual(Object.keys(unzipSync(exportSkillZip(`external/${name}`)!.bytes)).sort(), ["SKILL.md", "refs/other.txt"]);
	const builtin = unzipSync(exportSkillZip("builtin/weekly-report")!.bytes);
	assert.deepEqual(Buffer.from(builtin["SKILL.md"]), readFileSync(join(builtinSkillsDir, "weekly-report", "SKILL.md")));
	for (const id of ["../foo", "user/../foo", "user//scope-fixture", "/tmp/SKILL.md", "unknown/scope-fixture"]) assert.equal(exportSkillZip(id), null);
});

test("链接、空目录、不能无损导入的字节均明确拒绝", () => {
	const dir = fixture(userSkillsDir(), "link-fixture");
	symlinkSync(join(dir, "SKILL.md"), join(dir, "linked.txt"));
	assert.throws(() => exportSkillZip("user/link-fixture"), /普通文件|链接/);
	mkdirSync(join(fixture(userSkillsDir(), "empty-fixture"), "empty"));
	assert.throws(() => exportSkillZip("user/empty-fixture"), /空目录/);
	fixture(userSkillsDir(), "binary-fixture", { "refs/image.bin": Buffer.from([0xff, 0x00, 0x80]) });
	assert.throws(() => exportSkillZip("user/binary-fixture"), /无法无损还原/);
});

test("本地目录导入再导出：同名子目录文件保留各自路径与字节", () => {
	const name = "native-directory-fixture";
	const references = Buffer.from("参考资料\r\n");
	const templates = Buffer.from("另一份模板\n");
	const dir = fixture(join(userSkillsDir(), "import-fixtures"), name, { "references/sample.txt": references, "templates/sample.txt": templates });
	const imported = importSkillFromPath(dir);
	assert.equal(imported.files, 3);
	const target = join(externalSkillsDir(), name);
	assert.deepEqual(readFileSync(join(target, "references", "sample.txt")), references);
	assert.deepEqual(readFileSync(join(target, "templates", "sample.txt")), templates);
	const files = unzipSync(exportSkillZip(imported.id)!.bytes);
	assert.deepEqual(Object.keys(files).sort(), ["SKILL.md", "references/sample.txt", "templates/sample.txt"]);
	assert.deepEqual(Buffer.from(files["SKILL.md"]), md(name));
	assert.deepEqual(Buffer.from(files["references/sample.txt"]), references);
	assert.deepEqual(Buffer.from(files["templates/sample.txt"]), templates);
});

test("ZIP 条目仍拒绝反斜杠，不按本地路径转换", async () => {
	await assert.rejects(importSkillFromZip(zipSync({ "SKILL.md": md("zip-backslash"), "references\\sample.txt": Buffer.from("参考") })), /不安全的路径/);
});

test("原样导入，正文相同附件不同必须显式解决；完全相同才复用", async () => {
	const name = "byte-fixture";
	const files = { "SKILL.md": md(name), "templates/nested/a.txt": Buffer.from("模板\r\n") };
	const first = await importSkillFromZip(zipSync(files));
	assert.equal(first.reused, undefined);
	assert.deepEqual(readFileSync(first.path), files["SKILL.md"]);
	assert.deepEqual(readFileSync(join(externalSkillsDir(), name, "templates/nested/a.txt")), files["templates/nested/a.txt"]);
	assert.equal((await importSkillFromZip(exportSkillZip(`external/${name}`)!.bytes)).reused, true);
	await assert.rejects(importSkillFromZip(zipSync({ ...files, "templates/nested/a.txt": Buffer.from("不同") })), ImportConflict);
	assert.deepEqual(readFileSync(join(externalSkillsDir(), name, "templates/nested/a.txt")), files["templates/nested/a.txt"]);
});
