/**
 * 助理电脑运行时抽象（DESIGN §15.2）：一个共用的容器引擎 + 每个助理一个桌面容器（带 pia.agent 标签）。
 * - docker：本机已有的 Docker / Podman（Linux 服务器、已装 Docker Desktop 的电脑）
 * - lima：macOS 自带虚拟机（Lima + vz + containerd/nerdctl，见 lima.ts）
 * - wsl：Windows 自有发行版 PiAssistant-Desktop（WSL2 + containerd/nerdctl，见 wsl.ts），容器用 host 网络 + 每个助理独立端口
 * 所有后端都暴露同一个“docker 兼容”的命令行（docker / podman / nerdctl 参数一致），desktop.ts 只跟它打交道。
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.ts";
import * as lima from "./lima.ts";
import * as wslrt from "./wsl.ts";
import { assertOwnTarget } from "./names.ts";
import { desktopSettings, imageRepos } from "./settings.ts";

const run = promisify(execFile);

export type BackendId = "docker" | "lima" | "wsl";
export interface Detect {
	ok: boolean;
	reason?: string;
	/** 用户能做的修复：install-wsl = 显示“安装 WSL”按钮（UAC）；reboot = 提示重启电脑 */
	fix?: "install-wsl" | "reboot";
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
	/** 容器端口要由我们指定宿主端口（虚拟机后端：Lima 把虚拟机里的同号端口转发到 Mac，必须先确认 Mac 上没被占用） */
	fixedPorts?: boolean;
	/** 容器用 host 网络（WSL：多个桌面共用发行版的网络，端口 / 显示器编号都由我们分配，经环境变量传给 start.sh） */
	hostNetwork?: boolean;
	/** 虚拟机 / 发行版后端：当前阶段（给界面显示“正在启动虚拟机”等） */
	phase?(): { phase: string; detail?: string };
	/** 虚拟机 / 发行版组件在统一下载管理器里的 id */
	downloadId?: string;
	cancelDownload?(): void;
	/** 引擎关着时用标记文件判断“镜像已下载”（不为了查询而开机） */
	imageMarked?(ref: string): boolean;
	markImage?(ref: string | null): void;
	/** App 退出时交给独立进程关机 */
	stopDetached?(): void;
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

export const limaBackend: DesktopBackend = {
	id: "lima",
	label: "macOS 自带虚拟机（Lima）",
	detect: lima.detectLima,
	ensureEngine: lima.ensureVm,
	stopEngine: lima.stopVm,
	destroyEngine: lima.destroyVm,
	async engineRunning() {
		return (await lima.vmState()) === "running";
	},
	fixedPorts: true,
	phase: lima.vmPhase,
	downloadId: "desktop-vm",
	cancelDownload: lima.cancelVmDownload,
	imageMarked: lima.imageMarked,
	markImage: lima.markImage,
	stopDetached: lima.stopVmDetached,
	cli: lima.nerdctlCli,
};
export const wslBackend: DesktopBackend = {
	id: "wsl",
	label: "Windows 自带运行时（WSL2）",
	detect: wslrt.detectWsl,
	ensureEngine: wslrt.ensureWsl,
	stopEngine: wslrt.stopWsl,
	destroyEngine: wslrt.destroyWsl,
	engineRunning: wslrt.wslRunning,
	fixedPorts: true,
	hostNetwork: true,
	phase: wslrt.wslPhase,
	downloadId: "desktop-wsl",
	cancelDownload: wslrt.cancelWslDownload,
	imageMarked: wslrt.imageMarked,
	markImage: wslrt.markImage,
	stopDetached: wslrt.stopWslDetached,
	cli: wslrt.nerdctlCli,
};
/** 已实现的自带运行时（auto 优先用它们） */
const BUILTIN_READY = new Set<BackendId>(["lima", "wsl"]);

/** 这台机器上“自带运行时”对应的后端；Linux 直接用本机容器引擎 */
export function builtinFor(platform = process.platform): DesktopBackend {
	if (platform === "darwin" || process.env.PIA_TEST_LIMA === "1") return limaBackend; // PIA_TEST_LIMA：Linux 上用假 limactl 跑集成测试
	if (platform === "win32" || process.env.PIA_TEST_WSL === "1") return wslBackend; // PIA_TEST_WSL：Linux 上用假 wsl.exe 跑集成测试
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
