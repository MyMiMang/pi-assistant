/**
 * 快速操作模型 · 真实操控基准测试 —— 助理电脑（VM）fixture 网关解析 + fixture 路由收紧。
 *
 * 用户要求（2026-10-22）：点「开始实际操作测试」就应该能用，不要手填网关地址，也不要给一个安全上无效的开关。
 * 助理电脑里的浏览器要从**它所在的网络**访问位于助理电脑宿主上的 fixture 页与状态上报口。这里给出两件事：
 *  1. `resolveComputerFixtureBaseUrl`：按桌面运行时类型推断 guest 可达的宿主别名（Docker Desktop / Lima），
 *     返回 `null` 表示当前平台没有**已证实**的别名 → 该目标明确不可准备（fail-closed），**绝不回退 127.0.0.1**；
 *  2. `hardenFixtureGateway`：把 fixture 路由收紧成窄网关 —— 只服务本次 run 的 fixture 页 + 状态上报，
 *     fixture 前缀下其它路径 / 方法一律 403；控制 API 不额外暴露任何东西（服务本身仍只监听 127.0.0.1 / 既有入口）。
 *
 * **未验证声明**：别名可达性（host.docker.internal / host.lima.internal）**未在真实 VM 上验证**；本轮只实现机制与
 * 单测（本地 HTTP 小服务模拟 guest 代理），真机边界见 docs/production/benchmark-environment-bootstrap.md。
 */

/** 桌面运行时类型（与 desktop 模块的 runningDesktops 语义对齐，这里只取字符串以免耦合）。 */
export type DesktopRuntimeKind = "docker" | "lima" | "wsl" | "unknown";

export interface ComputerGatewayInput {
	/** Pi 服务端口（fixture 与状态上报都在这个端口上）。 */
	port: number;
	/** 助理电脑运行时类型。 */
	kind: DesktopRuntimeKind;
	/** 覆盖平台判断（测试用）。 */
	platform?: NodeJS.Platform;
}

/**
 * 推断助理电脑里的浏览器访问宿主 fixture 的基址。拿不到已证实的别名就返回 null（fail-closed）。
 * 只返回环回 / 私有别名地址，**绝不**返回 0.0.0.0，也不把控制 API 暴露到公网。
 */
export function resolveComputerFixtureBaseUrl(input: ComputerGatewayInput): string | null {
	const platform = input.platform ?? process.platform;
	// Docker Desktop（macOS / Windows）与 WSL2 都用 host.docker.internal 指向宿主。
	if (input.kind === "docker") {
		if (platform === "darwin" || platform === "win32") return `http://host.docker.internal:${input.port}`;
		return null; // Linux 原生 docker 的桥接网关 IP 因安装而异，未证实前 fail-closed。
	}
	if (input.kind === "lima") return `http://host.lima.internal:${input.port}`;
	if (input.kind === "wsl") return null; // WSL2 宿主 IP 需从 /etc/resolv.conf 读，未证实前 fail-closed。
	return null;
}

/** fixture 网关前缀（窄网关只认这一段）。 */
export const FIXTURE_GATEWAY_PREFIX = "/api/fast-computer/benchmark/fixture/";

/** 判断某请求路径是否落在窄网关前缀内。 */
export const isFixtureGatewayPath = (path: string): boolean => path.startsWith(FIXTURE_GATEWAY_PREFIX);

/** 状态上报的来源校验：`Origin` / `Referer` 若存在，必须与请求自身同源（防别的站点 / 别的 run 伪造上报）。 */
export function fixtureOriginAllowed(input: { origin?: string | null; referer?: string | null; selfOrigin: string }): boolean {
	const self = input.selfOrigin.replace(/\/$/, "");
	for (const raw of [input.origin, input.referer]) {
		if (!raw) continue;
		try {
			const u = new URL(raw);
			if (`${u.protocol}//${u.host}` !== self) return false;
		} catch {
			return false;
		}
	}
	return true;
}
