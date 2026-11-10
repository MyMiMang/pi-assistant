import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runManagedLogin } from "../src/cli-agents/managed-auth.ts";
import { terminalAuth, terminalAuthCommand } from "../src/cli-agents/terminal-auth.ts";

test("官方登录进程可以取消，不需要真实账号或网络", async () => {
 const dataDir = mkdtempSync(join(tmpdir(), "pia-login-test-"));
 try {
  const script = join(dataDir, "fake.mjs");
  writeFileSync(script, "setInterval(() => {}, 1000)");
  const controller = new AbortController();
  const pending = runManagedLogin({ id: "codex", command: process.execPath, args: [script], dataDir, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, /取消/);
 } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
test("假终端执行官方命令并可取消登录进程组", async () => {
 const root = mkdtempSync(join(tmpdir(), "pia-terminal-test-"));
 try {
  const fake = join(root, "fake.cjs");
  writeFileSync(fake, "setInterval(()=>{},1000)");
  const controller = new AbortController();
  const pending = terminalAuth({ command: process.execPath, args: [fake], env: { PATH: "/usr/bin:/bin" }, root, signal: controller.signal, launch: script => ({ command: "/bin/sh", args: [script] }) });
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(pending, /取消/);
 } finally { rmSync(root, { recursive: true, force: true }); }
});
test("Antigravity 官方终端登录参数和隔离环境一致，取消不触碰用户配置", async () => {
 const dataDir = mkdtempSync(join(tmpdir(), "pia-agy-login-"));
 try {
  const fake = join(dataDir, "fake.cjs"), capture = join(dataDir, "capture.json");
  writeFileSync(fake, `require('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),env:process.env}));setInterval(()=>{},1000);`);
  const controller = new AbortController();
  const pending = runManagedLogin({ id: "antigravity", command: process.execPath, args: [fake], dataDir, signal: controller.signal, baseEnv: { HOME: "/user", AGY_CLI_DISABLE_AUTO_UPDATE: "false", GOOGLE_API_KEY: "forbidden" }, terminalLaunch: script => ({ command: "/bin/sh", args: [script] }) });
  const deadline = Date.now() + 5000;
  let saved;
  while (Date.now() < deadline && !saved) { try { saved = JSON.parse(readFileSync(capture, "utf8")); } catch { await new Promise(r => setTimeout(r, 20)); } }
  controller.abort();
  await assert.rejects(pending, /取消/);
  assert.deepEqual(saved.args, ["acp", "--login"]);
  assert.equal(saved.env.HOME, join(dataDir, "cli-agents", "antigravity", "home"));
  assert.equal(saved.env.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
  assert.equal(saved.env.GOOGLE_API_KEY, undefined);
 } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
test("三平台终端登录命令保留带空格的私有脚本路径", () => {
 const script = "/private path/login.sh";
 const mac = terminalAuthCommand("darwin", script);
 assert.equal(mac.command, "/usr/bin/osascript");
 assert.ok(mac.args[1].includes("private path"));
 assert.deepEqual(terminalAuthCommand("linux", script), { command: "x-terminal-emulator", args: ["-e", "/bin/sh", script] });
 assert.equal(terminalAuthCommand("win32", "C:\\private path\\login.cmd").args.at(-1), "C:\\private path\\login.cmd");
});
