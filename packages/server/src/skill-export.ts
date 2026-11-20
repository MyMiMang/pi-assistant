import { readdirSync } from "node:fs";
import { join } from "node:path";
import { strFromU8, zipSync } from "fflate";
import { readSkillBytes, readSkillTree, realSkillRoot } from "./skill-files.ts";
import { canonicalSkillId, NAME_RE, parseSkill, skillRoots } from "./skills.ts";

export function exportSkillZip(id: string) {
	const [source, name, ...extra] = id.split("/");
	const root = skillRoots().find((r) => r.source === source);
	if (!root || !name || !NAME_RE.test(name) || extra.length || canonicalSkillId(root.source, name) !== id) return null;
	const directory = realSkillRoot(root.dir);
	// 库存按声明名去重；发现另一个同来源目录声明同名时，不能猜用户选中哪份。
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === name || !entry.isDirectory()) continue;
		let metadata: Buffer;
		try { metadata = readSkillBytes(join(directory, entry.name, "SKILL.md")); } catch { continue; }
		if (parseSkill(metadata.toString("utf8")).name === name) throw new Error("技能库中有身份相同的目录，无法准确导出");
	}
	const files = readSkillTree(join(directory, name));
	const md = files.get("SKILL.md");
	if (!md) throw new Error("技能目录缺少原始 SKILL.md");
	const parsed = parseSkill(md.toString("utf8"));
	if (parsed.name !== name || !parsed.description?.trim()) throw new Error("技能声明与已保存身份不一致，无法无损导出");
	for (const [path, bytes] of files) {
		if (path.endsWith("/SKILL.md")) throw new Error("技能目录内包含其他技能，未生成 ZIP");
		try {
			if (!Buffer.from(strFromU8(bytes), "utf8").equals(bytes)) throw new Error();
		} catch {
			throw new Error(`现有导入器无法无损还原「${path}」；未生成 ZIP`);
		}
	}
	return { name: `${name}.zip`, bytes: zipSync(Object.fromEntries(files)) };
}
