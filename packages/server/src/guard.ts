/** 硬性保护的上下文：受保护的路径（数据目录、应用安装目录、LaunchAgent） */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { GuardContext } from "@pi-assistant/shared";
import { BRAND } from "@pi-assistant/shared";
import { config } from "./config.ts";

/** 绝对路径 + ~/… + $HOME/… 三种写法 */
const withHome = (p: string) => {
	const h = homedir();
	return p.startsWith(`${h}/`) ? [p, `~${p.slice(h.length)}`, `$HOME${p.slice(h.length)}`] : [p];
};
const APP_ROOT = resolve(import.meta.dirname, "..", "..", "..");
export function guardContext(target: "host" | "sandbox"): GuardContext {
	if (target === "sandbox") return { target };
	return {
		target,
		allowedPaths: withHome(config.workspaceRoot),
		protectedPaths: [config.dataDir, APP_ROOT, join(homedir(), "Library", "LaunchAgents", `${BRAND.launchdLabel}.plist`), ...(process.env.PIA_APP_DIR ? [process.env.PIA_APP_DIR] : [])],
	};
}
