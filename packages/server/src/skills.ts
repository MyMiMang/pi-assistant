/**
 * 技能库：Pi 原生 Agent Skills（目录 + SKILL.md，frontmatter name/description）。
 *  - 内置技能：随 App 发布（packages/server/skills），只读
 *  - 我的技能：数据目录/skills/<name>/SKILL.md，用户在界面里或助理用 skill_save 工具创建/修改
 * 两个目录都通过 DefaultResourceLoader 的 additionalSkillPaths 交给 Pi，由 Pi 负责发现与按需加载。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bus } from "./bus.ts";
import { config } from "./config.ts";
import { getSetting, setSetting } from "./db.ts";

export const builtinSkillsDir = join(import.meta.dirname, "..", "skills");
export const userSkillsDir = () => join(config.dataDir, "skills");
export const skillPaths = () => [builtinSkillsDir, userSkillsDir()].filter((d) => existsSync(d));
export const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

export interface Skill {
	name: string;
	description: string;
	body: string;
	builtin: boolean;
	path: string;
	updatedAt: number;
}

export function parseSkill(md: string): { name?: string; description?: string; body: string } {
	const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!m) return { body: md };
	const fm: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
		if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
	}
	return { name: fm.name, description: fm.description, body: m[2].replace(/^\n+/, "") };
}
const yamlStr = (s: string) => (/[:#"'\n]|^\s|\s$/.test(s) ? JSON.stringify(s) : s);
export const renderSkill = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${yamlStr(description.replace(/\s+/g, " ").trim())}\n---\n\n${body.trim()}\n`;

function readDir(dir: string, builtin: boolean): Skill[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.map((n) => join(dir, n, "SKILL.md"))
		.filter((p) => existsSync(p))
		.map((p) => {
			const s = parseSkill(readFileSync(p, "utf8"));
			const name = s.name ?? p.split(/[\\/]/).at(-2)!;
			return { name, description: s.description ?? "", body: s.body, builtin, path: p, updatedAt: statSync(p).mtimeMs };
		});
}

export function listSkills(): Skill[] {
	const user = readDir(userSkillsDir(), false);
	const names = new Set(user.map((s) => s.name));
	return [...readDir(builtinSkillsDir, true).filter((s) => !names.has(s.name)), ...user].sort((a, b) => Number(a.builtin) - Number(b.builtin) || a.name.localeCompare(b.name));
}
export const getSkill = (name: string) => listSkills().find((s) => s.name === name);

/** 技能目录有变化：递增版本号，运行时在下一轮对话前重建会话以加载新技能。 */
function changed() {
	setSetting("skillsVersion", getSetting("skillsVersion", 0) + 1);
	bus.emit({ type: "skills.changed" });
}
export const skillsVersion = () => getSetting("skillsVersion", 0);

export function saveSkill(input: { name: string; description: string; body: string; previousName?: string }): Skill {
	const name = input.name.trim().toLowerCase();
	if (!NAME_RE.test(name)) throw new Error("技能名只能用小写字母、数字和连字符（例如 weekly-report），最长 64 个字符");
	if (!input.description.trim()) throw new Error("请填写描述：说明这个技能做什么、什么时候用");
	if (input.description.length > 1024) throw new Error("描述最长 1024 个字符");
	if (!input.body.trim()) throw new Error("技能内容不能为空");
	const dir = join(userSkillsDir(), name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), renderSkill(name, input.description, input.body));
	if (input.previousName && input.previousName !== name && NAME_RE.test(input.previousName)) rmSync(join(userSkillsDir(), input.previousName), { recursive: true, force: true });
	changed();
	return getSkill(name)!;
}

export function deleteSkill(name: string) {
	if (!NAME_RE.test(name)) return false;
	const dir = join(userSkillsDir(), name);
	if (!existsSync(dir)) return false;
	rmSync(dir, { recursive: true, force: true });
	changed();
	return true;
}
