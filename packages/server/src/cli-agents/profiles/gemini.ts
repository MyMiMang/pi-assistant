/** Gemini CLI 薄 profile：保留原生工具 / 系统提示，persona 由上层首条消息追加。 */
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareNativeAcpHome } from "../native-env.ts";

export function prepareGeminiWorkspace(workDir: string, dataDir: string): void {
	const home = prepareNativeAcpHome(dataDir, "gemini");
	const configDir = join(home, ".gemini");
	mkdirSync(configDir, { recursive: true, mode: 0o700 });
	const settingsPath = join(configDir, "settings.json");
	let settings: Record<string, unknown> = {};
	try {
		const saved: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
		if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Gemini settings.json 必须是对象");
		settings = saved as Record<string, unknown>;
	} catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
	const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
	writeFileSync(settingsPath, JSON.stringify({ ...settings, context: { ...obj(settings.context), memoryBoundaryMarkers: [] }, advanced: { ...obj(settings.advanced), ignoreLocalEnv: true } }), { mode: 0o600 });
	const local = join(workDir, ".gemini");
	mkdirSync(local, { recursive: true, mode: 0o700 });
	if (lstatSync(local).isSymbolicLink()) throw new Error("Gemini 工作区 .gemini 不能是符号链接");
	const envFile = join(local, ".env");
	try {
		writeFileSync(envFile, "", { flag: "wx", mode: 0o600 });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		const stat = lstatSync(envFile);
		if (!stat.isFile() || stat.isSymbolicLink() || readFileSync(envFile, "utf8") !== "") throw new Error("Gemini 工作区 .gemini/.env 必须为空文件；现有内容未覆盖");
	}
}
