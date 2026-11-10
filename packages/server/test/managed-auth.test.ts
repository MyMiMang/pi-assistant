import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
test("三平台终端登录命令保留带空格的私有脚本路径", () => {
 const script = "/private path/login.sh";
 const mac = terminalAuthCommand("darwin", script);
 assert.equal(mac.command, "/usr/bin/osascript");
 assert.ok(mac.args[1].includes("private path"));
 assert.deepEqual(terminalAuthCommand("linux", script), { command: "x-terminal-emulator", args: ["-e", "/bin/sh", script] });
 assert.equal(terminalAuthCommand("win32", "C:\\private path\\login.cmd").args.at(-1), "C:\\private path\\login.cmd");
});
