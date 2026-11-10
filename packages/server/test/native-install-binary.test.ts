import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NativeInstaller, type NativeRelease } from "../src/cli-agents/native-install.ts";
const base = "https://storage.googleapis.com/antigravity-public/antigravity-cli/";
const manifest = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/{platform}_{arch}.json";
const key = `${process.platform}-${process.arch}`;
function release(bytes: Buffer, version = "1.0.0", archive: "binary" | "tar.gz" = "binary"): NativeRelease {
	return { packageName: "antigravity", source: "binary", executable: "binary", version, integrity: "", bin: "antigravity", updateManifest: manifest, assets: { [key]: { url: `${base}${version}/${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "arm" : process.arch}/cli_test.exe`, sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase(), archive, entry: "antigravity" } } };
}
async function fixture(fn: (f: { installer: NativeInstaller; root: string; dataDir: string; setFetch: (fetcher: typeof fetch) => void }) => Promise<void>) {
	const dataDir = mkdtempSync(join(tmpdir(), "pia-native-binary-"));
	const oldFetch = globalThis.fetch;
	const bytes = Buffer.from("fake binary never executed");
	globalThis.fetch = async () => new Response(bytes);
	const installer = new NativeInstaller({ dataDir, releases: { antigravity: release(bytes) }, run: async () => { throw new Error("binary must not use npm"); } });
	try { await fn({ installer, dataDir, root: join(dataDir, "cli-agents/antigravity"), setFetch: (fetcher) => { globalThis.fetch = fetcher; } }); }
	finally { globalThis.fetch = oldFetch; rmSync(dataDir, { recursive: true, force: true }); }
}
test("binary共用安装、并发、更新、清理，SHA失败保留旧指针和home", async () => fixture(async ({ installer, root, setFetch }) => {
	const first = installer.install("antigravity");
	assert.equal(first, installer.install("antigravity"));
	const installed = await first;
	assert.deepEqual(installed.args, []);
	assert.match(installed.command, /antigravity(?:\.exe)?$/);
	mkdirSync(join(root, "home")); writeFileSync(join(root, "home/login"), "keep");
	const pointer = readFileSync(join(root, "current.json"), "utf8");
	await assert.rejects(installer.install("antigravity", release(Buffer.from("wrong"), "2.0.0")), /SHA256/);
	assert.equal(readFileSync(join(root, "current.json"), "utf8"), pointer);
	const next = Buffer.from("new fake binary"); setFetch(async () => new Response(next));
	await installer.install("antigravity", release(next, "2.0.0"));
	assert.ok(existsSync(join(root, "1.0.0")));
	installer.cleanupOnStartup();
	assert.ok(!existsSync(join(root, "1.0.0")));
	assert.equal(readFileSync(join(root, "home/login"), "utf8"), "keep");
	assert.ok(!readdirSync(root).some((name) => name.startsWith(".staging-")));
}));
test("binary下载取消保留旧版", async () => fixture(async ({ installer, root, setFetch }) => {
	await installer.install("antigravity");
	let entered!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; });
	setFetch(async (_url, init) => new Promise((_resolve, reject) => { entered(); init!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); }));
	const job = installer.install("antigravity", release(Buffer.from("new"), "2.0.0"));
	const rejected = assert.rejects(job); await ready; installer.cancel("antigravity"); await rejected;
	assert.equal(installer.installed("antigravity")?.version, "1.0.0");
	assert.ok(!readdirSync(root).some((name) => name.startsWith(".staging-")));
}));
test("官方manifest有SHA可安装，无SHA返回阻塞原因，拒绝外部URL与版本不符", async () => fixture(async ({ installer, setFetch }) => {
	const next = release(Buffer.from("next"), "2.0.0");
	const asset = next.assets![key];
	setFetch(async () => new Response(JSON.stringify({ version: next.version, url: asset.url })));
	const blocked = await installer.checkUpdate("antigravity");
	assert.equal(blocked.version, "2.0.0"); assert.match(blocked.updateBlocked!, /SHA256/);
	await assert.rejects(installer.install("antigravity", blocked), /SHA256/);
	setFetch(async () => new Response(JSON.stringify({ version: next.version, url: asset.url, sha256: asset.sha256 })));
	assert.equal((await installer.checkUpdate("antigravity")).updateBlocked, undefined);
	setFetch(async () => new Response(JSON.stringify({ url: asset.url, sha256: asset.sha256 })));
	assert.equal((await installer.checkUpdate("antigravity")).version, next.version);
	for (const url of ["https://evil.test/2.0.0/file.exe", asset.url.replace("2.0.0", "3.0.0"), `${asset.url}?redirect=evil`]) {
		setFetch(async () => new Response(JSON.stringify({ version: next.version, url })));
		await assert.rejects(installer.checkUpdate("antigravity"), /下载地址|版本信息/);
	}
}));
test("binary拒绝无摘要、越界入口与不支持平台，且不联网", async () => fixture(async ({ installer, setFetch }) => {
	setFetch(async () => { throw new Error("unexpected network"); });
	const r = release(Buffer.from("fake"));
	await assert.rejects(installer.install("antigravity", { ...r, assets: {} }), /平台/);
	await assert.rejects(installer.install("antigravity", { ...r, assets: { [key]: { ...r.assets![key], sha256: "" } } }), /SHA256/);
	await assert.rejects(installer.install("antigravity", { ...r, assets: { [key]: { ...r.assets![key], entry: "../home" as "antigravity" } } }), /入口/);
}));
test("tar仅取antigravity，缺入口失败不切指针", { skip: process.platform === "win32" }, async () => fixture(async ({ installer, dataDir, setFetch }) => {
	const src = join(dataDir, "tar-source"); mkdirSync(src);
	writeFileSync(join(src, "antigravity"), "fake executable"); writeFileSync(join(src, "unwanted"), "do not extract");
	const tar = join(dataDir, "fake.tar.gz"); execFileSync("tar", ["czf", tar, "-C", src, "antigravity", "unwanted"]);
	const bytes = readFileSync(tar); setFetch(async () => new Response(bytes));
	const installed = await installer.install("antigravity", release(bytes, "1.0.0", "tar.gz"));
	assert.equal(readFileSync(installed.command, "utf8"), "fake executable");
	assert.ok(!existsSync(join(dataDir, "cli-agents/antigravity/1.0.0/unwanted")));
	execFileSync("tar", ["czf", tar, "-C", src, "unwanted"]);
	const bad = readFileSync(tar); setFetch(async () => new Response(bad));
	await assert.rejects(installer.install("antigravity", release(bad, "2.0.0", "tar.gz")));
	assert.equal(installer.installed("antigravity")?.version, "1.0.0");
}));
