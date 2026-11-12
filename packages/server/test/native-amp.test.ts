import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import { nativeAcpDefinition } from "@pi-assistant/shared";
import { NativeInstaller, type NativeRelease } from "../src/cli-agents/native-install.ts";
import { ampRuntimeCommand, ampRuntimeInstaller } from "../src/cli-agents/native-amp.ts";
import { nativeProfile } from "../src/cli-agents/native-profile.ts";
import { fakeAmpRuntime } from "./fixtures/fake-amp-runtime.ts";

const components = JSON.parse(readFileSync(resolve("../../third-party.json"), "utf8")).components;
const actual = components.find((r: { name: string }) => r.name === "amp-cli-runtime");
const key = `${process.platform}-${process.arch}`;
function release(name: string, version: string, bytes: Buffer): NativeRelease {
 return { packageName: name, version, integrity: "", source: "binary", bin: name, executable: "binary", assets: { [key]: { url: `https://official.test/${name}-${version}`, archive: "raw", entry: name, sha256: createHash("sha256").update(bytes).digest("hex") } } };
}
test("Amp 官方 runtime 固定五平台版本与 SHA；Windows ARM64 明确不支持", () => {
 assert.equal(actual.version, "0.0.1794441653-gbe68d4");
 assert.deepEqual(Object.keys(actual.assets).sort(), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"].sort());
 for (const [platform, asset] of Object.entries(actual.assets) as [string, { url: string; sha256: string; archive: string }][]) {
  assert.match(asset.url, new RegExp(`^https://static\\.ampcode\\.com/cli/${actual.version}/amp-`));
  assert.match(asset.sha256, /^[a-f0-9]{64}$/); assert.equal(asset.archive, "raw");
  if (platform.startsWith("win32")) assert.ok(asset.url.endsWith(".exe"));
 }
 assert.ok(actual.unsupportedPlatforms["win32-arm64"]); assert.equal(nativeAcpDefinition("amp-acp").unavailableReason, undefined);
});
test("Amp 双产物依序安装、缺一不就绪；固定版本检查不查 latest", async () => {
 const dir = mkdtempSync(join(tmpdir(), "amp-install-")), oldFetch = globalThis.fetch;
 const runtimeBytes = Buffer.from("offline runtime"), adapterBytes = Buffer.from("offline adapter");
 const runtimeRelease = release("amp-cli-runtime", "1.2.3", runtimeBytes), adapter = release("amp-acp", "0.12.0", adapterBytes);
 const dependency = ampRuntimeInstaller(dir, runtimeRelease);
 const installer = new NativeInstaller({ dataDir: dir, releases: { "amp-acp": adapter }, dependencies: { "amp-acp": dependency } });
 const urls: string[] = [];
 globalThis.fetch = async url => { urls.push(String(url)); return new Response(String(url).includes("amp-cli-runtime") ? runtimeBytes : adapterBytes); };
 try {
  assert.equal(installer.installed("amp-acp"), null);
  await installer.install("amp-acp");
  assert.deepEqual(urls, [runtimeRelease.assets![key].url, adapter.assets![key].url]);
  assert.ok(isAbsolute(dependency.installed("amp-acp")!.command)); assert.ok(installer.installed("amp-acp"));
  await installer.checkUpdate("amp-acp"); assert.equal(urls.length, 2);
  rmSync(dependency.installed("amp-acp")!.command);
  assert.equal(installer.installed("amp-acp"), null);
 } finally { globalThis.fetch = oldFetch; rmSync(dir, { recursive: true, force: true }); }
});
test("取消 Amp runtime 下载不进入适配器并保留旧 current", async () => {
 const dir = mkdtempSync(join(tmpdir(), "amp-cancel-")), oldFetch = globalThis.fetch;
 const bytes = Buffer.from("fake"), oldRelease = release("amp-cli-runtime", "1.0.0", bytes), next = release("amp-cli-runtime", "2.0.0", bytes), adapter = release("amp-acp", "0.12.0", bytes);
 const old = ampRuntimeInstaller(dir, oldRelease);
 globalThis.fetch = async () => new Response(bytes);
 try {
  await old.install("amp-acp"); const prior = old.installed("amp-acp")!.command;
  const dependency = ampRuntimeInstaller(dir, next);
  const installer = new NativeInstaller({ dataDir: dir, releases: { "amp-acp": adapter }, dependencies: { "amp-acp": dependency } });
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const urls: string[] = [];
  globalThis.fetch = async (url, options) => { urls.push(String(url)); entered(); return new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); };
  const pending = installer.install("amp-acp"); await ready; installer.cancel("amp-acp");
  await assert.rejects(pending, /cancelled|abort/i);
  assert.equal(urls.length, 1); assert.ok(existsSync(prior)); assert.equal(old.installed("amp-acp")!.version, "1.0.0");
  assert.equal(installer.installed("amp-acp"), null);
 } finally { globalThis.fetch = oldFetch; rmSync(dir, { recursive: true, force: true }); }
});
test("Amp 适配器下载失败或取消保留旧双产物且不重复下载 runtime", async () => {
 const dir = mkdtempSync(join(tmpdir(), "amp-adapter-cancel-")), oldFetch = globalThis.fetch;
 const bytes = Buffer.from("fake"), runtimeRelease = release("amp-cli-runtime", "1.0.0", bytes), prior = release("amp-acp", "0.11.0", bytes), next = release("amp-acp", "0.12.0", bytes);
 const dependency = ampRuntimeInstaller(dir, runtimeRelease);
 const old = new NativeInstaller({ dataDir: dir, releases: { "amp-acp": prior }, dependencies: { "amp-acp": dependency } });
 globalThis.fetch = async () => new Response(bytes);
 try {
  await old.install("amp-acp"); const command = old.installed("amp-acp")!.command;
  const installer = new NativeInstaller({ dataDir: dir, releases: { "amp-acp": next }, dependencies: { "amp-acp": dependency } });
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  globalThis.fetch = async (url, options) => { assert.equal(String(url), next.assets![key].url); entered(); return new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); };
  const pending = installer.install("amp-acp"); await ready; installer.cancel("amp-acp"); await assert.rejects(pending, /cancelled|abort/i);
  assert.equal(installer.installed("amp-acp")!.version, "0.11.0"); assert.ok(existsSync(command));
  globalThis.fetch = async () => new Response("wrong SHA");
  await assert.rejects(installer.install("amp-acp"), /SHA256/);
  assert.equal(installer.installed("amp-acp")!.version, "0.11.0"); assert.equal(dependency.installed("amp-acp")!.version, "1.0.0");
 } finally { globalThis.fetch = oldFetch; rmSync(dir, { recursive: true, force: true }); }
});
test("Amp 私有绝对路径及禁更环境强制覆盖外部输入，缺 runtime 拒绝宿主 fallback", () => {
 const dir = mkdtempSync(join(tmpdir(), "amp-env-"));
 try {
  const profile = nativeProfile("amp-acp"), input = { dataDir: dir, command: "/host/amp-acp", runDir: join(dir, "run"), extra: { AMP_CLI_PATH: "/host/amp", AMP_SKIP_UPDATE_CHECK: "0", AMP_SETTINGS_FILE: "/host/settings" } };
  assert.throws(() => profile.env(input), /官方私有运行程序/);
  const command = fakeAmpRuntime(dir, actual), env = profile.env(input);
  assert.equal(ampRuntimeCommand(dir), command); assert.equal(env.AMP_CLI_PATH, command); assert.ok(isAbsolute(env.AMP_CLI_PATH!));
  assert.equal(env.AMP_SKIP_UPDATE_CHECK, "1"); assert.equal(env.AMP_SETTINGS_FILE, join(env.HOME!, ".config/amp/settings.json"));
  profile.prepare!({ workDir: dir, dataDir: dir, runDir: dir });
  assert.deepEqual(JSON.parse(readFileSync(env.AMP_SETTINGS_FILE!, "utf8")), { "amp.updates.mode": "disabled", "amp.runner.autoUpdate.enabled": false });
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
