/** 现有 Antigravity HTTP 更新入口：临时 Mock、内存凭据、离线假 binary，无需浏览器。 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { makeManagedAgyPreload } from "./fixtures/managed-agy-binary.mjs";
import { cleanupTempRun, makeTempRun, startTempServer } from "./fixtures/temp-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const route = "/api/models/antigravity";
const version = "1.5.16";
const build = `${version}-5250855658717184`;
const options = { skip: process.platform === "win32" || !["arm64", "x64"].includes(process.arch) };

async function waitFor(read, ready, label) {
 for (let i = 0; i < 150; i++) {
  const value = await read();
  if (ready(value)) return value;
  await delay(100);
 }
 assert.fail(`等待超时：${label}`);
}

async function managed(chooseDigests, verify) {
 const port = await new Promise((resolve, reject) => {
  const s = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
   const { port } = s.address();
   s.close((error) => error ? reject(error) : resolve(port));
  });
 });
 const run = makeTempRun("pia-agy-manifest-");
 let server;
 try {
  const scenario = join(run.runDir, "scenario");
  writeFileSync(scenario, "text");
  const fake = makeManagedAgyPreload(root, join(run.runDir, "managed-agy"), scenario);
  const bytes = readFileSync(fake.archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sha512 = createHash("sha512").update(bytes).digest("hex");
  const platform = `${process.platform}-${process.arch === "arm64" ? "arm" : "x64"}`;
  const url = `https://storage.googleapis.com/antigravity-public/antigravity-cli/${build}/${platform}/cli_fake.tar.gz`;
  const manifestUrl = `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${process.platform}_${process.arch === "x64" ? "amd64" : process.arch}.json`;
  const digests = chooseDigests({ sha256, sha512 });
  const setManifest = (selectedBuild) => writeFileSync(fake.manifestOverride, JSON.stringify({
   version, url: url.replace(`/${build}/`, `/${selectedBuild}/`), ...digests,
  }));
  setManifest(build);
  const requests = () => existsSync(fake.requests) ? readFileSync(fake.requests, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const start = `http://127.0.0.1:${port}`;
  server = startTempServer({ root, port, run, extra: {
   PIA_HOST: "127.0.0.1", PIA_CLAUDE_COMMAND: "", PIA_CODEX_COMMAND: "", PIA_OPENCODE_COMMAND: "",
   NODE_OPTIONS: `--import tsx --import ${JSON.stringify(fake.preload)}`,
  } });
  const request = (path = "", method = "GET") => fetch(start + route + path, { method, signal: AbortSignal.timeout(5000) });
  const json = async (path, method) => {
   const response = await request(path, method);
   assert.ok(response.ok, `${method ?? "GET"} ${path ?? ""}: ${response.status} ${response.ok ? "" : await response.text()}`);
   return response.json();
  };
  const post = (path) => json(path, "POST");
  const status = () => json();
  const idle = () => waitFor(status, (s) => !s.operation, "受管操作结束");
  await waitFor(async () => {
   assert.equal(server.child.exitCode, null, server.logs());
   try { return (await request()).ok; } catch { return false; }
  }, Boolean, "临时服务启动");
  assert.equal((await post("/install")).started, true);
  assert.equal((await idle()).version, "1.0.0");
  assert.equal((await post("/login")).started, true);
  assert.equal((await idle()).loggedIn, true);
  const managedRoot = join(run.data, "cli-agents", "antigravity");
  const pointer = () => readFileSync(join(managedRoot, "current.json"), "utf8");
  const oldPointer = pointer();
  const home = join(managedRoot, "home");
  const login = () => readFileSync(join(home, "fake-managed-login"), "utf8");
  const assertLogin = (state) => {
   assert.equal(state.loggedIn, true);
   assert.equal(login(), "fake");
   assert.ok(!existsSync(join(run.home, "fake-managed-login")));
   const envs = readFileSync(fake.capture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
   assert.equal(envs.filter((e) => e.args.join(" ") === "acp --login").length, 1);
   assert.ok(envs.every((e) => e.home === home && e.autoUpdate === "true"));
  };
  const checked = async () => {
   const before = requests();
   await post("/check-update");
   assert.deepEqual(requests(), [...before, manifestUrl], "检查只能请求清单，不能下载包");
   return status();
  };
  const downloads = () => requests().filter((address) => address === url).length;
  const assertOld = (state) => {
   assert.equal(state.version, "1.0.0");
   assert.equal(pointer(), oldPointer);
   assert.deepEqual(readdirSync(managedRoot).filter((name) => /^\d|^\.staging-/.test(name)), ["1.0.0"]);
   assertLogin(state);
  };
  await verify({ checked, post, request, idle, downloads, requests, setManifest, assertOld, assertLogin, pointer });
 } finally {
  if (server) await server.stop();
  cleanupTempRun(run);
 }
}

test("受管更新：缺摘要仍提示 SHA256，零包下载并保留登录", options, () => managed(() => ({}), async (f) => {
 const state = await f.checked();
 assert.match(state.updateBlocked, /SHA256/);
 assert.equal(state.updateAvailable, false);
 const result = await f.request("/update", "POST");
 assert.equal(result.ok, false);
 assert.match(await result.text(), /SHA256/);
 assert.equal(f.downloads(), 0);
 f.assertOld(await f.idle());
}));

for (const [label, digests] of [
 ["仅 SHA512", ({ sha512 }) => ({ sha512 })],
 ["SHA512 + SHA256", (both) => both],
]) {
 test(`受管更新：${label} 校验原始归档，安装后不重复并保留登录`, options, () => managed(digests, async (f) => {
  const offered = await f.checked();
  assert.equal(offered.updateAvailable, true, offered.updateBlocked);
  assert.equal(offered.updateBlocked, undefined);
  assert.equal(offered.latestVersion, build);
  assert.equal(f.downloads(), 0);
  assert.equal((await f.post("/update")).started, true);
  const installed = await f.idle();
  assert.equal(installed.error, undefined);
  assert.equal(installed.version, offered.latestVersion);
  assert.equal(installed.updateAvailable, false);
  assert.equal(f.downloads(), 1);
  f.assertLogin(installed);
  const current = f.pointer();
  assert.equal((await f.checked()).updateAvailable, false);
  const repeat = await f.request("/update", "POST");
  if (repeat.ok) await repeat.json(); else await repeat.text();
  const final = await f.idle();
  assert.equal(f.downloads(), 1, "同一构建重复提交也不下载");
  assert.equal(f.pointer(), current);
  f.assertLogin(final);
  if (label === "仅 SHA512") {
   const older = `${version}-5250855658717183`;
   f.setManifest(older);
   const stale = await f.checked();
   assert.equal(stale.latestVersion, older);
   assert.equal(stale.updateBlocked, undefined);
   assert.equal(stale.updateAvailable, false, "同一版本的更早数字构建不是更新");
   const before = f.requests();
   const downgrade = await f.request("/update", "POST");
   assert.equal(downgrade.ok, false, "直接提交旧构建也必须拒绝");
   await downgrade.text();
   const preserved = await f.idle();
   assert.deepEqual(f.requests(), before, "拒绝降级不下载任何包");
   assert.equal(preserved.version, build);
   assert.equal(f.pointer(), current);
   f.assertLogin(preserved);
  }
 }));
}

for (const [field, wrong, algorithm] of [["sha512", "0".repeat(128), "SHA512"], ["sha256", "0".repeat(64), "SHA256"]]) {
 test(`受管更新：双摘要中 ${algorithm} 错误不切旧版、不动登录目录`, options, () => managed((both) => ({ ...both, [field]: wrong }), async (f) => {
  const offered = await f.checked();
  assert.equal(offered.updateAvailable, true, offered.updateBlocked);
  assert.equal(f.downloads(), 0);
  assert.equal((await f.post("/update")).started, true);
  const after = await f.idle();
  assert.equal(f.downloads(), 1);
  f.assertOld(after);
  assert.match(after.error, new RegExp(algorithm, "i"));
 }));
}
