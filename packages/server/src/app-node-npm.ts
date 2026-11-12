/** App 自带 Node/npm 的统一绝对路径；npm 不经用户 PATH 查找。 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export function appNodeNpmPaths(appRoot = resolve(import.meta.dirname, "../../..")) {
	const bundled = join(appRoot, "npm", "bin", "npm-cli.js");
	const node = process.execPath;
	// 开发态只找当前 Node 分发自带的 npm，不使用另一个 PATH npm。
	const candidates = existsSync(join(appRoot, "app-version.json")) ? [bundled] : [bundled, join(dirname(node), "node_modules/npm/bin/npm-cli.js"), join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js")];
	const npm = candidates.find(existsSync);
	if (!npm) throw new Error("App 的 npm 运行环境缺失，请重新安装 App");
	return { node, npm: resolve(npm) };
}

/** 给 env-node 脚本一个私有入口；开发 Node 即使来自 Homebrew，也不把其目录放入 PATH。 */
export function prepareAppNodeBin(root: string): string {
	const runtime = join(root, "node-runtime");
	mkdirSync(runtime, { recursive: true, mode: 0o700 });
	if (lstatSync(runtime).isSymbolicLink()) throw new Error("App Node 私有目录不能是符号链接");
	const bin = join(runtime, `${process.version}-${process.arch}`);
	mkdirSync(bin, { recursive: true, mode: 0o700 });
	if (lstatSync(bin).isSymbolicLink()) throw new Error("App Node 私有目录不能是符号链接");
	const alias = join(bin, process.platform === "win32" ? "node.exe" : "node");
	let stat;
	try { stat = lstatSync(alias); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	if (process.platform === "win32") {
		if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error("App Node 入口必须为普通文件");
		if (!stat) copyFileSync(process.execPath, alias);
	} else {
		if (stat && !stat.isSymbolicLink()) throw new Error("App Node 入口必须为符号链接");
		// App 移动或替换后旧链接可能失效；只替换链接本身，不跟随或执行其目标。
		if (stat && (!existsSync(alias) || realpathSync(alias) !== realpathSync(process.execPath))) { unlinkSync(alias); stat = undefined; }
		if (!stat) symlinkSync(process.execPath, alias);
	}
	return bin;
}

export function pickNpmBin(pkg: { name: string; bin?: string | Record<string, string> }, want?: string): string | null {
	if (want) return want;
	if (!pkg.bin) return null;
	if (typeof pkg.bin === "string") return pkg.name.split("/").pop()!;
	const keys = Object.keys(pkg.bin);
	return keys.length === 1 ? keys[0] : keys.find((k) => k === pkg.name.split("/").pop()) ?? keys[0] ?? null;
}

export function npmBinPath(prefix: string, name: string, want?: string): string {
	if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error("无效 npm 包名");
	const root = join(prefix, "node_modules", name);
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const key = pickNpmBin(pkg, want);
	const entry = typeof pkg.bin === "string" ? pkg.bin : key && pkg.bin?.[key];
	if (!entry || isAbsolute(entry)) throw new Error(`${name} 没有有效可执行入口`);
	const path = realpathSync(resolve(root, entry));
	const rel = relative(realpathSync(root), path);
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("npm 可执行入口超出包目录");
	return path;
}
