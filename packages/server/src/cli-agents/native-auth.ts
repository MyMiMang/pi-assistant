/** 原生 ACP 认证 / 无 prompt 检测。只使用受管 profile 与白名单环境，不读取凭据。 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AcpProfile } from "./acp-process.ts";
import { RpcClient, RpcError } from "./jsonrpc-stdio.ts";
import { nativeAcpDefinition, type NativeAcpId } from "@pi-assistant/shared";
import { nativeProfile } from "./native-profile.ts";
import { terminalAuth } from "./terminal-auth.ts";
import { nativeMcpTransport } from "./native-mcp.ts";

export type NativeId = NativeAcpId;
export interface NativeAuthMethod { id: string; name: string }
export interface NativeModel { id: string; name: string; image: boolean }
export interface NativeDetection {
 installed: boolean; loggedIn: boolean; loginUnverified?: boolean; error?: string;
 authMethods: NativeAuthMethod[]; models: NativeModel[];
 authType?: "agent" | "terminal" | "api-key";
 bridgeTransport?: "http" | "stdio";
}
export interface NativeAuthInput {
 id: NativeId; command: string; dataDir: string; signal?: AbortSignal;
 baseEnv?: NodeJS.ProcessEnv; timeoutMs?: number; profile?: AcpProfile; args?: string[];
 terminalLaunch?: (script: string) => { command: string; args: string[] };
}
const obj = (x: unknown): Record<string, unknown> => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {};
/** Gemini 必须选 Google OAuth；未知家只接受唯一的非密钥 Agent Auth，绝不选 API key。 */
export function nativeAuthMethods(value: unknown): NativeAuthMethod[] {
 return (Array.isArray(value) ? value : []).map(obj)
  .filter((m) => typeof m.id === "string" && (m.type === undefined || m.type === "agent") && !obj(m._meta)["terminal-auth"] && obj(m._meta).type !== "terminal" && !/api.?key|vertex|gateway|cached.token/i.test(`${m.id} ${m.name ?? ""}`))
  .map((m) => ({ id: m.id as string, name: typeof m.name === "string" ? m.name : m.id as string }));
}
export function nativeModels(value: unknown, image: boolean, legacy?: unknown): NativeModel[] {
 const option = (Array.isArray(value) ? value : []).map(obj).find((o) => o.category === "model");
 const flatten = (v: unknown): NativeModel[] => (Array.isArray(v) ? v : []).flatMap((raw) => {
  const o = obj(raw);
  return Array.isArray(o.options) ? flatten(o.options) : typeof o.value === "string" ? [{ id: o.value, name: typeof o.name === "string" ? o.name : o.value, image }] : [];
 });
 const modern = flatten(option?.options);
 const available = (Array.isArray(obj(legacy).availableModels) ? obj(legacy).availableModels as unknown[] : []).map(obj).flatMap(m => typeof m.modelId === "string" ? [{ id: m.modelId, name: typeof m.name === "string" ? m.name : m.modelId, image }] : []);
 return [...new Map((modern.length ? modern : available).map((m) => [m.id, m])).values()];
}
async function withClient<T>(i: NativeAuthInput, run: (c: RpcClient, dir: string) => Promise<T>): Promise<T> {
 const root = join(i.dataDir, "cli-agents", i.id, "probes");
 mkdirSync(root, { recursive: true, mode: 0o700 });
 const dir = mkdtempSync(join(root, "run-"));
 const profile = i.profile ?? nativeProfile(i.id);
 let c: RpcClient | undefined;
 const abort = () => c?.close();
 try {
  i.signal?.throwIfAborted();
  profile.prepare?.({ workDir: dir, dataDir: i.dataDir, runDir: dir });
  c = new RpcClient({ label: profile.label, command: i.command, args: [...(i.args ?? []), ...profile.args(dir)], cwd: dir,
   env: profile.env({ command: i.command, dataDir: i.dataDir, runDir: dir, baseEnv: i.baseEnv }),
   onNotification: () => {}, onRequest: (id) => c!.respondError(id, { code: -32601, message: "Client method unavailable during authentication" }), onExit: () => {} });
  i.signal?.addEventListener("abort", abort, { once: true });
  c.start();
  return await run(c, dir);
 } finally {
  i.signal?.removeEventListener("abort", abort);
  c?.close();
  if (c) await c.exitedPromise;
  rmSync(dir, { recursive: true, force: true });
 }
}
const initialize = (c: RpcClient, timeout: number) => c.request<Record<string, unknown>>("initialize", { protocolVersion: 1, clientCapabilities: { auth: { terminal: true }, _meta: { "terminal-auth": true } } }, timeout);
export async function detectNative(i: NativeAuthInput): Promise<NativeDetection> {
 return withClient(i, async (c, dir) => {
  const timeout = i.timeoutMs ?? 30_000;
  const init = await initialize(c, timeout);
  const authMethods = nativeAuthMethods(init.authMethods);
  const authType = authMethods.length ? "agent" : terminalMethods(init.authMethods).length ? "terminal" : "api-key";
  try {
   const session = await c.request<Record<string, unknown>>("session/new", { cwd: dir, mcpServers: [] }, timeout);
   return { installed: true, loggedIn: true, authMethods, authType, bridgeTransport: nativeMcpTransport(init),
    models: nativeModels(session.configOptions, obj(obj(init.agentCapabilities).promptCapabilities).image === true, session.models) };
  } catch (e) {
   return { installed: true, loggedIn: false, ...(e instanceof RpcError && (e.code === -32000 && /authentication required|auth(?:entication)? failed|not (?:logged|signed) in|login required|credentials? (?:missing|not found|invalid)|API key (?:is )?(?:required|missing|not found)|please (?:log|sign) in/i.test(e.message)) ? {} : { loginUnverified: true }), error: e instanceof Error ? e.message : String(e), authMethods, authType, models: [] };
  }
 });
}
export interface NativeTerminalMethod { args: string[]; env: Record<string, string>; legacy: boolean; command?: string }
/** ACP first-class terminal auth 追加到受管启动参数；旧元数据仅允许同一受管命令。 */
export function terminalMethods(value: unknown): NativeTerminalMethod[] {
 return (Array.isArray(value) ? value : []).map(obj).flatMap(method => {
  const legacy = method.type !== "terminal";
  const terminal = legacy ? obj(obj(method._meta)["terminal-auth"]) : method;
  if (!Array.isArray(terminal.args) || !terminal.args.every(a => typeof a === "string" && !a.includes("\u0000"))) return [];
  const env = Object.fromEntries(Object.entries(obj(terminal.env)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return [{ args: terminal.args as string[], env, legacy, ...(typeof terminal.command === "string" ? { command: terminal.command } : {}) }];
 });
}
export async function authenticateNative(i: NativeAuthInput): Promise<void> {
 let terminal: NativeTerminalMethod | undefined;
 await withClient(i, async (c) => {
  const init = await initialize(c, i.timeoutMs ?? 30_000);
  const methods = nativeAuthMethods(init.authMethods);
  const preferred = nativeAcpDefinition(i.id).authMethod;
  const method = preferred ? methods.find(m => m.id === preferred) : methods.length === 1 ? methods[0] : methods.find(m => /oauth|browser|login/i.test(`${m.id} ${m.name}`));
  if (method) { await c.request("authenticate", { methodId: method.id }, i.timeoutMs ?? 10 * 60_000); return; }
  terminal = terminalMethods(init.authMethods)[0];
  if (!terminal) throw new Error("需要在工具里配置模型服务或 API key；Pi 不读取或保存密钥");
 });
 if (!terminal) return;
 const terminalArgs = nativeAcpDefinition(i.id).terminalArgs;
 if (terminal.legacy && !terminalArgs && terminal.command !== i.command && terminal.command !== i.args?.[0]) throw new Error("工具的终端登录命令不属于 Pi 私有安装，无法安全启动");
 const profile = i.profile ?? nativeProfile(i.id);
 // 先经已有白名单过滤工具返回的环境，再由 profile 强制覆盖私有目录与固定开关。
 const env = profile.env({ command: i.command, dataDir: i.dataDir, runDir: "", baseEnv: { ...i.baseEnv, ...terminal.env } });
 const args = terminalArgs ? [...(i.args ?? []), ...terminalArgs] : terminal.legacy ? [...(i.args ?? []), ...terminal.args] : [...(i.args ?? []), ...profile.args(""), ...terminal.args];
 await terminalAuth({ command: i.command, args, env, root: join(i.dataDir, "cli-agents", i.id, "auth-runs"), signal: i.signal ?? AbortSignal.timeout(i.timeoutMs ?? 10 * 60_000), launch: i.terminalLaunch });
}
