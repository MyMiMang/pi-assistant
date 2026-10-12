/**
 * 助理电脑运行时抽象（DESIGN §15.2）：一个共用的容器引擎 + 每个助理一个桌面容器（带 pia.agent 标签）。
 * - docker：本机已有的 Docker / Podman（Linux 服务器、已装 Docker Desktop 的电脑）
 * - lima：macOS 自带虚拟机（Lima + vz + nerdctl）——第 2 步实现，这里只占位
 * - wsl：Windows 自有发行版 PiAssistant-Desktop（WSL2 + nerdctl）——第 3 步实现，这里只占位
 * 所有后端都暴露同一个“docker 兼容”的命令行（docker / podman / nerdctl 参数一致），desktop.ts 只跟它打交道。
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.ts";
import { assertOwnTarget } from "./names.ts";
import { desktopSettings, imageRepos } from "./settings.ts";

const run = promisify(execFile);

export type BackendId = "docker" | "lima" | "wsl";
export interface Detect {
	ok: boolean;
	reason?: string;
}
export interface DesktopBackend {
	id: BackendId;
	/** 给界面看的名字 */
	label: string;
	/** 这个后端在本机能不能用（不会启动/下载任何东西） */
	detect(): Promise<Detect>;
	/** 确保共用引擎在跑（虚拟机后端：开机；docker：什么都不做） */
	ensureEngine(): Promise<void>;
	/** 所有桌面都停了以后关掉引擎释放内存（docker 后端不关用户的 Docker） */
	stopEngine(): Promise<void>;
	/** 删除我们自己的虚拟机/发行版（docker 后端：无） */
	destroyEngine(): Promise<void>;
	/** 引擎是否在跑（docker：总是 true；虚拟机：开没开机） */
	engineRunning(): Promise<boolean>;
	/** docker 兼容命令前缀，例如 ["docker"] / ["podman"] / ["limactl","shell","pia-desktop","nerdctl"] */
	cli(): string[];
}

// ---------------------------------------------------------------- docker / podman
function pickDockerCli(): string[] {
	if (process.env.PIA_DOCKER) return config.docker;
	for (const c of ["docker", "podman"]) {
		try {
			execFileSync(c, ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore", timeout: 5000 });
			return [c];
		} catch {}
	}
	return config.docker;
}
let dockerCli: string[] | null = null;
export const dockerBackend: DesktopBackend = {
	id: "docker",
	label: "本机 Docker / Podman",
	async detect() {
		dockerCli ??= pickDockerCli();
		try {
			await run(dockerCli[0], [...dockerCli.slice(1), "version", "--format", "{{.Server.Version}}"], { timeout: 8000 });
			return { ok: true };
		} catch {
			dockerCli = null; // 下次重新探测（用户可能刚装好）
			return { ok: false, reason: "没有检测到可用的 Docker 或 Podman（需要安装并启动）" };
		}
	},
	async ensureEngine() {},
	async stopEngine() {},
	async destroyEngine() {},
	async engineRunning() {
		return true;
	},
	cli: () => (dockerCli ??= pickDockerCli()),
};

// ---------------------------------------------------------------- 占位：后续步骤实现
const notYet = (id: BackendId, label: string, step: string): DesktopBackend => ({
	id,
	label,
	async detect() {
		return { ok: false, reason: `${label}还在开发中（${step}），现在请在 设置 › 助理电脑 里选“使用已安装的 Docker”` };
	},
	async ensureEngine() {
		throw new Error(`${label}还没有实现`);
	},
	async stopEngine() {},
	async destroyEngine() {},
	async engineRunning() {
		return false;
	},
	cli: () => {
		throw new Error(`${label}还没有实现`);
	},
});
export const limaBackend = notYet("lima", "macOS 自带虚拟机（Lima）", "第 2 步");
export const wslBackend = notYet("wsl", "Windows 自带 WSL2 运行时", "第 3 步");
/** 已实现的自带运行时（实现一个就把它加进来；auto 优先用它们） */
const BUILTIN_READY = new Set<BackendId>([]);

/** 这台机器上“自带运行时”对应的后端；Linux 直接用本机容器引擎 */
export function builtinFor(platform = process.platform): DesktopBackend {
	if (platform === "darwin") return limaBackend;
	if (platform === "win32") return wslBackend;
	return dockerBackend;
}

/** 按设置选后端：docker = 用户已装的 Docker；auto = 自带运行时（还没实现的平台暂时回落到 Docker） */
export function pickBackend(choice: "auto" | "docker", platform = process.platform, ready = BUILTIN_READY): DesktopBackend {
	if (choice === "docker") return dockerBackend;
	const b = builtinFor(platform);
	return b.id === "docker" || ready.has(b.id) ? b : dockerBackend;
}
export const backend = () => pickBackend(desktopSettings().backend);

/** 唯一入口：所有引擎命令都经过名字校验，只碰我们自己的容器/卷/镜像 */
export function engine(args: string[], opts: { timeout?: number; encoding?: "buffer" } = {}) {
	assertOwnTarget(args, imageRepos());
	const cli = backend().cli();
	return run(cli[0], [...cli.slice(1), ...args], { timeout: opts.timeout ?? 20_000, maxBuffer: 64 * 1024 * 1024, encoding: opts.encoding as never });
}
/** 给 MCP stdio 用的完整命令（同样过名字校验） */
export function engineCommand(args: string[]) {
	assertOwnTarget(args, imageRepos());
	const cli = backend().cli();
	return { command: cli[0], args: [...cli.slice(1), ...args] };
}
