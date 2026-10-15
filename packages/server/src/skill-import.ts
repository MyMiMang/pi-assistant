/**
 * 技能外部导入：本地目录 / 单个 SKILL.md / zip。
 *
 * 安全边界：
 *  - 只读 `SKILL.md` 的 frontmatter 与正文，**不解析也不执行**技能里的脚本；
 *  - zip 防 `../`、绝对路径 / 盘符、反斜杠、symlink（只写普通文件）、zip bomb（条目数 / 单文件 / 总量上限）；
 *  - 同名内容不同**不静默覆盖**：返回冲突，由用户选 update（覆盖同名 external）或 rename（换新名）。
 *  - 导入落 `dataDir/skills-external/<name>/`，与用户自建（`skills/`）分开；同一份库存只放一处。
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { externalSkillsDir, listSkills, NAME_RE, notifySkillsChanged, parseSkill } from "./skills.ts";

export const IMPORT_LIMITS = { maxEntries: 500, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024, maxFiles: 200 };

export interface ImportedSkill {
	name: string;
	description: string;
	id: string;
	path: string;
	files: number;
	/** 同内容命中已有技能，直接复用（没有新写文件） */
	reused?: boolean;
}

export class ImportConflict extends Error {
	constructor(
		readonly existing: { id: string; name: string; description: string },
		readonly incoming: { name: string; description: string },
	) {
		super(`同名技能「${existing.name}」内容不同`);
	}
}

export interface ImportOptions {
	/** conflict（默认，报冲突）/ update（覆盖同名 external）/ rename（用 newName 存新技能） */
	mode?: "conflict" | "update" | "rename";
	newName?: string;
}

/** zip / 目录里的相对路径是否安全（拒绝绝对路径、盘符、反斜杠、.. 段）。 */
function safeRel(p: string): string | null {
	const norm = p.replace(/\\/g, "/");
	if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)) return null;
	const parts = norm.split("/").filter((s) => s.length > 0);
	if (!parts.length || parts.some((s) => s === ".." || s === ".")) return null;
	return parts.join("/");
}

function checkName(name: string) {
	const n = name.trim().toLowerCase();
	if (!NAME_RE.test(n)) throw new Error("技能名只能用小写字母、数字和连字符（例如 weekly-report），最长 64 个字符");
	return n;
}

/** 从文件集合（相对路径 → 文本）里定位 SKILL.md，返回技能根目录与内容。 */
function locateSkill(files: Record<string, string>): { root: string; md: string } {
	const candidates = Object.keys(files)
		.filter((p) => p === "SKILL.md" || p.endsWith("/SKILL.md"))
		.sort((a, b) => a.split("/").length - b.split("/").length);
	if (!candidates.length) throw new Error("压缩包 / 目录里没有找到 SKILL.md");
	const skillMd = candidates[0];
	const root = skillMd === "SKILL.md" ? "" : skillMd.slice(0, -"SKILL.md".length);
	return { root, md: files[skillMd] };
}

/** 把 frontmatter 里的 name 改成目标名（rename / 目录名与声明名不一致时），保留其它字段（license / metadata 等）。 */
function withName(md: string, name: string): string {
	const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return `---\nname: ${name}\n---\n\n${md}`;
	const fm = /^name:\s*.*$/m.test(m[1]) ? m[1].replace(/^name:\s*.*$/m, `name: ${name}`) : `name: ${name}\n${m[1]}`;
	return md.replace(m[0], `---\n${fm}\n---`);
}

