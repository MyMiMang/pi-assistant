import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, linkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { zipSync, strToU8 } from "fflate";
import { NativeInstaller, type NativeBinaryAsset, type NativeRelease, type NpmRun } from "../src/cli-agents/native-install.ts";
import type { ManagedCliId } from "../src/cli-agents/native-env.ts";
const key = `${process.platform}-${process.arch}`;
const id = "cursor" as ManagedCliId;
function release(bytes: Buffer, asset: Partial<NativeBinaryAsset> = {}, version = "2026.11.05-86047df"): NativeRelease {
	return { source: "binary", packageName: "cursor", version, integrity: "", bin: "cursor-agent", executable: "binary", assets: { [key]: { url: `https://downloads.cursor.test/${version}/${key}/package`, sha256: createHash("sha256").update(bytes).digest("hex"), archive: "raw", entry: "cursor-agent", ...asset } } };
}
async function fixture(fn: (f: { dataDir: string; setBytes: (b: Buffer) => void; requests: string[]; make: (r: NativeRelease) => NativeInstaller }) => Promise<void>) {
	const dataDir = mkdtempSync(join(tmpdir(), "pia-binary-batch2-"));
	const original = globalThis.fetch;
	const requests: string[] = [];
	let bytes: Buffer = Buffer.from("downloaded content must never execute");
	globalThis.fetch = async (url) => { requests.push(String(url)); return new Response(new Uint8Array(bytes)); };
	try { await fn({ dataDir, requests, setBytes: (b) => { bytes = b; }, make: (r) => new NativeInstaller({ dataDir, releases: { [id]: r }, run: async () => { throw new Error("must not run npm or downloaded scripts"); } }) }); }
	finally { globalThis.fetch = original; rmSync(dataDir, { recursive: true, force: true }); }
}
// Minimal deterministic ustar fixtures avoid relying on host tar defaults or executing downloaded programs.
function tar(entries: { name: string; type?: string; data?: string; link?: string }[]): Buffer {
	const chunks: Buffer[] = [];
	for (const entry of entries) {
		const data = Buffer.from(entry.data ?? "");
		const header = Buffer.alloc(512);
		const field = (value: number, offset: number, length: number) => header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
		header.write(entry.name, 0, 100); field(0o755, 100, 8); field(data.length, 124, 12);
		header.fill(32, 148, 156); header.write(entry.type ?? "0", 156); header.write(entry.link ?? "", 157, 100);
		header.write("ustar\0", 257); header.write("00", 263);
		field(header.reduce((sum, b) => sum + b, 0), 148, 8);
		chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
	}
	return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
function crc32(bytes: Buffer): number {
	let crc = -1;
	for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
	return (crc ^ -1) >>> 0;
}
function customZip(entries: { name: string; mode?: number }[]): Buffer {
	const local: Buffer[] = [], central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name), data = Buffer.from("fake file");
		const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50); l.writeUInt32LE(crc32(data), 14); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(name.length, 26);
		const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x0314, 4); c.writeUInt32LE(crc32(data), 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(((entry.mode ?? 0o100755) * 65536) >>> 0, 38); c.writeUInt32LE(offset, 42);
		local.push(l, name, data); central.push(c, name); offset += l.length + name.length + data.length;
	}
	const directory = Buffer.concat(central), end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}
