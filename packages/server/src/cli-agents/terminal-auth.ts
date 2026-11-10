/** 官方 Terminal Auth：私有脚本启动受管命令，子进程环境全量替换，不记录凭据。 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export function terminalAuthCommand(platform: NodeJS.Platform, script: string): { command: string; args: string[] } {
 if (platform === "darwin") return { command: "/usr/bin/osascript", args: ["-e", `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(`/bin/sh ${quote(script)}`)}\nend tell`] };
 if (platform === "win32") return { command: "cmd.exe", args: ["/d", "/c", "start", '"Pi 登录"', "cmd.exe", "/d", "/c", script] };
 return { command: "x-terminal-emulator", args: ["-e", "/bin/sh", script] };
}
export interface TerminalAuthInput {
 command: string; args: string[]; env: NodeJS.ProcessEnv; root: string; signal: AbortSignal;
 /** 自动化仅注入假终端，不打开用户应用。 */
 launch?: (script: string) => { command: string; args: string[] };
}
export async function terminalAuth(input: TerminalAuthInput): Promise<void> {
 input.signal.throwIfAborted();
 mkdirSync(input.root, { recursive: true, mode: 0o700 });
 const dir = mkdtempSync(join(input.root, "login-"));
 const done = join(dir, "done"), pidFile = join(dir, "pid");
 const script = join(dir, process.platform === "win32" ? "login.cmd" : "login.sh");
 const runner = join(dir, "runner.cjs");
 // 输入已白名单过滤，不含凭据；子进程拿到的 env 与终端自身的配置完全分开。
 writeFileSync(runner, `const {spawn}=require('node:child_process');
const {writeFileSync}=require('node:fs');
const child=spawn(${JSON.stringify(input.command)},${JSON.stringify(input.args)},{env:${JSON.stringify(input.env)},stdio:'inherit',detached:process.platform!=='win32'});
if(child.pid)writeFileSync(${JSON.stringify(pidFile)},String(child.pid),{mode:0o600});
child.on('error',()=>{writeFileSync(${JSON.stringify(done)},'1');process.exitCode=1;});
child.on('close',code=>{writeFileSync(${JSON.stringify(done)},String(code??1));process.exitCode=code??1;});
`, { mode: 0o600 });
 if (process.platform === "win32") {
  const q = (s: string) => '"' + s.replaceAll("%", "%%") + '"';
  writeFileSync(script, `@echo off\r\n${q(process.execPath)} ${q(runner)}\r\n`, { mode: 0o600 });
 } else writeFileSync(script, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(runner)}\n`, { mode: 0o600 });
 const launch = input.launch?.(script) ?? terminalAuthCommand(process.platform, script);
 let poll: NodeJS.Timeout | undefined, timeout: NodeJS.Timeout | undefined;
 let terminal: ReturnType<typeof spawn> | undefined;
 const stopLogin = async () => {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  if (process.platform === "win32") await new Promise<void>(resolve => {
   const kill = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
   kill.once("error", () => resolve()); kill.once("close", () => resolve());
  });
  else { try { process.kill(-pid, "SIGKILL"); } catch { /* 登录进程组已退出 */ } }
 };
 let abort: (() => void) | undefined;
 try {
  await new Promise<void>((resolve, reject) => {
   abort = () => { void stopLogin().finally(() => reject(new Error("登录已取消"))); };
   input.signal.addEventListener("abort", abort, { once: true });
   terminal = spawn(launch.command, launch.args, { stdio: "ignore", windowsHide: true });
   terminal.once("error", reject);
   terminal.once("close", code => { if (code) reject(new Error("无法打开登录终端")); });
   poll = setInterval(() => {
    if (!existsSync(done)) return;
    if (readFileSync(done, "utf8").trim() === "0") resolve(); else reject(new Error("终端登录未完成"));
   }, 100);
   timeout = setTimeout(() => { void stopLogin().finally(() => reject(new Error("终端登录超时"))); }, 10 * 60_000);
   if (input.signal.aborted) abort();
  });
 } finally {
  clearInterval(poll); clearTimeout(timeout);
  if (abort) input.signal.removeEventListener("abort", abort);
  terminal?.kill();
  await stopLogin();
  rmSync(dir, { recursive: true, force: true });
 }
}
