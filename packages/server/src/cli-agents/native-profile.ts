/** 原生 ACP 通用 profile；每家差异只读共享配置表，Gemini 工作区准备为必要特例。 */
import { nativeAcpDefinition, type NativeAcpId } from "@pi-assistant/shared";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AcpProfile } from "./acp-process.ts";
import { buildNativeAcpEnv, nativeAcpHome, nativeAcpMcpServers, prepareNativeAcpHome } from "./native-env.ts";
import { prepareGeminiWorkspace } from "./profiles/gemini.ts";
import { ampRuntimeCommand } from "./native-amp.ts";

export function nativeProfile(id: NativeAcpId): AcpProfile {
 const definition = nativeAcpDefinition(id);
 return {
  label: definition.name, mode: "native", toolPrefix: "pia_",
  args: () => [...definition.args],
  env: (input) => {
   const home = nativeAcpHome(input.dataDir, id);
   const fixed = Object.fromEntries(Object.entries(definition.environment).map(([key, value]) => [key, value.replaceAll("{home}", home)]));
   if (id === "amp-acp") fixed.AMP_CLI_PATH = ampRuntimeCommand(input.dataDir);
   return buildNativeAcpEnv({ ...input, id }, fixed);
  },
  prepare: ({ workDir, dataDir }) => {
   if (definition.unavailableReason) throw new Error(definition.unavailableReason);
   const home = prepareNativeAcpHome(dataDir, id);
   if (definition.settings) prepareNativeSettings(home, definition.settings);
   if (id === "gemini") prepareGeminiWorkspace(workDir, dataDir);
  },
  ...(id === "codebuddy" ? { loadParams: { _meta: { "codebuddy.ai/suppressReplay": true } } } : {}),
  runFiles: () => [], mcpServers: nativeAcpMcpServers,
 };
}
/** 只修改私有目录内已证实的更新设置，保留其他配置；不读取认证文件。 */
function prepareNativeSettings(home: string, settings: NonNullable<ReturnType<typeof nativeAcpDefinition>["settings"]>): void {
 const file = join(home, settings.path);
 let parent = home;
 for (const part of settings.path.split("/").slice(0, -1)) {
  parent = join(parent, part);
  if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error("工具配置目录不能是符号链接");
 }
 mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
 if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())) throw new Error("工具配置必须为普通文件");
 const raw = existsSync(file) ? readFileSync(file, "utf8") : "";
 if (settings.format === "json") {
  const merge = (base: unknown, patch: Readonly<Record<string, unknown>>): Record<string, unknown> => {
   const result = base && typeof base === "object" && !Array.isArray(base) ? { ...base as Record<string, unknown> } : {};
   for (const [key, value] of Object.entries(patch)) result[key] = value && typeof value === "object" && !Array.isArray(value) ? merge(result[key], value as Record<string, unknown>) : value;
   return result;
  };
  writeFileSync(file, JSON.stringify(merge(raw ? JSON.parse(raw) : {}, settings.values)), { mode: 0o600 });
 } else {
  let updated = raw;
  for (const [key, value] of Object.entries(settings.values)) {
   const lines = updated.split("\n");
   const table = lines.findIndex(line => /^\s*\[/.test(line));
   const end = table < 0 ? lines.length : table;
   const index = lines.slice(0, end).findIndex(line => new RegExp(`^\\s*${key}\\s*=`).test(line));
   if (index >= 0) lines[index] = `${key} = ${JSON.stringify(value)}`;
   else lines.splice(end, 0, `${key} = ${JSON.stringify(value)}`);
   updated = lines.join("\n");
  }
  writeFileSync(file, updated, { mode: 0o600 });
 }
}
export const geminiProfile = nativeProfile("gemini");
export const codebuddyProfile = nativeProfile("codebuddy");
