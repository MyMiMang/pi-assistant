/** 原生 ACP 认证 / 无 prompt 检测。只使用受管 profile 与白名单环境，不读取凭据。 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AcpProfile } from "./acp-process.ts";
import { RpcClient, RpcError } from "./jsonrpc-stdio.ts";
import { geminiProfile } from "./profiles/gemini.ts";
import { codebuddyProfile } from "./profiles/codebuddy.ts";

export type NativeId = "gemini" | "codebuddy";
export interface NativeAuthMethod { id: string; name: string }
export interface NativeModel { id: string; name: string; image: boolean }
export interface NativeDetection {
 installed: boolean; loggedIn: boolean; loginUnverified?: boolean; error?: string;
 authMethods: NativeAuthMethod[]; models: NativeModel[];
}
export interface NativeAuthInput {
 id: NativeId; command: string; dataDir: string; signal?: AbortSignal;
 baseEnv?: NodeJS.ProcessEnv; timeoutMs?: number; profile?: AcpProfile; args?: string[];
}
const obj = (x: unknown): Record<string, unknown> => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {};
/** Gemini 必须选 Google OAuth；未知家只接受唯一的非密钥 Agent Auth，绝不选 API key。 */
export function nativeAuthMethods(value: unknown): NativeAuthMethod[] {
 return (Array.isArray(value) ? value : []).map(obj)
  .filter((m) => typeof m.id === "string" && (m.type === undefined || m.type === "agent") && !/api.?key|vertex|gateway/i.test(`${m.id} ${m.name ?? ""}`))
  .map((m) => ({ id: m.id as string, name: typeof m.name === "string" ? m.name : m.id as string }));
}
export function nativeModels(value: unknown, image: boolean): NativeModel[] {
 const option = (Array.isArray(value) ? value : []).map(obj).find((o) => o.category === "model");
 const flatten = (v: unknown): NativeModel[] => (Array.isArray(v) ? v : []).flatMap((raw) => {
  const o = obj(raw);
  return Array.isArray(o.options) ? flatten(o.options) : typeof o.value === "string" ? [{ id: o.value, name: typeof o.name === "string" ? o.name : o.value, image }] : [];
 });
 return [...new Map(flatten(option?.options).map((m) => [m.id, m])).values()];
}
async function withClient<T>(i: NativeAuthInput, run: (c: RpcClient, dir: string) => Promise<T>): Promise<T> {
 const root = join(i.dataDir, "cli-agents", i.id, "probes");
 mkdirSync(root, { recursive: true, mode: 0o700 });
 const dir = mkdtempSync(join(root, "run-"));
 const profile = i.profile ?? (i.id === "gemini" ? geminiProfile : codebuddyProfile);
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
const initialize = (c: RpcClient, timeout: number) => c.request<Record<string, unknown>>("initialize", { protocolVersion: 1, clientCapabilities: {} }, timeout);
export async function detectNative(i: NativeAuthInput): Promise<NativeDetection> {
 return withClient(i, async (c, dir) => {
  const timeout = i.timeoutMs ?? 30_000;
  const init = await initialize(c, timeout);
  const authMethods = nativeAuthMethods(init.authMethods);
  try {
   const session = await c.request<Record<string, unknown>>("session/new", { cwd: dir, mcpServers: [] }, timeout);
   return { installed: true, loggedIn: true, authMethods, models: nativeModels(session.configOptions, obj(obj(init.agentCapabilities).promptCapabilities).image === true) };
  } catch (e) {
   return { installed: true, loggedIn: false, ...(e instanceof RpcError && (e.code === -32000 && /authentication required|auth(?:entication)? failed|not (?:logged|signed) in|login required|credentials? (?:missing|not found|invalid)|API key (?:is )?(?:required|missing|not found)|please (?:log|sign) in/i.test(e.message)) ? {} : { loginUnverified: true }), error: e instanceof Error ? e.message : String(e), authMethods, models: [] };
  }
 });
}
export async function authenticateNative(i: NativeAuthInput): Promise<void> {
 await withClient(i, async (c) => {
  const init = await initialize(c, i.timeoutMs ?? 30_000);
  const methods = nativeAuthMethods(init.authMethods);
  const method = i.id === "gemini" ? methods.find((m) => m.id === "oauth-personal") : methods.length === 1 ? methods[0] : methods.find((m) => /oauth|browser|login/i.test(`${m.id} ${m.name}`));
  if (!method) {
   const terminal = (Array.isArray(init.authMethods) ? init.authMethods : []).map(obj).some((m) => m.type === "terminal");
   throw new Error(terminal ? "工具仅提供终端登录，本批暂不支持，请等待浏览器登录支持" : "工具没有提供可用的官方浏览器登录方法");
  }
  await c.request("authenticate", { methodId: method.id }, i.timeoutMs ?? 10 * 60_000);
 });
}
