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
		defaultEntryDomain: process.env.HUHAO_ENTRY_DOMAIN ?? "app.dengdengyun.shop",
		cloudflared: process.env.HUHAO_CLOUDFLARED,
		sandbox: (process.env.HUHAO_SANDBOX ?? "auto") as "auto" | "workspace" | "docker",
		allowModelNetwork: process.env.HUHAO_OFFLINE !== "1",
	};
	for (const d of [c.dataDir, c.workspaceRoot, c.filesDir, c.agentsDir]) mkdirSync(d, { recursive: true });
	return c;
})();
