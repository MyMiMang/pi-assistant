import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { NATIVE_ACP_AGENTS, nativeAcpDefinition } from "@pi-assistant/shared";
import { NativeInstaller, type NativeRelease } from "../src/cli-agents/native-install.ts";
import { nativeProfile } from "../src/cli-agents/native-profile.ts";
import { detectNative, authenticateNative, terminalMethods } from "../src/cli-agents/native-auth.ts";
import { fakeAmpRuntime } from "./fixtures/fake-amp-runtime.ts";

const manifest = JSON.parse(readFileSync(resolve("../../third-party.json"), "utf8")).components as Array<NativeRelease & { name: string }>;
const bytes = Buffer.from("offline fake package; never executed");
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

test("17项只有一张配置表，固定供应链来源完整且不包含pi-acp", () => {
 assert.equal(NATIVE_ACP_AGENTS.length, 17);
 assert.equal(new Set(NATIVE_ACP_AGENTS.map(a => a.id)).size, 17);
 assert.ok(!NATIVE_ACP_AGENTS.some(a => String(a.id).includes("pi-acp")));
 for (const agent of NATIVE_ACP_AGENTS) {
  const release = manifest.find(r => r.name === agent.packageName)!;
  assert.ok(release, agent.id);
  if (release.source === "binary") for (const asset of Object.values(release.assets ?? {})) {
   assert.match(asset.sha256, /^[a-f0-9]{64}$/i, agent.id); assert.ok(asset.url.startsWith("https://"));
  } else assert.match(release.integrity, /^sha512-/);
 }
});
for (const agent of NATIVE_ACP_AGENTS) {
 test(`${agent.name} 启动参数和私有隔离变量由表驱动，二次环境不能覆盖`, () => {
  const dir = mkdtempSync(join(tmpdir(), "native-catalog-env-"));
  try {
   if (agent.id === "amp-acp") fakeAmpRuntime(dir, manifest.find(r => r.name === "amp-cli-runtime")!);
   const profile = nativeProfile(agent.id);
   const input = { dataDir: dir, command: process.execPath, runDir: join(dir, "run"), baseEnv: { HOME: "/real", OPENAI_API_KEY: "secret", XAI_API_KEY: "secret" }, extra: { HOME: "/escape", ...Object.fromEntries(Object.keys(agent.environment).map(k => [k, "/escape"])) } };
   const env = profile.env(input);
   assert.deepEqual(profile.args("/work"), agent.args);
   assert.equal(env.HOME, join(dir, "cli-agents", agent.id, "home"));
   assert.equal(env.USERPROFILE, env.HOME); assert.ok(env.XDG_CONFIG_HOME!.startsWith(env.HOME!));
   assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.XAI_API_KEY, undefined);
   for (const [key, value] of Object.entries(agent.environment)) assert.equal(env[key], value.replaceAll("{home}", env.HOME!));
  } finally { rmSync(dir, { recursive: true, force: true }); }
 });
 test(`${agent.name} 安装请求只走离线假npm或固定binary，不执行产物`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "native-catalog-install-")); const oldFetch = globalThis.fetch;
  const actual = manifest.find(r => r.name === agent.packageName)!;
  const release: NativeRelease = { ...actual, packageName: agent.packageName, version: "1.2.3", integrity, ...(actual.source === "binary" ? { assets: { [`${process.platform}-${process.arch}`]: { url: "https://official.test/tool-1.2.3", sha256: createHash("sha256").update(bytes).digest("hex"), entry: "fake", archive: "binary" } } } : {}) };
  const requests: string[][] = [];
  globalThis.fetch = async url => { assert.equal(String(url), "https://official.test/tool-1.2.3"); return new Response(bytes); };
  const installer = new NativeInstaller({ dataDir: dir, releases: { [agent.id]: release }, run: async request => {
   requests.push(request.args); assert.equal(request.env.OPENAI_API_KEY, undefined);
   if (request.args[0] === "pack") { assert.equal(request.args[1], `${agent.packageName}@1.2.3`); writeFileSync(join(request.cwd, "fake.tgz"), bytes); return JSON.stringify([{ filename: "fake.tgz" }]); }
   const pkg = join(request.cwd, "node_modules", agent.packageName); mkdirSync(pkg, { recursive: true });
   writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: agent.packageName, version: "1.2.3", bin: { [release.bin]: "entry.js" } }));
   writeFileSync(join(pkg, "entry.js"), "#!/usr/bin/env node\n// fake"); return "";
  } });
  try { const installed = await installer.install(agent.id); assert.equal(installed.version, "1.2.3"); assert.equal(requests.length, actual.source === "binary" ? 0 : 2); }
  finally { globalThis.fetch = oldFetch; rmSync(dir, { recursive: true, force: true }); }
 });
 test(`${agent.name} 只读模型发现使用相同私有环境与启动参数`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "native-catalog-detect-")), log = join(dir, "probe.jsonl");
  const profile = nativeProfile(agent.id);
  try {
   if (agent.id === "amp-acp") fakeAmpRuntime(dir, manifest.find(r => r.name === "amp-cli-runtime")!);
   const input = { id: agent.id, dataDir: dir, command: process.execPath, args: [resolve("test/fixtures/fake-native-acp.mjs")], profile: { ...profile, env: (value: Parameters<typeof profile.env>[0]) => ({ ...profile.env(value), FAKE_NATIVE_LOG: log }) } };
   if (nativeAcpDefinition(agent.id).unavailableReason) { await assert.rejects(detectNative(input), /缺少独立受管/); return; }
   const result = await detectNative(input);
   assert.equal(result.loggedIn, true); assert.equal(result.models.length, 2);
   const entries = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
   assert.deepEqual(entries[0].argv, agent.args); assert.equal(entries[0].env.HOME, join(dir, "cli-agents", agent.id, "home"));
   assert.ok(entries.every(e => !["session/prompt", "authenticate"].includes(e.method)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
 });
}
test("私有更新配置保留用户其他字段，重复准备不累加TOML设置", () => {
 const dir = mkdtempSync(join(tmpdir(), "native-settings-"));
 try {
  for (const id of ["devin", "mistral-vibe", "qwen-code", "amp-acp"] as const) {
   const profile = nativeProfile(id); const workDir = join(dir, "work"); mkdirSync(workDir, { recursive: true });
   const input = { workDir, dataDir: dir, runDir: workDir }; profile.prepare!(input); profile.prepare!(input);
   const settings = nativeAcpDefinition(id).settings!;
   const file = join(dir, "cli-agents", id, "home", settings.path);
   const raw = readFileSync(file, "utf8");
   if (settings.format === "toml") assert.equal(raw.match(/enable_update_checks/g)?.length, 1);
   else {
    const saved = JSON.parse(raw); saved.keep = true; writeFileSync(file, JSON.stringify(saved)); profile.prepare!(input);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).keep, true);
   }
  }
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("Terminal Auth广告和API-key仅配置提示；官方终端接到同一个私有环境", { skip: process.platform === "win32" }, async () => {
 const dir = mkdtempSync(join(tmpdir(), "native-terminal-"));
 const output = join(dir, "terminal.json"), fake = join(dir, "tool.mjs");
 writeFileSync(fake, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';import{createInterface}from'node:readline';if(process.argv.includes('--login')){writeFileSync(${JSON.stringify(output)},JSON.stringify({env:process.env,args:process.argv.slice(2)}));process.exit(0)}createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{authMethods:[{id:'login',type:'terminal',args:['--login'],env:{HOME:'/escape',OPENAI_API_KEY:'secret'}}]}}))});\n`); chmodSync(fake, 0o755);
 try {
  assert.equal(terminalMethods([{ type: "terminal", args: ["--login"] }]).length, 1);
  await authenticateNative({ id: "goose", dataDir: dir, command: process.execPath, args: [fake], terminalLaunch: script => ({ command: "/bin/sh", args: [script] }) });
  const capture = JSON.parse(readFileSync(output, "utf8")); assert.equal(capture.env.HOME, join(dir, "cli-agents/goose/home")); assert.equal(capture.env.OPENAI_API_KEY, undefined);
  assert.deepEqual(capture.args, ["acp", "--login"]);
  const profile = nativeProfile("goose");
  const input = { id: "goose" as const, dataDir: dir, command: process.execPath, args: [resolve("test/fixtures/fake-native-acp.mjs")], profile: { ...profile, env: (i: Parameters<typeof profile.env>[0]) => ({ ...profile.env(i), FAKE_NATIVE_SCENARIO: "auth-api-key" }) } };
  assert.equal((await detectNative(input)).authType, "api-key");
  await assert.rejects(authenticateNative(input), /需要在工具里配置/);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
