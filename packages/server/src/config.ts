import { existsSync, mkdirSync, renameSync } from "node:fs";
import { BRAND, LEGACY } from "@pi-assistant/shared";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** 读环境变量：新前缀 PIA_，兼容旧前缀 HUHAO_（迁移期，打印一次提示）。 */
const warned = new Set<string>();
export function env(name: string): string | undefined {
	const v = process.env[BRAND.envPrefix + name];
	if (v !== undefined) return v;
	const old = process.env[LEGACY.envPrefix + name];
	if (old !== undefined && !warned.has(name)) {
		warned.add(name);
		console.warn(`[${BRAND.id}] 环境变量 ${LEGACY.envPrefix}${name} 已改名为 ${BRAND.envPrefix}${name}，请尽快更新`);
	}
	return old;
}

function baseDir() {
	if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
	if (process.platform === "win32") return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
	return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}
const desktopOs = process.platform === "darwin" || process.platform === "win32";
function defaultDataDir() {
	const base = baseDir();
	const dir = join(base, desktopOs ? BRAND.dataDirName : BRAND.id);
	// 迁移：旧数据目录存在、新目录不存在 → 整体改名（同一磁盘内原子移动）
	const legacy = join(base, desktopOs ? LEGACY.dataDirName : LEGACY.linuxDir);
	if (!existsSync(dir) && existsSync(legacy)) {
		renameSync(legacy, dir);
		console.log(`[${BRAND.id}] 已把旧数据目录 ${legacy} 迁移到 ${dir}`);
	}
	return dir;
}

/** 旧数据库文件名迁移：huhao.db(+wal/shm) → data.db */
function migrateDb(dataDir: string) {
	const oldDb = join(dataDir, LEGACY.dbFile);
	const newDb = join(dataDir, "data.db");
	if (existsSync(oldDb) && !existsSync(newDb)) for (const ext of ["", "-wal", "-shm"]) if (existsSync(oldDb + ext)) renameSync(oldDb + ext, newDb + ext);
	return newDb;
}

export const config = (() => {
	const dataDir = resolve(env("DATA_DIR") ?? defaultDataDir());
	const workspaceRoot = resolve(env("WORKSPACE") ?? join(dataDir, "workspace"));
	const c = {
		port: Number(env("PORT") ?? 8787),
		host: "127.0.0.1",
		dataDir,
		workspaceRoot,
		filesDir: join(dataDir, "files"),
		agentsDir: join(dataDir, "agents"),
		dbPath: "",
		webDist: resolve(env("WEB_DIST") ?? join(import.meta.dirname, "..", "..", "..", "apps", "web", "dist")),
		/** 仅用于本地开发测试：启用 Mock 模型 */
		mock: env("MOCK") === "1",
		/** 不内置任何默认入口域名：远程稳定入口由用户用自己的域名 + Cloudflare 账号一键部署 */
		entryDomainEnv: env("ENTRY_DOMAIN") || null,
		rendezvousWorker: resolve(env("RENDEZVOUS_WORKER") ?? join(import.meta.dirname, "..", "..", "..", "apps", "rendezvous", "dist", "worker.js")),
		cloudflared: env("CLOUDFLARED"),
		sandbox: (env("SANDBOX") ?? "auto") as "auto" | "workspace" | "docker",
		/** docker 命令（开发机可设 PIA_DOCKER="sudo docker"） */
		docker: (env("DOCKER") ?? "docker").split(" ").filter(Boolean),
		desktopImage: env("DESKTOP_IMAGE") ?? `${BRAND.id}/desktop:dev`,
		allowModelNetwork: env("OFFLINE") !== "1",
	};
	for (const d of [c.dataDir, c.workspaceRoot, c.filesDir, c.agentsDir]) mkdirSync(d, { recursive: true });
	c.dbPath = migrateDb(c.dataDir);
	return c;
})();