/** 提交：按 name 写入 externalSkillsDir；同名冲突 / 更新 / 改名都在这里处理。 */
function commit(files: Record<string, string>, opts: ImportOptions): ImportedSkill {
	const { root, md } = locateSkill(files);
	const parsed = parseSkill(md);
	const dirName = root ? root.split("/").filter(Boolean).at(-1) ?? "" : "";
	const name = checkName(opts.mode === "rename" && opts.newName ? opts.newName : parsed.name ?? dirName);
	if (!parsed.description?.trim()) throw new Error("SKILL.md 缺少 description（Pi 用描述判断何时加载技能）");

	const existing = listSkills().find((s) => s.name === name);
	if (existing) {
		const same = existing.description.trim() === (parsed.description ?? "").trim() && existing.body.trim() === parsed.body.trim();
		if (same) return { name: existing.name, description: existing.description, id: existing.id, path: existing.path, files: 0, reused: true };
		// 内置 / 用户自建不能静默覆盖：只能换名
		if (existing.source !== "external" || opts.mode !== "update") throw new ImportConflict({ id: existing.id, name: existing.name, description: existing.description }, { name, description: parsed.description });
	}

	const target = join(externalSkillsDir(), name);
	if (existing?.source === "external" && opts.mode === "update") rmSync(target, { recursive: true, force: true });
	const skillMdPath = root ? `${root}SKILL.md` : "SKILL.md";
	const underRoot = Object.entries(files).filter(([p]) => (root ? p.startsWith(root) : true));
	let written = 0;
	for (const [p, text] of underRoot) {
		const rel = safeRel(root ? p.slice(root.length) : p);
		if (!rel) continue;
		const dest = join(target, rel);
		// 兜底：确保目标始终在技能目录内（safeRel 已挡住 .. / 绝对路径）
		const r = relative(target, dest);
		if (!r || r.startsWith("..") || isAbsolute(r)) continue;
		mkdirSync(join(dest, ".."), { recursive: true });
		writeFileSync(dest, p === skillMdPath ? withName(text, name) : text);
		written++;
	}
	if (written) notifySkillsChanged();
	return { name, description: parsed.description.trim(), id: `external/${name}`, path: join(target, "SKILL.md"), files: written };
}

/** 导入本地目录或单个 SKILL.md 文件。 */
export function importSkillFromPath(inputPath: string, opts: ImportOptions = {}): ImportedSkill {
	const abs = resolve(inputPath);
	if (!existsSync(abs)) throw new Error(`路径不存在：${inputPath}`);
	const st = lstatSync(abs);
	const files: Record<string, string> = {};
	if (st.isSymbolicLink()) throw new Error("不支持符号链接，请指向真实目录或文件");
	if (st.isFile()) {
		if (statSync(abs).size > IMPORT_LIMITS.maxFileBytes) throw new Error("文件太大");
		files["SKILL.md"] = readFileSync(abs, "utf8");
		return commit(files, opts);
	}
	const base = abs;
	let total = 0;
	const walk = (dir: string) => {
		for (const n of readdirSync(dir)) {
			const p = join(dir, n);
			const s = lstatSync(p);
			if (s.isSymbolicLink()) continue; // 不跟随链接
			if (s.isDirectory()) {
				walk(p);
				continue;
			}
			if (!s.isFile()) continue;
			if (Object.keys(files).length >= IMPORT_LIMITS.maxFiles) throw new Error("文件太多");
			if (s.size > IMPORT_LIMITS.maxFileBytes) throw new Error(`文件太大：${n}`);
			total += s.size;
			if (total > IMPORT_LIMITS.maxTotalBytes) throw new Error("内容总量超过上限");
			files[safeRel(relative(base, p)) ?? n] = readFileSync(p, "utf8");
		}
	};
	walk(base);
	return commit(files, opts);
}

/** 导入 zip（内存解压，先按 central directory 的原始大小做 bomb 防护）。 */
export async function importSkillFromZip(buf: Uint8Array, opts: ImportOptions = {}): Promise<ImportedSkill> {
	const { unzipSync, strFromU8 } = await import("fflate");
	let rejected = "";
	let count = 0;
	let total = 0;
	let out: Record<string, Uint8Array>;
	try {
		out = unzipSync(buf, {
			filter: (f) => {
				if (rejected) return false;
				if (++count > IMPORT_LIMITS.maxEntries) {
					rejected = "压缩包条目太多";
					return false;
				}
				if (f.name.endsWith("/")) return false;
				if (!safeRel(f.name)) {
					rejected = `压缩包里有不安全的路径：${f.name}`;
					return false;
				}
				if (f.originalSize > IMPORT_LIMITS.maxFileBytes) {
					rejected = `压缩包里有文件过大：${f.name}`;
					return false;
				}
				total += f.originalSize;
				if (total > IMPORT_LIMITS.maxTotalBytes) {
					rejected = "压缩包解压后总量超过上限";
					return false;
				}
				return true;
			},
		});
	} catch (e) {
		throw new Error(`无法读取压缩包：${e instanceof Error ? e.message : String(e)}`);
	}
	if (rejected) throw new Error(rejected);
	const files: Record<string, string> = {};
	for (const [p, data] of Object.entries(out)) {
		const rel = safeRel(p);
		if (!rel) continue;
		if (Object.keys(files).length >= IMPORT_LIMITS.maxFiles) throw new Error("文件太多");
		files[rel] = strFromU8(data);
	}
	return commit(files, opts);
}
