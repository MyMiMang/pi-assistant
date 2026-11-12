/** 受管 CLI 的 npm / PATH 最终边界；不改变普通 CLI 的宿主环境语义。 */
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { prepareAppNodeBin } from "../app-node-npm.ts";

// 私有元数据不从环境字符串推断；二次白名单沿用同一个受管边界，extra 不能伪造或覆盖。
const boundaries = new WeakMap<NodeJS.ProcessEnv, Record<string, string>>();
export function preserveManagedRuntimeEnv(base: NodeJS.ProcessEnv | undefined, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
 const fixed = base && boundaries.get(base);
 if (!fixed) return env;
 return fixManagedRuntimeEnv(env, fixed);
}
export function fixManagedRuntimeEnv(env: NodeJS.ProcessEnv, fixed: Record<string, string>): NodeJS.ProcessEnv {
 const keys = new Set(Object.keys(fixed).map(key => key.toUpperCase()));
 for (const key of Object.keys(env)) if (keys.has(key.toUpperCase()) || key.toUpperCase() === "XDG_RUNTIME_DIR" || key.toUpperCase().startsWith("NPM_CONFIG_")) delete env[key];
 const result = { ...env, ...fixed };
 boundaries.set(result, fixed);
 return result;
}

/** npm 的两个配置文件必须不同且为空，不从用户 npmrc 读取；配置、全局安装与缓存均留在私有 home。 */
export function managedRuntimeEnv(input: { home: string; command?: string; platform?: NodeJS.Platform; originalPath?: string }): Record<string, string> {
 const platform = input.platform ?? process.platform;
 mkdirSync(input.home, { recursive: true, mode: 0o700 });
 if (lstatSync(input.home).isSymbolicLink()) throw new Error("工具私有 home 不能是符号链接");
 const root = join(input.home, ".npm-private");
 const prefix = join(root, "prefix"), cache = join(root, "cache");
 for (const path of [root, prefix, cache]) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink()) throw new Error("npm 私有目录不能是符号链接");
 }
 const userconfig = join(root, "npmrc"), globalconfig = join(root, "npmrc-global");
 for (const file of [userconfig, globalconfig]) {
  // 不沿链接写文件，也不加载其中的旧配置。
  try { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("npm 私有配置必须为普通文件"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  writeFileSync(file, "", { mode: 0o600 });
 }
 const bin = prepareAppNodeBin(root);
 const pathLib = platform === "win32" ? win32 : posix;
 const dirs = [bin];
 // 私有 App Node、受管命令目录优先；宿主命令目录只通过原始 PATH 保留。
 const toolRoot = pathLib.dirname(input.home);
 if (input.command && pathLib.isAbsolute(input.command)) {
  const relative = pathLib.relative(toolRoot, input.command);
  if (relative && relative !== ".." && !relative.startsWith(`..${pathLib.sep}`) && !pathLib.isAbsolute(relative)) dirs.push(pathLib.dirname(input.command));
 }
 const sep = platform === "win32" ? ";" : ":";
 // 运行时只接回白名单中的原 PATH；安装器未传原 PATH，维持既有精简环境。
 if (input.originalPath !== undefined) dirs.push(...input.originalPath.split(sep).filter(Boolean));
 else if (platform === "win32") {
  const systemRoot = (process.platform === "win32" ? process.env.SystemRoot ?? process.env.SYSTEMROOT : undefined) ?? "C:\\Windows";
  dirs.push(win32.join(systemRoot, "System32"), systemRoot);
 } else dirs.push("/usr/bin", "/bin", "/usr/sbin", "/sbin");
 const seen = new Set<string>();
 return {
  PATH: dirs.filter(dir => { const key = input.originalPath !== undefined && platform === "win32" ? dir.toLowerCase() : dir; if (seen.has(key)) return false; seen.add(key); return true; }).join(sep),
  npm_config_prefix: prefix, npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig,
  npm_config_cache: cache, npm_config_update_notifier: "false", npm_config_registry: "https://registry.npmjs.org/",
 };
}
