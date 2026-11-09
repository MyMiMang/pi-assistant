/** 原生 ACP 专用目录与环境；复用 CLI 白名单后强制覆盖家目录，避免恢复到 OS 用户 HOME。 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildCliEnv, type ClaudeEnvInput } from "./launch.ts";

export type NativeAcpId = "gemini" | "codebuddy";
export const nativeAcpHome = (dataDir: string, id: NativeAcpId): string => join(dataDir, "cli-agents", id, "home");

export interface NativeEnvInput extends ClaudeEnvInput {
	dataDir: string;
	id: NativeAcpId;
}

/** 最后覆盖包括 Windows 大小写别名的环境键；extra 仅供宿主测试等用途，不能突破隔离目录。 */
export function buildNativeAcpEnv(input: NativeEnvInput, fixed: Record<string, string> = {}): NodeJS.ProcessEnv {
	const home = nativeAcpHome(input.dataDir, input.id);
	const env = buildCliEnv(input, [], {});
	const isolated = {
		HOME: home,
		USERPROFILE: home,
		APPDATA: join(home, "AppData", "Roaming"),
		LOCALAPPDATA: join(home, "AppData", "Local"),
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_CACHE_HOME: join(home, ".cache"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		...fixed,
	};
	const keys = new Set(Object.keys(isolated).map((k) => k.toUpperCase()));
	for (const k of Object.keys(env)) if (keys.has(k.toUpperCase()) || k.toUpperCase() === "XDG_RUNTIME_DIR") delete env[k];
	return { ...env, ...isolated };
}

export function prepareNativeAcpHome(dataDir: string, id: NativeAcpId): string {
	const home = nativeAcpHome(dataDir, id);
	for (const path of [home, "AppData/Roaming", "AppData/Local", ".config", ".local/share", ".cache", ".local/state"].map((p, i) => (i ? join(home, p) : p))) mkdirSync(path, { recursive: true, mode: 0o700 });
	return home;
}

/** HTTP MCP 契约共用；令牌仅经 ACP 请求传递，永不进入 argv。 */
export const nativeAcpMcpServers = (url: string, token: string): unknown[] => [{ type: "http", name: "pia", url, headers: [{ name: "Authorization", value: `Bearer ${token}` }] }];
