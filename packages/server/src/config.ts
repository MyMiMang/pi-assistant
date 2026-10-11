import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function defaultDataDir() {
	if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "HuHao");
	if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "HuHao");
	return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "huhao");
}

export const config = (() => {
	const dataDir = resolve(process.env.HUHAO_DATA_DIR ?? defaultDataDir());
	const workspaceRoot = resolve(process.env.HUHAO_WORKSPACE ?? join(dataDir, "workspace"));
	const c = {
		port: Number(process.env.HUHAO_PORT ?? 8787),
		host: "127.0.0.1",
		dataDir,
		workspaceRoot,
		filesDir: join(dataDir, "files"),
		agentsDir: join(dataDir, "agents"),
		dbPath: join(dataDir, "huhao.db"),
		webDist: resolve(process.env.HUHAO_WEB_DIST ?? join(import.meta.dirname, "..", "..", "..", "apps", "web", "dist")),
		/** 仅用于本地开发测试：启用 Mock 模型 */
		mock: process.env.HUHAO_MOCK === "1",
		/** 默认入口域名（PWA 外壳 + Rendezvous），可在设置中修改 */
		/** 不内置任何默认入口域名：远程稳定入口由用户用自己的域名 + Cloudflare 账号一键部署 */
		entryDomainEnv: process.env.HUHAO_ENTRY_DOMAIN || null,
		rendezvousWorker: resolve(process.env.HUHAO_RENDEZVOUS_WORKER ?? join(import.meta.dirname, "..", "..", "..", "apps", "rendezvous", "dist", "worker.js")),
		cloudflared: process.env.HUHAO_CLOUDFLARED,
		sandbox: (process.env.HUHAO_SANDBOX ?? "auto") as "auto" | "workspace" | "docker",
		/** docker 命令（开发机可设 HUHAO_DOCKER="sudo docker"） */
		docker: (process.env.HUHAO_DOCKER ?? "docker").split(" ").filter(Boolean),
		desktopImage: process.env.HUHAO_DESKTOP_IMAGE ?? "huhao/desktop:dev",
		allowModelNetwork: process.env.HUHAO_OFFLINE !== "1",
	};
	for (const d of [c.dataDir, c.workspaceRoot, c.filesDir, c.agentsDir]) mkdirSync(d, { recursive: true });
	return c;
})();
