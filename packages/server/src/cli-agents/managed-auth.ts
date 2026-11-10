/** 官方命令认证：不记录输出、凭据或账号；取消结束进程。 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { terminalAuth } from "./terminal-auth.ts";
import type { ManagedCliId } from "./native-env.ts";
import { managedCliEnv } from "./managed-env.ts";
import { buildOpencodeEnv } from "./opencode-launch.ts";

export interface ManagedAuthInput {
 id: Extract<ManagedCliId, "claude-code" | "codex" | "opencode" | "antigravity">;
 command: string;
 args?: string[];
 dataDir: string;
 signal: AbortSignal;
 baseEnv?: NodeJS.ProcessEnv;
 terminalLaunch?: (script: string) => { command: string; args: string[] };
}
export function runManagedLogin(input: ManagedAuthInput): Promise<void> {
 const env = input.id === "opencode" ? buildOpencodeEnv(input) : managedCliEnv(input.dataDir, input.id, input);
 // Google 官方 CHANGELOG 1.5.0：acp --login 为 Terminal Auth，交互登录后退出。
 const args = input.id === "antigravity" ? ["acp", "--login"] : input.id === "codex" ? ["login"] : ["auth", "login"];
 if (input.id === "opencode" || input.id === "antigravity") return terminalAuth({ command: input.command, args: [...(input.args ?? []), ...args], env, root: join(input.dataDir, "cli-agents", input.id, "auth-runs"), signal: input.signal, launch: input.terminalLaunch });
 return new Promise((resolve, reject) => {
  input.signal.throwIfAborted();
  const child = spawn(input.command, [...(input.args ?? []), ...args], { env, windowsHide: true, stdio: "ignore" });
  let timer: NodeJS.Timeout | undefined;
  const cancel = () => { child.kill(); timer = setTimeout(() => child.kill("SIGKILL"), 2000); timer.unref(); };
  input.signal.addEventListener("abort", cancel, { once: true });
  const cleanup = () => { clearTimeout(timer); input.signal.removeEventListener("abort", cancel); };
  child.once("error", e => { cleanup(); reject(e); });
  child.once("close", code => {
   cleanup();
   if (input.signal.aborted) reject(new Error("登录已取消"));
   else if (code === 0) resolve();
   else reject(new Error(`官方登录命令未完成（退出码 ${code ?? "未知"}）`));
  });
 });
}
