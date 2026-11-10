/** 受管只借脑子渠道的安装、手动更新、认证状态；复用唯一安装器。 */
import { nativeInstaller, managedArgs, releaseFor } from "./managed-install.ts";
import { runManagedLogin } from "./managed-auth.ts";
import { prepareNativeAcpHome } from "./native-env.ts";
import { config } from "../config.ts";

/** 测试通过模块 preload 注入假终端，生产入口不接受外部命令。 */
export const managedAuthRunner = { login: runManagedLogin };
import type { NativeRelease } from "./native-install.ts";

export function managedActions(id: "claude-code" | "codex" | "opencode", envName: string, command: () => string | null, recheck: () => Promise<unknown>) {
 let operation: "install" | "update" | "login" | undefined;
 let controller: AbortController | undefined;
 let error: string | undefined;
 let latest: NativeRelease | undefined;
 function start(kind: typeof operation) {
  if (operation) return { started: false };
  if (kind === "update" && !latest) throw new Error("请先检查更新");
  operation = kind; error = undefined;
  const current = controller = new AbortController();
  void (async () => {
   prepareNativeAcpHome(config.dataDir, id);
   if (kind === "login") {
    const executable = command();
    if (!executable) throw new Error("请先安装工具");
    await managedAuthRunner.login({ id, command: executable, args: managedArgs(id, envName), dataDir: config.dataDir, signal: current.signal });
   } else await nativeInstaller.install(id, kind === "update" ? latest : undefined);
   await recheck();
  })().catch(e => { if (!current.signal.aborted) error = e instanceof Error ? e.message : String(e); })
   .finally(() => { operation = undefined; controller = undefined; });
  return { started: true };
 }
 return {
  extra: () => ({ ...(nativeInstaller.installed(id)?.version ? { version: nativeInstaller.installed(id)!.version } : {}), operation, ...(error ? { error } : {}), latestVersion: latest?.version, updateAvailable: !!latest && latest.version !== nativeInstaller.installed(id)?.version, untestedVersion: !!nativeInstaller.installed(id) && nativeInstaller.installed(id)?.version !== releaseFor(id === "claude-code" ? "@anthropic-ai/claude-code" : id === "codex" ? "@openai/codex" : "opencode-ai").version }),
  actions: {
   install: () => start("install"), login: () => start("login"), update: () => start("update"),
   "check-update": async () => { if (operation) throw new Error("请等当前操作完成"); latest = await nativeInstaller.checkUpdate(id); return { ok: true }; },
   cancel: () => { controller?.abort(); nativeInstaller.cancel(id); return { ok: true }; },
  },
 };
}
