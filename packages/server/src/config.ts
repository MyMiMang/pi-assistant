import { cpSync, existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
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

/**
 * 安装包自带的第三方二进制（app/bin-seed：cloudflared / uv / cua-driver，打包时已按 third-party.json 校验 SHA256）
 * 首次启动复制进数据目录的 bin/，之后和自动下载的走同一套查找逻辑；已有的不覆盖。
 */
function seedBins(dataDir: string) {
	const seed = join(import.meta.dirname, "..", "..", "..", "bin-seed");
	if (!existsSync(seed)) return;
	const bin = join(dataDir, "bin");
	mkdirSync(bin, { recursive: true });
	for (const name of readdirSync(seed)) {
		if (existsSync(join(bin, name))) continue;
		try {
			cpSync(join(seed, name), join(bin, name), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
		} catch (e) {
			console.warn(`[bin-seed] ${name}: ${e instanceof Error ? e.message : e}`);
		}
	}
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
	seedBins(c.dataDir);
	// 隔离：Pi 所有默认路径（auth.json、models.json、settings、会话、崩溃日志、keybindings…）都指向我们自己的数据目录，
	// 永远不读写用户自己安装的 Pi（~/.pi/agent）。强制覆盖，不沿用外部环境里的同名变量。
	process.env.PI_CODING_AGENT_DIR = join(dataDir, "pi-agent");
	process.env.PI_CODING_AGENT_SESSION_DIR = join(dataDir, "pi-agent", "sessions");
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	return c;
})();