test("固定raw清单、日期/hash版本、下载入口和无执行；手动检查固定清单不联网", async () => fixture(async (f) => {
	const bytes = Buffer.from("#!/bin/sh\ntouch SHOULD_NOT_RUN\n"); f.setBytes(bytes);
	const r = release(bytes), installer = f.make(r); installer.registerDownloads();
	const installed = await installer.install(id);
	assert.equal(readFileSync(installed.command, "utf8"), bytes.toString()); assert.deepEqual(installed.args, []);
	assert.equal(installed.version, r.version); assert.equal(installed.verified, false);
	assert.ok(!existsSync(join(f.dataDir, "SHOULD_NOT_RUN")));
	assert.deepEqual(await installer.checkUpdate(id), r); assert.equal(f.requests.length, 1);
}));
test("tar.gz完整提取伴随文件，bundled node与相对参数展开，保留可执行位", async () => fixture(async (f) => {
	const bytes = gzipSync(tar([{ name: "bundle/", type: "5" }, { name: "bundle/node", data: "fake node" }, { name: "bundle/index.js", data: "throw Error('never execute')" }, { name: "bundle/assets/", type: "5" }, { name: "bundle/assets/data.json", data: "{}" }]));
	f.setBytes(bytes);
	const installer = f.make(release(bytes, { archive: "tar.gz", entry: "bundle/node", args: ["bundle/index.js", "acp"] }));
	const installed = await installer.install(id);
	const root = join(f.dataDir, "cli-agents", id, installed.version);
	assert.equal(installed.command, join(root, "bundle/node")); assert.deepEqual(installed.args, [join(root, "bundle/index.js"), "acp"]);
	assert.equal(readFileSync(join(root, "bundle/assets/data.json"), "utf8"), "{}");
	assert.deepEqual(installer.installed(id), installed);
}));
test("zip完整提取，App node启动和{entry}替换", async () => fixture(async (f) => {
	const bytes = Buffer.from(zipSync({ "lib/index.js": strToU8("never run"), "lib/data.json": strToU8("{}") })); f.setBytes(bytes);
	const installer = f.make(release(bytes, { archive: "zip", entry: "lib/index.js", executable: "node", args: ["{entry}"] }));
	const installed = await installer.install(id);
	assert.equal(installed.command, process.execPath); assert.equal(installed.args.length, 1); assert.match(installed.args[0], /lib[/\\]index\.js$/);
	assert.equal(readFileSync(join(installed.args[0], "../data.json"), "utf8"), "{}");
}));
for (const format of ["tar.xz", "tar.bz2"] as const) test(`${format}只调用系统解压器，完整提取普通文件`, { skip: process.platform === "win32" }, async () => fixture(async (f) => {
	const src = join(f.dataDir, "source"); mkdirSync(src); writeFileSync(join(src, "node"), "fake node"); writeFileSync(join(src, "index.js"), "never run");
	const archive = join(f.dataDir, "package.tar.xz");
	execFileSync("tar", [format === "tar.xz" ? "cJf" : "cjf", archive, "--format=ustar", "-C", src, "node", "index.js"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
	const bytes = readFileSync(archive); f.setBytes(bytes);
	const installed = await f.make(release(bytes, { archive: format, entry: "node", args: ["index.js"] })).install(id);
	assert.equal(readFileSync(installed.command, "utf8"), "fake node"); assert.equal(readFileSync(installed.args[0], "utf8"), "never run");
}));
test("清单地址/摘要/平台/入口/参数/版本/启动方式不可绕过构造时固定值", async () => fixture(async (f) => {
	const bytes = Buffer.from("fake"); f.setBytes(bytes); const r = release(bytes), a = r.assets![key], installer = f.make(r);
	for (const patch of [{ url: "https://evil.test/file" }, { sha256: "f".repeat(64) }, { entry: "../home" }, { args: ["--danger"] }, { archive: "zip" as const }, { executable: "node" as const }]) {
		await assert.rejects(installer.install(id, { ...r, assets: { [key]: { ...a, ...patch } } }));
	}
	for (const version of ["../home", "/tmp/escape", "home", "npm-cache", "2026..11", "2026.11."]) await assert.rejects(installer.install(id, { ...r, version }));
	await assert.rejects(installer.install(id, { ...r, version: "2026.11.06" }));
	await assert.rejects(installer.install(id, { ...r, assets: { "other-platform": a } }), /平台/);
	assert.equal(f.requests.length, 0);
	// Mutating the caller-owned options after construction must not change trust.
	r.assets![key].url = "https://evil.test/mutated"; await assert.rejects(installer.install(id, r), /固定/);
}));
test("SHA失败保旧指针；相同版本不同asset内容拒绝复用", async () => fixture(async (f) => {
	const bytes = Buffer.from("first"); f.setBytes(bytes); const r = release(bytes), installer = f.make(r); await installer.install(id);
	const root = join(f.dataDir, "cli-agents", id), pointer = readFileSync(join(root, "current.json"), "utf8");
	f.setBytes(Buffer.from("wrong")); await assert.rejects(installer.install(id), /SHA256/);
	assert.equal(readFileSync(join(root, "current.json"), "utf8"), pointer);
	const next = Buffer.from("second"); f.setBytes(next); await assert.rejects(f.make(release(next)).install(id), /不同内容/);
	assert.ok(!readdirSync(root).some((name) => name.startsWith(".staging-")));
}));
test("tar拒绝绝对/父路径、符号/硬链接、重复条目和大小写碰撞，包含非入口也拒绝", async () => fixture(async (f) => {
	for (const extra of [
		{ name: "../escape" }, { name: "/absolute" }, { name: "C:/escape" }, { name: "dir\\escape" },
		{ name: "link", type: "2", link: "cursor-agent" }, { name: "link", type: "1", link: "cursor-agent" },
		{ name: "cursor-agent" }, { name: "CURSOR-AGENT" }, { name: ".pia-installed.json" }, { name: "dir/../escape" },
	]) {
		const bytes = gzipSync(tar([{ name: "cursor-agent", data: "fake" }, { data: "bad", ...extra }])); f.setBytes(bytes);
		await assert.rejects(f.make(release(bytes, { archive: "tar.gz" })).install(id), /归档/);
	}
	assert.equal(existsSync(join(f.dataDir, "escape")), false);
}));
test("GNU长文件名元数据可读取，越界长文件名与长链接仍拒绝", async () => fixture(async (f) => {
	for (const name of ["bundle/" + "a".repeat(120), "../escape"]) {
		const bytes = gzipSync(tar([{ name: "cursor-agent", data: "fake" }, { name: "././@LongLink", type: "L", data: name + "\0" }, { name: "truncated", data: "long file" }])); f.setBytes(bytes);
		const job = f.make(release(bytes, { archive: "tar.gz" })).install(id);
		if (name.startsWith("..")) await assert.rejects(job, /归档/); else {
			const installed = await job;
			assert.equal(readFileSync(join(installed.command, "..", name), "utf8"), "long file");
		}
	}
}));
test("zip拒绝链接、重复原始条目、越界路径和文件/目录冲突", async () => fixture(async (f) => {
	for (const entries of [
		[{ name: "cursor-agent" }, { name: "../escape" }], [{ name: "cursor-agent", mode: 0o120777 }],
		[{ name: "cursor-agent" }, { name: "cursor-agent" }], [{ name: "cursor-agent" }, { name: "CURSOR-AGENT" }],
		[{ name: "cursor-agent" }, { name: "cursor-agent/child" }], [{ name: "cursor-agent" }, { name: "dir\\evil" }],
	]) {
		const bytes = customZip(entries); f.setBytes(bytes);
		await assert.rejects(f.make(release(bytes, { archive: "zip" })).install(id), /归档|zip/);
	}
}));
test("路径防御拒绝非法工具id、入口父目录链接、版本目录链接与硬链接", { skip: process.platform === "win32" }, async () => fixture(async (f) => {
	const bytes = Buffer.from("fake"); f.setBytes(bytes); const r = release(bytes);
	const bad = new NativeInstaller({ dataDir: f.dataDir, releases: { "../escape": r } as never });
	assert.throws(() => bad.install("../escape" as ManagedCliId), /未知/);
	assert.equal(existsSync(join(f.dataDir, "escape")), false);
	const installer = f.make(r), installed = await installer.install(id);
	const outside = join(f.dataDir, "outside"); writeFileSync(outside, "outside");
	rmSync(installed.command); linkSync(outside, installed.command); assert.equal(installer.installed(id), null);
	rmSync(installed.command); symlinkSync("/bin/sh", installed.command); assert.equal(installer.installed(id), null);
	const versionRoot = join(f.dataDir, "cli-agents", id, installed.version);
	rmSync(versionRoot, { recursive: true }); symlinkSync(f.dataDir, versionRoot); assert.equal(installer.installed(id), null);
	await assert.rejects(installer.install(id), /符号链接/);
}));
test("npm auto静态判型Node/ELF/PE/Mach-O及postinstall替换，无执行且GROK_HOME私有", async () => fixture(async (f) => {
	const packed = Buffer.from("fake npm archive");
	const integrity = `sha512-${createHash("sha512").update(packed).digest("base64")}`;
	const contents = [Buffer.from("#!/usr/bin/env node\nthrow Error('never run')"), Buffer.from("7f454c4601020304", "hex"), Buffer.from("MZ fake PE"), Buffer.from("cffaedfe01020304", "hex")];
	for (let index = 0; index < contents.length; index++) {
		const version = `1.0.${index}`;
		const run: NpmRun = async (request) => {
			assert.equal(request.env.GROK_HOME, join(f.dataDir, "cli-agents/grok-build/home/.grok"));
			assert.notEqual(request.env.GROK_HOME, request.env.HOME);
			if (request.args[0] === "pack") { writeFileSync(join(request.cwd, "package.tgz"), packed); return '[{"filename":"package.tgz"}]'; }
			const pkg = join(request.cwd, "node_modules/@test/grok"); mkdirSync(pkg, { recursive: true });
			writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@test/grok", version, bin: { grok: "grok" } }));
			writeFileSync(join(pkg, "grok"), contents[index]);
			return "";
		};
		const installer = new NativeInstaller({ dataDir: f.dataDir, releases: { "grok-build": { packageName: "@test/grok", version, integrity, bin: "grok", executable: "auto" } }, run });
		const installed = await installer.install("grok-build");
		assert.equal(installed.command === process.execPath, index === 0);
		assert.equal(installed.args.length, index === 0 ? 1 : 0);
	}
}));
test("清单在下载期间被外部修改不会改变入口和启动参数", async () => fixture(async (f) => {
	const bytes = Buffer.from("fake"); f.setBytes(bytes); const r = release(bytes), installer = f.make(r);
	const job = installer.install(id, r);
	r.assets![key].entry = "../escape"; r.assets![key].args = ["--mutated"];
	const installed = await job;
	assert.match(installed.command, /cursor-agent$/); assert.deepEqual(installed.args, []);
}));
