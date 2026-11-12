import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { test } from "node:test";
import { NATIVE_ACP_AGENTS } from "@pi-assistant/shared";
import { buildNativeAcpEnv, type ManagedCliId } from "../src/cli-agents/native-env.ts";
import { nativeProfile } from "../src/cli-agents/native-profile.ts";
import { managedCliEnv } from "../src/cli-agents/managed-env.ts";
import { buildClaudeEnv, buildCliEnv } from "../src/cli-agents/launch.ts";
import { buildCodexEnv } from "../src/cli-agents/codex-launch.ts";
import { buildAgyEnv } from "../src/cli-agents/agy-launch.ts";
import { buildOpencodeEnv } from "../src/cli-agents/opencode-launch.ts";
import { NativeInstaller, type NativeRelease } from "../src/cli-agents/native-install.ts";
import { fakeAmpRuntime } from "./fixtures/fake-amp-runtime.ts";
import { prepareAppNodeBin } from "../src/app-node-npm.ts";

const ids: ManagedCliId[] = [...NATIVE_ACP_AGENTS.map(a => a.id), "claude-code", "codex", "opencode", "antigravity"];
const dirty = { HOME: "/user", PATH: "/user/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin", Path: "C:\\Users\\user\\AppData\\Roaming\\npm", npm_config_prefix: "/user/npm", NPM_CONFIG_USERCONFIG: "/user/.npmrc", Npm_Config_Globalconfig: "/user/globalrc", NPM_CONFIG_CACHE: "/user/cache", SystemRoot: "C:\\evil", OPENAI_API_KEY: "secret" };
const { OPENAI_API_KEY: _secret, ...unsafePaths } = dirty;
const extra = { ...unsafePaths, pAtH: "/escape/bin", npm_config_registry: "https://evil.invalid", NPM_CONFIG_UPDATE_NOTIFIER: "true", npm_config_global: "true", npm_config_node_options: "--require=/escape.js" };
function check(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform, originalPath: string | null = dirty.PATH) {
 for (const key of ["prefix", "userconfig", "globalconfig", "cache"]) {
  const value = env[`npm_config_${key}`]!;
  assert.ok(value.startsWith(join(home, ".npm-private")), `${key}: ${value}`);
  assert.ok(existsSync(value), value);
 }
 assert.equal(readFileSync(env.npm_config_userconfig!, "utf8"), "");
 assert.equal(readFileSync(env.npm_config_globalconfig!, "utf8"), "");
 assert.notEqual(env.npm_config_userconfig, env.npm_config_globalconfig);
 assert.equal(env.npm_config_update_notifier, "false");
 assert.equal(env.npm_config_registry, "https://registry.npmjs.org/");
 assert.equal(env.npm_config_global, undefined); assert.equal(env.npm_config_node_options, undefined);
 assert.equal(env.HOME, home); assert.equal(env.OPENAI_API_KEY, undefined);
 for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("NPM_CONFIG_")) assert.equal(key, key.toLowerCase());
 assert.deepEqual(Object.keys(env).filter(k => k.toUpperCase() === "PATH"), ["PATH"]);
 const dirs = env.PATH!.split(platform === "win32" ? ";" : ":");
 assert.ok(dirs[0].startsWith(join(home, ".npm-private", "node-runtime")));
 if (originalPath !== null) assert.deepEqual(dirs.slice(1), [...new Set(originalPath.split(platform === "win32" ? ";" : ":").filter(Boolean))]);
 else if (platform === "win32") assert.deepEqual(dirs.slice(1), [win32.join(process.platform === "win32" ? process.env.SystemRoot ?? "C:\\Windows" : "C:\\Windows", "System32"), process.platform === "win32" ? process.env.SystemRoot ?? "C:\\Windows" : "C:\\Windows"]);
 else assert.deepEqual(dirs.slice(1), ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
}
for (const id of ids) for (const platform of ["darwin", "win32", "linux"] as const) test(`${id}/${platform}：私有npm和PATH抵抗继承、extra、大小写别名及二次白名单`, t => {
 const dataDir = mkdtempSync(join(tmpdir(), "managed-runtime-"));
 t.after(() => rmSync(dataDir, { recursive: true, force: true }));
 const home = join(dataDir, "cli-agents", id, "home");
 const input = { dataDir, id, baseEnv: dirty, extra, platform, realHome: "/user", command: platform === "win32" ? "C:\\Users\\user\\npm\\node.exe" : "/opt/homebrew/opt/node/bin/node" };
 const env = id === "opencode" ? buildOpencodeEnv(input) : managedCliEnv(dataDir, id, input);
 check(env, home, platform);
 for (const build of [buildClaudeEnv, buildCodexEnv]) {
  const again = build({ baseEnv: env, extra, realHome: "/user", platform, command: input.command });
  check(again, home, platform);
  check(build({ baseEnv: again, extra, platform }), home, platform);
 }
 if (id === "antigravity") check(buildAgyEnv({ ...input, baseEnv: env }), home, platform);
 if (id === "opencode") check(buildOpencodeEnv({ ...input, baseEnv: env }), home, platform);
});
for (const agent of NATIVE_ACP_AGENTS) test(`${agent.id}：真实profile保留npm最终边界`, t => {
 const dataDir = mkdtempSync(join(tmpdir(), "profile-runtime-")); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
 if (agent.id === "amp-acp") {
  const manifest = JSON.parse(readFileSync(resolve("../../third-party.json"), "utf8")).components as Array<NativeRelease & { name: string }>;
  fakeAmpRuntime(dataDir, manifest.find(release => release.name === "amp-cli-runtime")!);
 }
 check(nativeProfile(agent.id).env({ dataDir, runDir: dataDir, command: process.execPath, baseEnv: dirty, extra }), join(dataDir, "cli-agents", agent.id, "home"), process.platform);
});
test("私有App Node优先运行env-node脚本，绝对npm仍使用私有prefix", { skip: process.platform === "win32" }, async t => {
 const dataDir = mkdtempSync(join(tmpdir(), "managed-node-")); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
 const env = buildNativeAcpEnv({ dataDir, id: "gemini", baseEnv: dirty, command: process.execPath });
 const script = join(dataDir, "probe.mjs");
 writeFileSync(script, "#!/usr/bin/env node\nconsole.log(process.execPath)\n"); chmodSync(script, 0o755);
 const out = spawnSync(script, [], { env, encoding: "utf8" });
 assert.equal(out.status, 0, out.stderr); assert.equal(realpathSync(out.stdout.trim()), realpathSync(process.execPath));
 const { appNodeNpmPaths } = await import("../src/app-node-npm.ts");
 const runtime = appNodeNpmPaths();
 const npm = spawnSync(runtime.node, [runtime.npm, "config", "get", "prefix"], { env, cwd: dataDir, encoding: "utf8" });
 assert.equal(npm.status, 0, npm.stderr); assert.equal(npm.stdout.trim(), env.npm_config_prefix);
});
test("所有工具的安装npm同样只有私有prefix/cache/config与App Node目录", t => {
 const dataDir = mkdtempSync(join(tmpdir(), "install-runtime-")); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
 const release = { packageName: "@test/x", version: "1.0.0", integrity: "sha512-AAAA", bin: "x" };
 const installer = new NativeInstaller({ dataDir, releases: Object.fromEntries(ids.map(id => [id, release])) });
 for (const id of ids) check(installer.npmEnvironment(id), join(dataDir, "cli-agents", id, "npm-home"), process.platform, null);
});
for (const platform of ["darwin", "linux", "win32"] as const) for (const pathKey of ["PATH", "Path", "pAtH"]) test(`${platform}/${pathKey}：私有bin、受管目录、原PATH依次排列去重，不补common dirs`, t => {
 const dataDir = mkdtempSync(join(tmpdir(), "managed-command-")); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
 const home = join(dataDir, "cli-agents", "gemini", "home");
 const pathLib = platform === "win32" ? win32 : { dirname };
 const command = join(dataDir, "cli-agents", "gemini", "1.2.3", "bin", "gemini");
 const privateBin = prepareAppNodeBin(join(home, ".npm-private"));
 const sep = platform === "win32" ? ";" : ":";
 const originalDirs = platform === "win32" ? ["C:\\User Tools\\bin", "C:\\Windows\\System32", "c:\\user tools\\BIN"] : ["/opt/homebrew/bin", "/User Tools/bin", "/opt/homebrew/bin"];
 const originalPath = [privateBin, pathLib.dirname(command), ...originalDirs].join(sep);
 const env = buildNativeAcpEnv({ dataDir, id: "gemini", command, platform, realHome: "/user", baseEnv: { [pathKey]: originalPath }, extra });
 const expected = [privateBin, pathLib.dirname(command), ...originalDirs.slice(0, 2)].join(sep);
 assert.equal(env.PATH, expected);
 assert.deepEqual(Object.keys(env).filter(k => k.toUpperCase() === "PATH"), ["PATH"]);
 for (const build of [buildClaudeEnv, buildCodexEnv]) assert.equal(build({ baseEnv: env, extra, platform }).PATH, expected);
});
for (const originalPath of [undefined, "", "/custom/bin:/custom/bin"]) test(`原PATH=${String(originalPath)}：不以common dirs或系统目录补足运行环境`, t => {
 const dataDir = mkdtempSync(join(tmpdir(), "managed-original-path-")); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
 const env = buildNativeAcpEnv({ dataDir, id: "gemini", platform: "darwin", realHome: "/user", command: "/external/bin/tool", baseEnv: originalPath === undefined ? {} : { PATH: originalPath }, extra });
 assert.deepEqual(env.PATH!.split(":"), [prepareAppNodeBin(join(dataDir, "cli-agents", "gemini", "home", ".npm-private")), ...(originalPath ? ["/custom/bin"] : [])]);
});
test("私有npmrc不沿符号链接读取或覆盖用户配置", { skip: process.platform === "win32" }, t => {
 const dataDir = mkdtempSync(join(tmpdir(), "managed-rc-link-")); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
 const input = { dataDir, id: "gemini" as const, baseEnv: dirty };
 const env = buildNativeAcpEnv(input), userRc = join(dataDir, "user.npmrc");
 writeFileSync(userRc, "prefix=/user/global\n"); rmSync(env.npm_config_userconfig!);
 symlinkSync(userRc, env.npm_config_userconfig!);
 assert.throws(() => buildNativeAcpEnv(input), /普通文件/);
 assert.equal(readFileSync(userRc, "utf8"), "prefix=/user/global\n");
});
test("普通非受管CLI仍保留原PATH和额外变量语义", () => {
 const env = buildCliEnv({ baseEnv: dirty, realHome: "/user", platform: "darwin", extra: { npm_config_prefix: "/explicit" } }, [], {});
 assert.ok(env.PATH!.startsWith(dirty.PATH)); assert.ok(env.PATH!.includes("/opt/homebrew/bin"));
 assert.equal(env.npm_config_prefix, "/explicit");
});
