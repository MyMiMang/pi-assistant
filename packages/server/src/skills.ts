/**
 * 技能库：Pi 原生 Agent Skills（目录 + SKILL.md，frontmatter name/description）。
 *  - 内置技能：随 App 发布（packages/server/skills），只读
 *  - 我的技能：数据目录/skills/<name>/SKILL.md，用户在界面里或助理用 skill_save 工具创建/修改
 * 两个目录都通过 DefaultResourceLoader 的 additionalSkillPaths 交给 Pi，由 Pi 负责发现与按需加载。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { bus } from "./bus.ts";
import { config } from "./config.ts";
import { getSetting, setSetting } from "./db.ts";

export const builtinSkillsDir = join(import.meta.dirname, "..", "skills");
export const userSkillsDir = () => join(config.dataDir, "skills");
/** 外部导入的技能（zip / 目录 / 单文件 SKILL.md）：与用户自建分开，来源标签不同、同一份库存只放一处。 */
export const externalSkillsDir = () => join(config.dataDir, "skills-external");

/** 技能来源。canonical id 用 `来源/名称`，同名不同来源不会互相错启。 */
export type SkillSource = "builtin" | "user" | "external";

/** 技能根目录，**顺序即 Pi 的发现优先级**（先出现者胜，同名冲突 Pi 保留第一个）。
 *  user / external 放在 builtin 前面：用户自己或导入的技能可以覆盖同名内置技能。 */
export const skillRoots = (): { source: SkillSource; dir: string }[] => [
	{ source: "user", dir: userSkillsDir() },
	{ source: "external", dir: externalSkillsDir() },
	{ source: "builtin", dir: builtinSkillsDir },
];

export const skillPaths = () => skillRoots().map((r) => r.dir).filter((d) => existsSync(d));
export const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

/** 规范化技能 id：来源 + 名称。同一份库存里来源内名称唯一，因此 (来源, 名称) 唯一定位一个技能。 */
export const canonicalSkillId = (source: SkillSource, name: string) => `${source}/${name}`;

/** 技能路径落在哪个根目录下；不在任何已知根目录内返回 null（调用方按「未分配」处理）。 */
export function skillSourceOfPath(p: string): SkillSource | null {
	const r = resolve(p);
	for (const { source, dir } of skillRoots()) {
		const rel = relative(resolve(dir), r);
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return source;
	}
	return null;
}

/** 由 SKILL.md 路径 + Pi 解析出的名称得到 canonical id；不在已知根目录内返回 null。 */
export function skillIdOfPath(p: string, name: string): string | null {
	const source = skillSourceOfPath(p);
	return source ? canonicalSkillId(source, name) : null;
}

export interface Skill {
	name: string;
	description: string;
	body: string;
	builtin: boolean;
	source: SkillSource;
	/** canonical id：`来源/名称`（分配表里存的就是它） */
	id: string;
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

function readDir(dir: string, source: SkillSource): Skill[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.map((n) => join(dir, n, "SKILL.md"))
		.filter((p) => existsSync(p))
		.map((p) => {
			const s = parseSkill(readFileSync(p, "utf8"));
			const name = s.name ?? p.split(/[\\/]/).at(-2)!;
			return { name, description: s.description ?? "", body: s.body, builtin: source === "builtin", source, id: canonicalSkillId(source, name), path: p, updatedAt: statSync(p).mtimeMs };
		});
}

/**
 * 库存列表。按 Pi 的发现顺序（skillRoots 顺序）去重：同名保留第一个，和 Pi 实际加载的一致，
 * 避免「库存显示 user/foo，实际加载的却是 builtin/foo」导致启用错技能。
 */
export function listSkills(): Skill[] {
	const seen = new Set<string>();
	const out: Skill[] = [];
	for (const { source, dir } of skillRoots()) {
		for (const s of readDir(dir, source)) {
			if (seen.has(s.name)) continue;
			seen.add(s.name);
			out.push(s);
		}
	}
	return out.sort((a, b) => Number(a.builtin) - Number(b.builtin) || a.name.localeCompare(b.name));
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
