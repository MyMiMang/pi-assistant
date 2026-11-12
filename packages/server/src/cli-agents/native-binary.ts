/** 官方 binary 的路径、归档与启动参数校验；只调用系统解压器，绝不执行下载内容。 */
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { unzipSync } from "fflate";
import type { NativeBinaryAsset, NativeRelease } from "./native-install.ts";

const maxBytes = 1024 * 1024 * 1024;
const maxEntries = 50_000;
export const binaryPlatform = () => `${process.platform}-${process.arch}`;
export const versionOk = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(v) && !v.includes("..") && !/[. ]$/.test(v) && !/^(?:home|npm-home|npm-cache|npm-runtime|npmrc|current\.json|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v);
export function safeBinaryPath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\\\x00-\x1f\x7f:<>"|?*\[\]]/.test(value) && value.split("/").every((s) => !!s && s !== "." && s !== ".." && !/[. ]$/.test(s) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s));
}
export function binaryAsset(release: NativeRelease): NativeBinaryAsset {
	const asset = release.assets?.[binaryPlatform()];
	if (!asset) throw new Error("没有适用于当前平台的安装包");
	if (asset.unsupported) throw new Error(asset.unsupported);
	const url = new URL(asset.url);
	if (url.protocol !== "https:" || url.href !== asset.url || url.username || url.password || url.search || url.hash) throw new Error("无效 binary 下载地址");
	if (!safeBinaryPath(asset.entry) || asset.entry.split("/").some((s) => s.startsWith(".pia-"))) throw new Error("binary 入口无效");
	if (!/^[a-fA-F0-9]{64}$/.test(asset.sha256) || ![undefined, "tar.gz", "tar.xz", "tar.bz2", "zip", "raw", "binary"].includes(asset.archive)) throw new Error("binary SHA256 或归档格式无效");
	if (asset.executable !== undefined && !["node", "binary"].includes(asset.executable)) throw new Error("binary 启动方式无效");
	if (asset.args !== undefined && (!Array.isArray(asset.args) || asset.args.some((a) => typeof a !== "string" || a.includes("\0") || (a.includes("{entry}") && a !== "{entry}")))) throw new Error("binary 启动参数无效");
	return asset;
}
export function binaryAssetIdentity(asset: NativeBinaryAsset): string {
	return JSON.stringify([asset.url, asset.sha256.toLowerCase(), asset.archive, asset.entry, asset.args ?? [], asset.executable, asset.unsupported]);
}
export function validateAntigravityAsset(release: NativeRelease): NativeBinaryAsset {
	const asset = binaryAsset(release);
	const base = `https://storage.googleapis.com/antigravity-public/antigravity-cli/${release.version}/`;
	const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "arm" : process.arch}`;
	if (!asset.url.startsWith(`${base}${platform}/`)) throw new Error("binary 下载地址与当前平台不符");
	if (!/^(?:darwin-arm|darwin-x64|linux-arm|linux-x64|windows-arm|windows-x64)\/cli_[A-Za-z0-9_]+\.(?:tar\.gz|exe)$/.test(asset.url.slice(base.length))) throw new Error("非官方或版本不符的 binary 下载地址");
	if (asset.entry !== "antigravity" || ![undefined, "tar.gz", "binary"].includes(asset.archive) || asset.args?.length || asset.executable === "node") throw new Error("Antigravity binary 入口无效");
	return asset;
}
function regularFile(root: string, relative: string): string {
	if (!safeBinaryPath(relative)) throw new Error("binary 入口路径无效");
	let path = root;
	const components = relative.split("/");
	for (let i = 0; i < components.length; i++) {
		path = join(path, components[i]);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || (i < components.length - 1 ? !stat.isDirectory() : !stat.isFile() || !stat.size || stat.nlink !== 1)) throw new Error("binary 入口不是有效普通文件");
	}
	return path;
}
function entryName(asset: NativeBinaryAsset): string {
	return process.platform === "win32" && asset.entry === "antigravity" && asset.url.endsWith(".exe") ? "antigravity.exe" : asset.entry;
}
export function npmLaunch(entry: string, executable: NativeRelease["executable"]): { command: string; args: string[] } {
	if (executable === "auto") {
		const stat = lstatSync(entry);
		if (!stat.isFile() || !stat.size) throw new Error("npm 入口不是普通文件");
		const header = Buffer.alloc(Math.min(stat.size, 4096));
		const fd = openSync(entry, "r");
		try { readSync(fd, header, 0, header.length, 0); } finally { closeSync(fd); }
		const magic = header.subarray(0, 4).toString("hex");
		if (["7f454c46", "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(magic) || header.subarray(0, 2).toString() === "MZ") executable = "binary";
		else if (/^#![^\r\n]*\bnode(?:\s|$)/.test(header.toString("utf8"))) executable = "node";
		else throw new Error("无法静态识别 npm 入口类型，需固定 Node 或 binary 启动方式");
	}
	return executable === "binary" ? { command: entry, args: [] } : { command: process.execPath, args: [entry] };
}
export function binaryLaunch(root: string, release: NativeRelease): { command: string; args: string[] } {
	const asset = binaryAsset(release);
	const entry = regularFile(root, entryName(asset));
	const executable = asset.executable ?? release.executable ?? "binary";
	if (executable === "auto") throw new Error("binary 归档必须明确指定启动方式");
	const args = (asset.args ?? []).map((arg) => {
		if (arg.includes("{entry}")) return arg.replaceAll("{entry}", entry);
		// 文件参数以版本根为基准；协议开关、子命令仍原样传给程序。
		const relative = arg.startsWith("./") ? arg.slice(2) : arg;
		if (safeBinaryPath(relative)) {
			if (relative.includes("/") || /\.(?:[cm]?js|json)$/i.test(relative)) return regularFile(root, relative);
			try { return regularFile(root, relative); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		if (/^(?:[A-Za-z]:|[/\\])/.test(arg) || arg.split(/[\/\\]/).includes("..")) throw new Error("binary 启动参数路径越界");
		return arg;
	});
	return { command: executable === "node" ? process.execPath : entry, args: executable === "node" && !asset.args?.some((a) => a.includes("{entry}")) ? [entry, ...args] : args };
}
interface Member { name: string; directory: boolean; mode: number; data: Buffer }
function memberValidator() {
	const seen = new Map<string, boolean>();
	const parents = new Set<string>();
	let total = 0;
	return (member: Member) => {
		const { name, directory, data } = member;
		if (!safeBinaryPath(name) || name.split("/").some((s) => s.startsWith(".pia-"))) throw new Error("归档包含不安全路径");
		const folded = name.toLowerCase();
		if (seen.has(folded) || seen.size >= maxEntries) throw new Error("归档包含重复条目或条目过多");
		if (!directory && parents.has(folded)) throw new Error("归档文件与目录冲突");
		const segments = folded.split("/");
		for (let i = 1; i < segments.length; i++) {
			const parent = segments.slice(0, i).join("/");
			if (seen.get(parent) === false) throw new Error("归档文件与目录冲突");
			parents.add(parent);
		}
		seen.set(folded, directory);
		total += data.length;
		if (total > maxBytes) throw new Error("归档解压总量超过上限");
	};
}
function tarMembers(bytes: Buffer): Member[] {
	const members: Member[] = [];
	const validate = memberValidator();
	const text = (b: Buffer) => b.toString("utf8").replace(/\0.*$/s, "");
	const octal = (b: Buffer) => {
		const s = text(b).trim();
		if (!/^[0-7]*$/.test(s)) throw new Error("tar 数值无效");
		return s ? parseInt(s, 8) : 0;
	};
	let pax: Record<string, string> | undefined;
	let longName: string | undefined;
	for (let offset = 0; offset < bytes.length;) {
		const h = bytes.subarray(offset, offset + 512);
		if (h.length !== 512) throw new Error("tar 归档不完整");
		if (h.every((b) => b === 0)) {
			if (!bytes.subarray(offset).every((b) => b === 0)) throw new Error("tar 结束后存在额外条目");
			break;
		}
		const sum = h.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
		if (sum !== octal(h.subarray(148, 156))) throw new Error("tar 校验头无效");
		let size = octal(h.subarray(124, 136));
		const type = h[156];
		if (type === 76) {
			if (longName || pax || size > 2048 || offset + 512 + size > bytes.length) throw new Error("tar 长文件名无效");
			const data = bytes.subarray(offset + 512, offset + 512 + size);
			if (data[data.length - 1] !== 0 || data.subarray(0, -1).includes(0)) throw new Error("tar 长文件名无效");
			longName = data.subarray(0, -1).toString("utf8");
			offset += 512 + Math.ceil(size / 512) * 512;
			continue;
		}
		if (type === 120) {
			if (pax || longName || size > 1024 * 1024 || offset + 512 + size > bytes.length) throw new Error("tar 扩展头无效");
			pax = Object.create(null) as Record<string, string>;
			const data = bytes.subarray(offset + 512, offset + 512 + size);
			for (let p = 0; p < data.length;) {
				const space = data.indexOf(32, p);
				const lengthText = data.subarray(p, space).toString();
				const length = Number(lengthText);
				if (space < p || !/^[1-9][0-9]*$/.test(lengthText) || length <= space - p + 2 || p + length > data.length || data[p + length - 1] !== 10) throw new Error("tar 扩展字段无效");
				const field = data.subarray(space + 1, p + length - 1).toString("utf8");
				const equal = field.indexOf("=");
				if (equal < 1) throw new Error("tar 扩展字段无效");
				const key = field.slice(0, equal), value = field.slice(equal + 1);
				if (Object.hasOwn(pax, key) || /link|sparse/i.test(key)) throw new Error("tar 扩展头包含链接或重复字段");
				pax[key] = value;
				p += length;
			}
			offset += 512 + Math.ceil(size / 512) * 512;
			continue;
		}
		if (![0, 48, 53].includes(type)) throw new Error("归档包含链接或非普通文件条目");
		if (pax?.size !== undefined) {
			if (!/^[0-9]+$/.test(pax.size)) throw new Error("tar 扩展大小无效");
			size = Number(pax.size);
		}
		const directory = type === 53;
		const prefix = text(h.subarray(345, 500));
		const rawName = longName ?? pax?.path ?? `${prefix ? `${prefix}/` : ""}${text(h.subarray(0, 100))}`;
		pax = undefined; longName = undefined;
		const name = directory ? rawName.replace(/\/$/, "") : rawName;
		if (!Number.isSafeInteger(size) || size > maxBytes || offset + 512 + size > bytes.length || (directory && size)) throw new Error("tar 文件大小无效");
		const member = { name, directory, mode: octal(h.subarray(100, 108)), data: bytes.subarray(offset + 512, offset + 512 + size) };
		validate(member); members.push(member);
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	if (pax || longName) throw new Error("tar 扩展头缺少文件");
	return members;
}
function compressedTarMembers(bytes: Buffer, staging: string): Member[] {
	const file = join(staging, ".archive.tar.compressed");
	writeFileSync(file, bytes);
	try {
		// 系统 tar 读取 xz / bz2，不执行包内脚本或下载额外解压器。
		const opts = { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" as const, stdio: "pipe" as const };
		const names = execFileSync("tar", ["tf", file], opts).trimEnd().split("\n");
		const details = execFileSync("tar", ["tvf", file], opts).trimEnd().split("\n");
		if (names.length !== details.length) throw new Error("tar 条目列表无效");
		const validate = memberValidator();
		const members = names.map((name, i) => {
			const directory = details[i].startsWith("d");
			if (!directory && !details[i].startsWith("-")) throw new Error("归档包含链接或非普通文件条目");
			const member = { name: directory ? name.replace(/\/$/, "") : name, directory, mode: /x/.test(details[i].slice(0, 10)) ? 0o755 : 0o644, data: Buffer.alloc(0) };
			validate(member);
			return member;
		});
		let total = 0;
		for (const member of members) if (!member.directory) {
			member.data = execFileSync("tar", ["xOf", file, "--", member.name], { timeout: 60_000, maxBuffer: maxBytes - total, stdio: "pipe" });
			total += member.data.length;
			if (total >= maxBytes) throw new Error("归档解压总量超过上限");
		}
		return members;
	} finally { rmSync(file, { force: true }); }
}
function zipMembers(bytes: Buffer): Member[] {
	// fflate 的输出对象会覆盖重复名字；先检查原始 central directory 的每一个条目和 Unix 类型。
	let end = bytes.length - 22;
	for (; end >= Math.max(0, bytes.length - 65557); end--) if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
	if (end < 0 || end < bytes.length - 65557) throw new Error("zip 目录无效");
	if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error("不支持分卷 zip");
	const count = bytes.readUInt16LE(end + 10);
	let offset = bytes.readUInt32LE(end + 16);
	if (count === 65535 || offset + bytes.readUInt32LE(end + 12) !== end || bytes.readUInt16LE(end + 8) !== count) throw new Error("zip 目录无效或不支持 ZIP64");
	const members: Member[] = [];
	const validate = memberValidator();
	let total = 0;
	for (let i = 0; i < count; i++) {
		if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("zip 条目无效");
		const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
		const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
		const mode = bytes.readUInt32LE(offset + 38) >>> 16;
		const name = bytes.subarray(offset + 46, offset + 46 + length).toString("utf8");
		const directory = name.endsWith("/");
		const type = mode & 0xf000;
		if ((type && type !== (directory ? 0x4000 : 0x8000)) || flags & 1 || ![0, 8].includes(method)) throw new Error("zip 包含链接或不支持的条目");
		const local = bytes.readUInt32LE(offset + 42);
		const size = bytes.readUInt32LE(offset + 24), compressed = bytes.readUInt32LE(offset + 20);
		if (local + 30 > bytes.readUInt32LE(end + 16) || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(offset + 34) || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) throw new Error("zip 本地条目无效");
		const localLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28);
		if (bytes.subarray(local + 30, local + 30 + localLength).toString("utf8") !== name || local + 30 + localLength + localExtra + compressed > bytes.readUInt32LE(end + 16) || (method === 0 && size !== compressed)) throw new Error("zip 本地条目与目录不一致");
		total += size;
		if (total > maxBytes || offset + 46 + length + extra + comment > end) throw new Error("zip 文件大小无效");
		const member = { name: directory ? name.slice(0, -1) : name, directory, mode, data: Buffer.alloc(0) };
		validate(member); members.push(member);
		offset += 46 + length + extra + comment;
	}
	if (offset !== end) throw new Error("zip 目录包含额外条目");
	const names = new Set(members.map((m) => m.directory ? `${m.name}/` : m.name));
	const contents = unzipSync(bytes, { filter: (file) => {
		if (!names.has(file.name)) throw new Error("zip 文件名编码无效");
		return true;
	} });
	for (const member of members) if (!member.directory) {
		const content = contents[member.name];
		if (!content) throw new Error("zip 文件内容缺失");
		member.data = Buffer.from(content);
	}
	return members;
}
export function extractBinary(bytes: Buffer, staging: string, release: NativeRelease, antigravity: boolean): void {
	const asset = binaryAsset(release);
	const archive = asset.archive ?? (asset.url.endsWith(".tar.gz") ? "tar.gz" : "raw");
	let members: Member[];
	if (archive === "raw" || archive === "binary") members = [{ name: entryName(asset), directory: false, mode: 0o755, data: bytes }];
	else if (archive === "zip") members = zipMembers(bytes);
	else if (archive === "tar.xz" || archive === "tar.bz2") members = compressedTarMembers(bytes, staging);
	else members = tarMembers(gunzipSync(bytes, { maxOutputLength: maxBytes }));
	for (const member of members) {
		if (antigravity && member.name !== entryName(asset)) continue;
		const path = join(staging, member.name);
		mkdirSync(member.directory ? path : dirname(path), { recursive: true, mode: 0o700 });
		if (!member.directory) writeFileSync(path, member.data, { flag: "wx", mode: member.mode & 0o111 ? 0o755 : 0o644 });
	}
	const launch = binaryLaunch(staging, release);
	if (launch.command !== process.execPath && process.platform !== "win32") chmodSync(launch.command, 0o755);
}
