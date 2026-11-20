import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const IMPORT_LIMITS = { maxEntries: 500, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024, maxFiles: 200 };

export function safeRel(p: string): string | null {
	if (p.includes("\\") || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return null;
	const parts = p.split("/").filter(Boolean);
	return parts.length && !parts.some(s => s === ".." || s === ".") ? parts.join("/") : null;
}

export function readSkillBytes(path: string): Buffer {
	const before = lstatSync(path);
	if (!before.isFile() || before.nlink !== 1 || before.size > IMPORT_LIMITS.maxFileBytes || realpathSync(path) !== resolve(path)) throw new Error("文件不是可安全导出的普通文件，或超过大小限制");
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const st = fstatSync(fd);
		if (!st.isFile() || st.nlink !== 1 || st.dev !== before.dev || st.ino !== before.ino || st.size !== before.size) throw new Error("读取时文件已变化");
		const bytes = Buffer.alloc(st.size + 1);
		let size = 0;
		while (size < bytes.length) {
			const n = readSync(fd, bytes, size, bytes.length - size, size);
			if (!n) break;
			size += n;
		}
		if (size !== st.size || fstatSync(fd).mtimeMs !== st.mtimeMs || realpathSync(path) !== resolve(path)) throw new Error("读取时文件已变化");
		return bytes.subarray(0, size);
	} finally { closeSync(fd); }
}

export function realSkillRoot(root: string): string {
	// 配置目录的系统别名（如 macOS /var）不属于技能包；自来源目录起不允许链接。
	const path = join(realpathSync(dirname(root)), basename(root));
	if (!lstatSync(path).isDirectory()) throw new Error("技能来源目录不能是链接");
	return path;
}

export function readSkillTree(base: string): Map<string, Buffer> {
	base = join(realSkillRoot(dirname(base)), basename(base));
	const files = new Map<string, Buffer>();
	let total = 0, entries = 0;
	const paths = new Set<string>();
	function walk(dir: string, prefix = "") {
		if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== resolve(dir)) throw new Error("不支持链接目录");
		const names = readdirSync(dir);
		if (!names.length) throw new Error("现有导入器无法还原空目录");
		for (const name of names) {
			if (++entries > IMPORT_LIMITS.maxEntries) throw new Error("技能文件条目太多");
			const rel = prefix + name, path = join(dir, name);
			if (safeRel(rel) !== rel || name.startsWith("..") || /[<>:"|?*\x00-\x1f]|[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || name === "__proto__") throw new Error("含无法安全还原的文件名");
			const portable = rel.normalize("NFC").toLowerCase();
			if (paths.has(portable)) throw new Error("存在文件名大小写或 Unicode 冲突");
			paths.add(portable);
			const st = lstatSync(path);
			if (st.isDirectory()) { walk(path, `${rel}/`); continue; }
			if (files.size >= IMPORT_LIMITS.maxFiles || total + st.size > IMPORT_LIMITS.maxTotalBytes) throw new Error("技能文件超出导入上限");
			const bytes = readSkillBytes(path);
			total += bytes.length;
			files.set(rel, bytes);
		}
	}
	walk(base);
	return files;
}
