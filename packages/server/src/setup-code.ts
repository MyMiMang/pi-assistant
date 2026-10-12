/**
 * Linux 服务器版的首次设置（DESIGN §15.3）：服务器没有屏幕，第一次用网页登录时输入一次性设置码。
 * - 还没有主人设备时，生成 8 位设置码（24 小时有效、只能用一次、错误 5 次锁定并作废），打印到控制台 / systemd 日志，
 *   并写到 数据目录/setup-code.txt（权限 600，只有服务账号和 root 能读；`pi-assistant setup-code` 读它）。
 * - 第一台用设置码登录的设备成为“主人设备”：和本机一样能改所有设置、批准新设备（auth.ts isOwnerDevice）。
 * - 设置码过期 / 被锁定作废 / 主人设备都被吊销后：自动重新生成并打印新的。
 */
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { createSetupCode, hasOwner, setupCodeValid } from "./auth.ts";
import { bus } from "./bus.ts";
import { config } from "./config.ts";

export const setupCodeFile = () => join(config.dataDir, "setup-code.txt");
/** 服务器上可以访问网页的地址（给控制台提示用） */
export function serverUrls(host = config.host, port = config.port) {
	if (host !== "0.0.0.0" && host !== "::") return [`http://${host.includes(":") ? `[${host}]` : host}:${port}`];
	const out: string[] = [];
	for (const list of Object.values(networkInterfaces()))
		for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(`http://${a.address}:${port}`);
	return out.length ? out : [`http://<服务器地址>:${port}`];
}
export function setupBanner(code: string, expiresAt: number, urls = serverUrls()) {
	const line = "=".repeat(64);
	return [
		line,
		"  Pi Assistant 首次设置",
		`  设置码：${code}     （${new Date(expiresAt).toLocaleString("zh-CN", { hour12: false })} 前有效，只能用一次）`,
		"  在浏览器打开下面的地址，输入设置码；第一台登录的设备会成为“主人设备”，",
		"  之后可以在网页上批准新设备、修改所有设置。",
		...urls.map((u) => `    ${u}`),
		"  建议开启 HTTPS：设置 › 远程访问 里一键开启内置 Cloudflare 隧道，或放在 HTTPS 反向代理后面。",
		`  忘了设置码：${process.env.PIA_CLI_HINT || "sudo pi-assistant setup-code"}`,
		line,
	].join("\n");
}
let current: string | null = null;
/** 需要时生成并打印设置码（启动时 + 每分钟检查一次）；返回当前设置码（测试用） */
export function ensureSetupCode(log: (s: string) => void = console.log): string | null {
	if (!config.headless) return null;
	if (hasOwner()) {
		if (current) cleanup();
		return null;
	}
	if (current && setupCodeValid()) return current;
	const { shortCode, expiresAt } = createSetupCode();
	current = shortCode;
	try {
		writeFileSync(setupCodeFile(), `${shortCode}\n`, { mode: 0o600 });
		chmodSync(setupCodeFile(), 0o600);
	} catch {}
	log(setupBanner(shortCode, expiresAt));
	return shortCode;
}
function cleanup() {
	current = null;
	rmSync(setupCodeFile(), { force: true });
}
export function startSetupWatcher(intervalMs = 60_000) {
	if (!config.headless) return () => {};
	ensureSetupCode();
	bus.on((e) => {
		if ((e as { type: string }).type === "setup.claimed") {
			cleanup();
			console.log("[setup] 主人设备已设置好，设置码作废");
		}
		// 主人设备被吊销：没有主人了就重新生成设置码
		if (e.type === "devices.changed" || e.type === "device.revoked") setTimeout(() => ensureSetupCode(), 100);
	});
	const t = setInterval(() => ensureSetupCode(), intervalMs);
	t.unref();
	return () => clearInterval(t);
}
