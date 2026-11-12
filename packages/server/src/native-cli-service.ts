/** 配置表驱动的原生工具服务：安装、认证、模型发现与刷新仅一份流程。 */
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { nativeAcpDefinition, type NativeAcpId } from "@pi-assistant/shared";
import { nativeInstaller, releaseFor } from "./cli-agents/managed-install.ts";
import { authenticateNative, detectNative, type NativeDetection } from "./cli-agents/native-auth.ts";
import type { NativeRelease } from "./cli-agents/native-install.ts";
import { registerNativeModels, registerNativeProvider, type NativeProviderId } from "./pi-adapter/cli-models/native.ts";
import { createCliChannelService } from "./cli-channel-service.ts";
import { config } from "./config.ts";

export function nativeService(tool: NativeAcpId) {
 const definition = nativeAcpDefinition(tool);
 const { name, envName } = definition;
 const id = definition.provider as NativeProviderId;
 let cache: { command: string; value: NativeDetection } | undefined;
 let controller: AbortController | undefined;
 let operation: "login" | "install" | "update" | undefined;
 let actionError: string | undefined;
 let latest: NativeRelease | undefined;
 const release = releaseFor(definition.packageName);
 const supported = () => [release, ...(tool === "amp-acp" ? [releaseFor("amp-cli-runtime")] : [])].every(r => r.source !== "binary" || !!r.assets?.[`${process.platform}-${process.arch}`]?.sha256 && !r.assets?.[`${process.platform}-${process.arch}`]?.unsupported);
 const allowOverride = () => process.env.NODE_ENV !== "production" && (config.mock || process.env.NODE_ENV === "test" || process.env.PIA_DEV === "1");
 const args = () => allowOverride() && process.env[`PIA_${envName}`] !== undefined ? [] : nativeInstaller.installed(tool)?.args ?? [];
 const input = (command: string) => ({ id: tool, command, args: args(), dataDir: config.dataDir });
 const specs = () => (cache?.value.models ?? []).map(m => ({ ...m, reasoning: false, contextWindow: 32_000, maxTokens: 8_000 }));
 const start = (kind: typeof operation) => {
  if (operation) return { started: false };
  if (!supported() && !allowOverride()) throw new Error("这个平台暂不支持");
  if (kind === "update" && !latest) throw new Error("请先检查更新");
  operation = kind; actionError = undefined; controller = new AbortController();
  void (async () => {
   if (kind === "login") {
    const command = service.command();
    if (!command) throw new Error("请先安装工具");
    await authenticateNative({ ...input(command), signal: controller!.signal });
   } else await nativeInstaller.install(tool, kind === "update" ? latest : undefined);
   cache = undefined;
   const { models } = await import("./models.ts");
   await service.check(models, true);
  })().catch(e => { actionError = controller?.signal.aborted ? undefined : e instanceof Error ? e.message : String(e); }).finally(() => { operation = undefined; controller = undefined; });
  return { started: true };
 };
 const service = createCliChannelService({
  id, label: name, envName, managed: true, allowCommandOverride: allowOverride,
  find: () => nativeInstaller.installed(tool)?.command ?? null,
  notFound: `尚未安装 ${name}`,
  invalidate: () => { cache = undefined; },
  detect: async (command): Promise<NativeDetection> => {
   if (cache?.command === command) return cache.value;
   const value = await detectNative(input(command)).catch(e => ({ installed: isAbsolute(command) && existsSync(command), loggedIn: false, loginUnverified: true, error: e instanceof Error ? e.message : String(e), authMethods: [], models: [] }));
   cache = { command, value }; return value;
  },
  requireLogin: true,
  extra: () => ({ platformSupported: supported(), authType: cache?.value.authType ?? definition.auth,
   version: nativeInstaller.installed(tool)?.version, verified: nativeInstaller.installed(tool)?.verified,
   latestVersion: latest?.version, updateAvailable: !!latest && latest.version !== nativeInstaller.installed(tool)?.version,
   updateBlocked: latest?.updateBlocked,
   untestedVersion: !!nativeInstaller.installed(tool) && nativeInstaller.installed(tool)?.version !== release.version,
   operation, ...(actionError ? { error: actionError } : {}) }),
  actions: {
   login: () => start("login"), install: () => start("install"), update: () => start("update"),
   "check-update": async () => { if (operation) throw new Error("请等当前操作完成"); latest = await nativeInstaller.checkUpdate(tool); return { ok: true }; },
   cancel: () => { controller?.abort(); nativeInstaller.cancel(tool); return { ok: true }; },
  },
  register: (models, command) => {
   return registerNativeProvider(models, id, { dataDir: config.dataDir, bridgeBaseUrl: () => `http://127.0.0.1:${config.port}`, command, commandArgs: args, nativeModels: specs });
  },
  refresh: (models, channel) => registerNativeModels(models, channel, id, specs()),
 });
 return service;
}
