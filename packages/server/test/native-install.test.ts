import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NativeInstaller, type NativeRelease, type NpmRun } from "../src/cli-agents/native-install.ts";
import { appNodeNpmPaths, npmBinPath } from "../src/app-node-npm.ts";
import { cancelDownload, downloadInfo } from "../src/downloads.ts";
const bytes = Buffer.from("fake official tarball");
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const release = (version = "1.0.0"): NativeRelease => ({ packageName: "@test/gemini", version, integrity, bin: "gemini" });
function fixture(runOverride?: NpmRun) {
	const dataDir = mkdtempSync(join(tmpdir(), "pia-native-install-"));
	let version = "1.0.0";
	const requests: Parameters<NpmRun>[0][] = [];
	const run: NpmRun = async (r) => {
		requests.push(r);
		if (runOverride) return runOverride(r);
		if (r.args[0] === "view") return JSON.stringify({ name: "@test/gemini", version: "2.0.0", dist: { integrity } });
		if (r.args[0] === "pack") {
			version = r.args[1].split("@").pop()!;
			writeFileSync(join(r.cwd, "package.tgz"), bytes);
			return JSON.stringify([{ filename: "package.tgz" }]);
		}
		const pkg = join(r.cwd, "node_modules/@test/gemini");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@test/gemini", version, bin: { gemini: "entry.js" } }));
		writeFileSync(join(pkg, "entry.js"), "console.log('fake')");
		return "";
	};
	const installer = new NativeInstaller({ dataDir, releases: { gemini: release(), codebuddy: { ...release(), packageName: "@test/codebuddy" } }, run });
	return { installer, dataDir, requests, clean: () => rmSync(dataDir, { recursive: true, force: true }) };
}

test("App npm优先完整内置目录，开发态使用当前Node旁的npm", () => {
	const root = mkdtempSync(join(tmpdir(), "pia-app-npm-"));
	try {
		const npm = join(root, "npm/bin/npm-cli.js");
		mkdirSync(join(root, "npm/bin"), { recursive: true });
		writeFileSync(npm, "// fake bundled npm");
		assert.deepEqual(appNodeNpmPaths(root), { node: process.execPath, npm });
		assert.ok(existsSync(appNodeNpmPaths(join(root, "development")).npm));
		const packaged = join(root, "packaged");
		mkdirSync(packaged);
		writeFileSync(join(packaged, "app-version.json"), "{}");
		assert.throws(() => appNodeNpmPaths(packaged), /npm.*缺失/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("私有安装、合并并发、更新安全切换、启动后才清旧版且保留home", async () => {
	const f = fixture();
	try {
		f.installer.registerDownloads();
		const a = f.installer.install("gemini");
		assert.equal(a, f.installer.install("gemini"));
		const installed = await a;
		assert.equal(installed.command, process.execPath);
		assert.equal(installed.version, "1.0.0");
		assert.equal(installed.verified, false); // 首发固定版本也尚未经过真实工具验收
		assert.ok(installed.args[0].endsWith("entry.js"));
		const root = join(f.dataDir, "cli-agents/gemini");
		mkdirSync(join(root, "home"));
		writeFileSync(join(root, "home/login"), "keep");
		const next = await f.installer.checkUpdate("gemini");
		assert.equal(next.version, "2.0.0");
		assert.equal((await f.installer.install("gemini", next)).verified, false);
		assert.ok(existsSync(join(root, "1.0.0")));
		f.installer.cleanupOnStartup();
		assert.ok(!existsSync(join(root, "1.0.0")));
		assert.ok(existsSync(join(root, "home/login")));
		assert.equal(downloadInfo("native:gemini")?.state, "ready");
		const env = f.requests[0].env;
		assert.ok(env.npm_config_userconfig!.startsWith(root));
		assert.ok(env.npm_config_cache!.startsWith(root));
		assert.equal(env.OPENAI_API_KEY, undefined);
		assert.equal(env.npm_config_registry, "https://registry.npmjs.org/");
	} finally { f.clean(); }
});

test("完整性错误保留旧版本，失败不切current", async () => {
	const f = fixture();
	try {
		await f.installer.install("gemini");
		await assert.rejects(f.installer.install("gemini", { ...release("2.0.0"), integrity: "sha512-YmFk" }), /完整性/);
		assert.equal(f.installer.installed("gemini")?.version, "1.0.0");
		await assert.rejects(f.installer.install("gemini", release("../home")), /无效/);
	} finally { f.clean(); }
});

test("npm入口拒绝越界，清理保留不认识的目录及版本符号链接", async () => {
	const f = fixture();
	try {
		await f.installer.install("gemini");
		const root = join(f.dataDir, "cli-agents/gemini");
		mkdirSync(join(root, "9.0.0"));
		mkdirSync(join(root, "home"));
		if (process.platform !== "win32") symlinkSync(join(root, "home"), join(root, "8.0.0"));
		f.installer.cleanupOnStartup();
		assert.ok(existsSync(join(root, "9.0.0")));
		assert.ok(existsSync(join(root, "home")));
		const pkg = join(root, "1.0.0/node_modules/@test/gemini");
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@test/gemini", bin: "../../../../current.json" }));
		assert.throws(() => npmBinPath(join(root, "1.0.0"), "@test/gemini"));
	} finally { f.clean(); }
});

test("统一下载入口可取消正在安装的同一job", async () => {
	let entered!: () => void;
	const ready = new Promise<void>((r) => { entered = r; });
	const f = fixture(async (request) => new Promise((_resolve, reject) => {
		entered();
		request.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
	}));
	try {
		f.installer.registerDownloads();
		const job = f.installer.install("gemini");
		const rejected = assert.rejects(job, /cancelled/);
		await ready;
		assert.equal(downloadInfo("native:gemini")?.state, "downloading");
		await cancelDownload("native:gemini");
		await rejected;
		assert.equal(f.installer.installed("gemini"), null);
	} finally { f.clean(); }
});
