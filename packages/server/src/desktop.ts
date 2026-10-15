/**
 * 助理电脑（sandbox desktop）：共用一个容器引擎（见 desktop/backend.ts）。
 * 默认所有助理共用一台电脑（容器 pia-desk-shared，家目录卷 pia-home-shared：同样的文件、浏览器登录状态、已装的应用）；
 * 选了“单独的电脑”的助理有自己的容器 / 家目录卷（按助理 id 命名，和旧版一样）。DESIGN §15.4。
 * 同一台电脑里每个助理可以有自己的屏幕（pia-screen：独立 X 显示器 + VNC + cua-driver 守护进程），默认大家在主屏幕上；
 * 浏览器是一个共用的 Chromium（主屏幕上，一个用户目录 → 共用 cookie），每个助理只操作自己的标签页。
 * 家目录是持久化卷，登录态长期保留。noVNC 端口只绑定到 127.0.0.1，由 pi-assistant-server 鉴权后反向代理（按 token 选屏幕）。
 */
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { createConnection, createServer } from "node:net";
import { backend, engine, engineCommand } from "./desktop/backend.ts";
import { instanceResources as limaInstanceResources } from "./desktop/lima.ts";
import { IdleTracker } from "./desktop/idle.ts";
import { checkDiskGrowOnly, resourceBounds, suggestResources } from "./desktop/resources.ts";
import { imagePresent, installState, startInstall } from "./desktop/image.ts";
import { computerFor, describeScreens, isSharedComputer, legacySeparate, MAIN, mainScreenDecision, ownScreenKey, SHARED, type Lease } from "./desktop/computers.ts";
import { containerName, LABEL, labelValues, safeId, volumeName } from "./desktop/names.ts";
import { desktopSettings, localImage, markLegacyMigrated, setSeparate } from "./desktop/settings.ts";
import { db } from "./db.ts";

const docker = engine;
/** 这个助理用的电脑的容器名（共用电脑 = pia-desk-shared） */
export const containerOf = (agentId: string) => containerName(computerFor(agentId));
export { computerFor, SHARED };
const agentRows = () => db.prepare("SELECT id, name FROM agents").all() as { id: string; name: string }[];
const agentName = (id: string) => agentRows().find((a) => a.id === id)?.name ?? id;
/** 用某台电脑的助理 */
export const agentsOn = (computerId: string) => agentRows().map((a) => a.id).filter((id) => computerFor(id) === computerId);

export interface DesktopStatus {
	/** 能不能启动（已开启 + 后端可用 + 镜像已下载） */
	available: boolean;
	reason?: string;
	/** 「给助理安装电脑」开关 */
	enabled: boolean;
	/** 镜像已下载 */
	installed: boolean;
	state: "none" | "stopped" | "starting" | "running";
	port?: number;
	/** 容器里浏览器调试端口（经 socat 转发）在宿主 127.0.0.1 上的映射 */
	cdpPort?: number;
	image: string;
	backend: string;
	install: ReturnType<typeof installState>;
	idleMinutes: number;
	/** 虚拟机 / 发行版后端（macOS Lima、Windows WSL）：运行时本身的状态与阶段说明，例如“正在启动虚拟机” */
	vm?: { running: boolean; phase: string; detail?: string };
	/** 这个助理用的电脑：shared = 和其他助理共用 */
	computer?: { id: string; shared: boolean; agents: { id: string; name: string }[] };
	/** 这个助理现在用的屏幕（main = 主屏幕）和这台电脑上的所有屏幕 */
	screen?: string;
	screens?: { key: string; label: string; agentId?: string; mine: boolean }[];
}

let availability: { ok: boolean; installed: boolean; reason?: string; at: number } | null = null;
export const resetAvailability = () => void (availability = null);
async function available() {
	if (availability && Date.now() - availability.at < 30_000) return availability;
	const d = await backend().detect();
	if (!d.ok) availability = { ok: false, installed: false, reason: d.reason, at: Date.now() };
	else {
		const installed = await imagePresent();
		availability = { ok: installed, installed, at: Date.now(), reason: installed ? undefined : "助理电脑还没下载完" };
	}
	return availability;
}

const starting = new Set<string>();
/** 某个助理看到的状态：它的电脑的状态 + 它的屏幕 */
export async function desktopStatus(agentId: string): Promise<DesktopStatus> {
	const cid = computerFor(agentId);
	const st = await computerStatus(cid);
	const agents = isSharedComputer(cid) ? agentsOn(cid).map((id) => ({ id, name: agentName(id) })) : [{ id: agentId, name: agentName(agentId) }];
	const out: DesktopStatus = { ...st, computer: { id: cid, shared: isSharedComputer(cid), agents } };
	if (st.state === "running") {
		const scr = await screensOf(cid);
		const mine = screenOf(agentId);
		out.screen = mine;
		out.screens = scr.map((x) => ({ key: x.key, agentId: x.agentId, mine: x.key === mine, label: x.key === MAIN ? "主屏幕" : `${x.agentId ? agentName(x.agentId) : x.key} 的屏幕` }));
	}
	return out;
}
/** 一台电脑（共用 / 单独）的状态 */
async function computerStatus(agentId: string): Promise<DesktopStatus> {
	const s = desktopSettings();
	const common = { enabled: s.enabled, image: localImage(), backend: backend().id, install: installState(), idleMinutes: s.idleMinutes };
	if (!s.enabled) return { ...common, available: false, installed: false, state: "none", reason: "还没有安装助理电脑，去 设置 › 助理电脑 开启" };
	const a = await available();
	const base = { ...common, available: a.ok, installed: a.installed, reason: a.reason };
	if (!a.ok) return { ...base, state: "none" };
	if (backend().fixedPorts) {
		// 虚拟机关机时不为了查状态而开机：桌面一定是关着的
		const ph = backend().phase?.() ?? { phase: "idle" };
		const running = await backend().engineRunning();
		const vm = { running, phase: ph.phase, detail: ph.detail };
		if (!running) return { ...base, vm, state: starting.has(agentId) ? "starting" : "stopped" };
		Object.assign(base, { vm });
	}
	try {
		const { stdout } = await docker(["inspect", "-f", "{{.State.Running}} {{json .NetworkSettings.Ports}}", containerName(agentId)]);
		const out = String(stdout).trim();
		const running = out.split(" ")[0];
		const ports = JSON.parse(out.slice(running.length + 1) || "{}") as Record<string, { HostPort: string }[] | null>;
		const hp = (k: string) => (ports[k]?.[0]?.HostPort ? Number(ports[k]![0].HostPort) : undefined);
		if (starting.has(agentId)) return { ...base, state: "starting" };
		if (running !== "true") return { ...base, state: "stopped" };
		let port = hp("6080/tcp");
		let cdpPort = hp("9223/tcp");
		if (backend().fixedPorts && (!port || !cdpPort)) {
			const lp = new Map(await labelPorts(containerName(agentId)));
			port ??= lp.get(6080);
			cdpPort ??= lp.get(9223);
		}
		return { ...base, state: "running", port, cdpPort };
	} catch (e) {
		if (starting.has(agentId)) return { ...base, state: "starting" };
		const msg = String((e as { stderr?: string }).stderr ?? "");
		if (/No such object|No such container|no such container/i.test(msg)) return { ...base, state: "none" };
		return { ...base, state: "stopped" };
	}
}

const inflight = new Map<string, Promise<DesktopStatus>>();
/** 按需启动（打开「电脑」标签 / 助理要用电脑工具时调用）：启动这个助理用的电脑；同一台电脑并发调用只启动一次 */
export async function startDesktop(agentId: string): Promise<DesktopStatus> {
	const cid = computerFor(agentId);
	await startComputer(cid);
	touchAgent(agentId);
	return desktopStatus(agentId);
}
function startComputer(cid: string): Promise<DesktopStatus> {
	const cur = inflight.get(cid);
	if (cur) return cur;
	const p = doStart(cid).finally(() => (inflight.delete(cid), starting.delete(cid), notify(cid)));
	inflight.set(cid, p);
	return p;
}
/** 状态变了：通知用这台电脑的所有助理的界面 */
function notify(cid: string) {
	if (!onChange) return;
	if (isSharedComputer(cid)) for (const id of agentsOn(cid)) onChange(id);
	else onChange(cid);
}
async function doStart(cid: string): Promise<DesktopStatus> {
	const st = await computerStatus(cid);
	if (!st.available) throw new Error(st.reason);
	if (st.state === "running") return (idle.touch(cid), st);
	starting.add(cid);
	notify(cid);
	await backend().ensureEngine();
	await migrateLegacy().catch((e) => console.warn(`[desktop] 旧版数据检查失败：${e instanceof Error ? e.message : e}`));
	const fixed = !!backend().fixedPorts;
	if (fixed) {
		// 虚拟机刚开机：重新看一次容器在不在
		starting.delete(cid);
		const again = await computerStatus(cid);
		starting.add(cid);
		if (again.state === "running" && again.port) return (starting.delete(cid), idle.touch(cid), again);
		st.state = again.state === "none" ? "none" : "stopped";
	}
	const name = containerName(cid);
	// 旧版容器没有发布浏览器调试端口 / 镜像版本变了 / （虚拟机后端）上次的宿主端口现在被 Mac 上别的程序占了：
	// 删掉容器重建（家目录在独立卷里，登录态不受影响）
	const hostNet = !!backend().hostNetwork;
	if (st.state !== "none" && (!(fixed ? (await labelPorts(name)).length === (hostNet ? 4 : 2) : await hasPort(name, "9223/tcp")) || (await containerImage(name)) !== localImage() || (fixed && !(await boundPortsFree(name))))) {
		await docker(["rm", "-f", name]).catch(() => {});
		st.state = "none";
	}
	forgetScreens(cid); // 开机后只有主屏幕
	if (st.state === "stopped") await docker(["start", name]);
	if (st.state === "none") {
		// 不设 --restart：空闲关机后不会被引擎自动拉起，下次按需再启动。共用电脑多给一些资源（几个助理同时用）
		const res = isSharedComputer(cid) ? ["--cpus", "4", "--memory", "6g"] : ["--cpus", "2", "--memory", "3g"];
		await docker(["run", "-d", "--name", name, "--shm-size", "2g", "--log-opt", "max-size=10m", "--log-opt", "max-file=2", ...res, ...(await runNetArgs(cid)), "-v", `${volumeName(cid)}:/home/agent`, "--label", `${LABEL}=${cid}`, localImage()], { timeout: 120_000 });
	}
	starting.delete(cid);
	return await waitStarted(cid, name, fixed);
}

/**
 * 等新开机的电脑真正可用。不靠 `logs --since`（虚拟机里的时钟可能和 Mac 差几秒到几分钟，会一直等不到 “ready”），
 * 直接探测桌面（VNC / noVNC / cua-driver / 屏幕非空白）。超时按进度算：每有新进展就再给 90 秒，总共最多 10 分钟；
 * 只有长时间卡在同一步才算超时，错误第一行是中文摘要，后面附卡住的步骤和容器日志末尾。
 */
async function waitStarted(cid: string, name: string, fixed: boolean): Promise<DesktopStatus> {
	const t0 = Date.now();
	const HARD = 10 * 60_000;
	let deadline = t0 + 120_000;
	let step = "等容器运行";
	const progress = (s: string) => {
		if (s !== step) (step = s), (deadline = Math.min(t0 + HARD, Math.max(deadline, Date.now() + 90_000)));
	};
	while (Date.now() < deadline) {
		const s = await computerStatus(cid);
		if (s.state === "running" && s.port) {
			const r = await probeComputer(cid);
			if (r.ready && (!fixed || (await reachable(s.port)))) {
				readyOnce.add(cid);
				return (idle.touch(cid), await computerStatus(cid));
			}
			progress(r.ready ? "等端口转发到本机" : r.reason);
		} else if (s.state === "stopped" || s.state === "none") {
			throw new Error(await exitedMessage(name));
		}
		await new Promise((r) => setTimeout(r, 700));
	}
	throw new Error(`助理电脑启动超时（卡在：${step}），可以再点一次开机\n已等 ${Math.round((Date.now() - t0) / 1000)} 秒，卡在：${step}\n${await logTail(name)}`);
}
/** 容器退出码的含义（给错误详情用；126/127 多半是镜像和本机架构不匹配或程序缺失） */
export function exitCodeMeaning(code: number): string {
	if (code === 126) return "程序无法执行（权限不足或二进制与本机 CPU 架构不匹配，如 Exec format error）";
	if (code === 127) return "找不到要运行的程序";
	if (code === 137) return "被强制结束（SIGKILL，常见于内存不足）";
	if (code === 139) return "程序崩溃（段错误）";
	if (code === 143) return "被正常结束（SIGTERM）";
	if (code > 128) return `被信号 ${code - 128} 结束`;
	if (code === 0) return "正常退出";
	return "程序出错退出";
}
async function exitedMessage(name: string): Promise<string> {
	const code = await docker(["inspect", "--format", "{{.State.ExitCode}}", name], { timeout: 15_000 }).then(
		(r) => Number.parseInt(String(r.stdout).trim(), 10),
		() => Number.NaN,
	);
	const head = Number.isFinite(code) ? `助理电脑开机后又退出了（退出码 ${code}：${exitCodeMeaning(code)}）` : "助理电脑开机后又退出了";
	return `${head}\n${await logTail(name)}`;
}
const logTail = (name: string) =>
	docker(["logs", "--tail", "40", name], { timeout: 15_000 }).then(
		(r) => `容器日志（末尾）：\n${String(r.stdout)}${String(r.stderr ?? "")}`.slice(-4000),
		(e) => `读取容器日志失败：${e instanceof Error ? e.message : e}`,
	);

// ---------------------------------------------------------------- 旧版（每个助理一台电脑）数据迁移
/**
 * 第一次在引擎可用时检查一次：已经有自己电脑家目录卷（pia-home-<助理id>）的现有助理，默认保留为“单独的电脑”，
 * 登录状态、文件都不丢；用户之后可以在设置里把它合并到共用电脑。
 */
export async function migrateLegacy() {
	if (desktopSettings().legacyMigrated) return [];
	const { stdout } = await docker(["volume", "ls", "--filter", "name=pia-home-", "--format", "{{.Name}}"]);
	const keep = legacySeparate(String(stdout).split("\n"), agentRows().map((a) => a.id));
	markLegacyMigrated(keep);
	if (keep.length) console.log(`[desktop] 共用电脑：${keep.length} 个助理已有自己电脑的数据，保留为单独的电脑（可在设置里合并）`);
	return keep;
}
async function volumeExists(name: string) {
	return docker(["volume", "inspect", name]).then(() => true, () => false);
}
/** 这个助理有没有单独电脑留下的数据（家目录卷） */
export async function hasSeparateData(agentId: string) {
	if (backend().fixedPorts && !(await backend().engineRunning())) return null; // 虚拟机关着：不为了查询而开机
	return volumeExists(volumeName(agentId));
}
/** 开 / 关“单独的电脑”。关掉时数据保留（以后再开回来还在），可以用 mergeIntoShared 合并到共用电脑 */
export async function setSeparateComputer(agentId: string, on: boolean) {
	const before = computerFor(agentId);
	setSeparate(agentId, on);
	const after = computerFor(agentId);
	if (before !== after) {
		// 离开原来的电脑：释放在那台电脑上的屏幕、记录
		await releaseScreen(agentId, before).catch(() => {});
		mainLease.get(before)?.agentId === agentId && mainLease.delete(before);
		if (!isSharedComputer(before)) await stopComputer(before);
		notify(before);
		notify(after);
	}
	return desktopStatus(agentId);
}
/**
 * 把一个助理单独电脑的数据合并进共用电脑：两台电脑都要先关机。浏览器登录状态（Chromium 用户目录）和微信这类
 * “整个目录才有意义”的应用数据：共用电脑里还没有就整个搬过去，已经有了就放进 ~/旧电脑-<助理名>/ 里（不会把两份混在一起弄坏）；
 * 其他文件按“不覆盖已有文件”合并。成功后删掉单独电脑的容器和卷，这个助理改用共用电脑。
 */
export async function mergeIntoShared(agentId: string, busy: (agentId: string) => boolean) {
	// 数据源永远是这个助理的单独电脑卷（pia-home-<id>）。助理可能已经改回共用电脑，但卷还在（设置里「合并进共用电脑」就是这种情形）。
	const separateId = safeId(agentId);
	if (!(await volumeExists(volumeName(separateId)))) throw new Error("没有可合并的单独电脑数据");
	if (busy(agentId)) throw new Error("这个助理正在工作，等它做完再合并");
	const others = agentsOn(SHARED).filter(busy);
	if (others.length) throw new Error(`共用电脑正在被使用（${others.map(agentName).join("、")}），稍后再合并`);
	await backend().ensureEngine();
	await stopComputer(separateId);
	await stopComputer(SHARED);
	const label = agentName(agentId).replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 32) || safeLabel(agentId);
	const helper = containerName(`merge-${separateId}`.slice(0, 64));
	await docker(["rm", "-f", helper]).catch(() => {});
	await docker(["volume", "create", volumeName(SHARED)]);
	const { stdout } = await docker(["run", "--rm", "--name", helper, "--label", `${LABEL}=merge`, "-u", "0", "--entrypoint", "bash", "-v", `${volumeName(separateId)}:/from:ro`, "-v", `${volumeName(SHARED)}:/to`, localImage(), "-c", MERGE_SCRIPT, "merge", label], { timeout: 30 * 60_000 });
	setSeparate(agentId, false);
	await docker(["rm", "-f", containerName(separateId)]).catch(() => {});
	await docker(["volume", "rm", volumeName(separateId)]).catch(() => {});
	notify(SHARED);
	onChange?.(agentId);
	return String(stdout).trim().split("\n").pop() ?? "";
}
const safeLabel = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "助理";
/** 合并脚本（在一次性的辅助容器里跑，参数 $1 = 放旧数据的子目录名后缀）。纯 bash + tar/cp，单测检查语法 */
export const MERGE_SCRIPT = [
	"set -euo pipefail",
	'old="/to/旧电脑-$1"',
	"moved=(); kept=()",
	// 整个目录才有意义的应用数据：浏览器用户目录、Chromium 默认目录、微信（程序 + 聊天数据）
	"for d in .config/pia-browser .config/chromium .local/wechat .xwechat Documents/xwechat_files; do",
	'  [ -e "/from/$d" ] || continue',
	'  if [ -e "/to/$d" ]; then mkdir -p "$old/$(dirname "$d")"; cp -a "/from/$d" "$old/$d"; kept+=("$d"); else mkdir -p "/to/$(dirname "$d")"; cp -a "/from/$d" "/to/$d"; moved+=("$d"); fi',
	"done",
	// 其他文件：不覆盖已有的
	"cd /from && tar --exclude=./.config/pia-browser --exclude=./.config/chromium --exclude=./.local/wechat --exclude=./.xwechat --exclude=./Documents/xwechat_files -cf - . | (cd /to && tar --skip-old-files -xf -)",
	"chown -R 1000:1000 /to 2>/dev/null || true",
	'echo "merged moved=${#moved[@]} kept=${#kept[@]}"',
].join("\n");

/**
 * 桌面容器的网络参数：
 * - docker：随机宿主端口，只绑定 127.0.0.1
 * - 虚拟机（Lima）：宿主端口由我们挑 Mac 上空闲的，虚拟机里发布同号端口，Lima 转发到 Mac 的 127.0.0.1（虚拟机网络只有本机能到）
 * - host 网络（WSL）：发行版里的所有桌面共用一个网络，noVNC / 浏览器调试转发 / VNC / Chromium 调试端口和 X 显示器编号
 *   都由我们分配并经环境变量交给 start.sh；全部只监听 127.0.0.1，WSL 自动转发到 Windows 的 127.0.0.1
 * 端口都记在标签里（关机的容器也能读到，不依赖各引擎 inspect 格式的差异）
 */
async function runNetArgs(cid: string): Promise<string[]> {
	const b = backend();
	if (b.hostNetwork) {
		const [novnc, cdpProxy, vnc, cdp] = await freePorts(4);
		const display = pickDisplay(await usedDisplays(containerName(cid)));
		return hostNetArgs({ novnc, cdpProxy, vnc, cdp, display });
	}
	if (b.fixedPorts) {
		const [vnc, cdp] = await freePorts(2);
		return ["-p", `0.0.0.0:${vnc}:6080`, "-p", `0.0.0.0:${cdp}:9223`, "--label", `${PORTS_LABEL}=6080:${vnc},9223:${cdp}`];
	}
	return ["-p", "127.0.0.1::6080", "-p", "127.0.0.1::9223"];
}
/** host 网络的 run 参数（纯函数，单测） */
export function hostNetArgs(p: { novnc: number; cdpProxy: number; vnc: number; cdp: number; display: number }) {
	const env = { DISPLAY_NUM: p.display, DISPLAY: `:${p.display}`, NOVNC_PORT: p.novnc, CDP_PROXY_PORT: p.cdpProxy, VNC_PORT: p.vnc, CDP_PORT: p.cdp, BIND_ADDR: "127.0.0.1" };
	return [
		"--network", "host",
		...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
		"--label", `${PORTS_LABEL}=6080:${p.novnc},9223:${p.cdpProxy},5900:${p.vnc},9222:${p.cdp}`,
		"--label", `${DISPLAY_LABEL}=${p.display}`,
	];
}
/** 选一个其他桌面没用的 X 显示器编号（host 网络下 X 的抽象套接字按编号区分，必须错开），从 10 开始 */
export function pickDisplay(used: Set<number>) {
	for (let d = 10; d < 1000; d++) if (!used.has(d)) return d;
	throw new Error("没有可用的显示器编号");
}
async function usedDisplays(except: string): Promise<Set<number>> {
	const out = new Set<number>();
	try {
		const { stdout } = await docker(["ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.Names}}"]);
		for (const n of String(stdout).split("\n").map((x) => x.trim()).filter((x) => x && x !== except)) {
			const v = Number((await containerLabels(n))[DISPLAY_LABEL]);
			if (v > 0) out.add(v);
		}
	} catch {}
	return out;
}
/** 一次挑多个互不相同的空闲端口 */
async function freePorts(n: number) {
	const out: number[] = [];
	while (out.length < n) {
		const p = await freePort();
		if (!out.includes(p)) out.push(p);
	}
	return out;
}
const DISPLAY_LABEL = "pia.display";
async function containerLabels(name: string): Promise<Record<string, string>> {
	try {
		const { stdout } = await docker(["inspect", "-f", "{{json .Config.Labels}}", name]);
		return (JSON.parse(String(stdout)) ?? {}) as Record<string, string>;
	} catch {
		return {};
	}
}
/** 容器里 Chromium 调试端口（host 网络的桌面各不相同，其余是 9222） */
async function innerCdpPort(name: string) {
	return new Map(await labelPorts(name)).get(9222) ?? 9222;
}

class DesktopNotReady extends Error {}
/**
 * 桌面就绪检查（一次 docker exec）：X 服务器能连上、窗口管理器（xfwm4）和桌面（xfdesktop）在跑、
 * VNC（5900）和 noVNC（6080）在监听、cua-driver 守护进程在跑，且整屏截图不是纯色（标准差 > 0.01）。
 * 输出 “ok <标准差>” 或 “wait <原因>”。
 */
export const READY_PROBE = [
	'export DISPLAY=":${DISPLAY_NUM:-1}"',
	"xdpyinfo >/dev/null 2>&1 || { echo 'wait X'; exit 0; }",
	"pgrep -x xfwm4 >/dev/null || { echo 'wait 窗口管理器'; exit 0; }",
	"pgrep -x xfdesktop >/dev/null || { echo 'wait 桌面'; exit 0; }",
	"(exec 3<>/dev/tcp/127.0.0.1/${VNC_PORT:-5900}) 2>/dev/null || { echo 'wait VNC'; exit 0; }",
	"(exec 3<>/dev/tcp/127.0.0.1/${NOVNC_PORT:-6080}) 2>/dev/null || { echo 'wait noVNC'; exit 0; }",
	"pgrep -f 'cua-driver serve' >/dev/null || { echo 'wait cua-driver'; exit 0; }",
	"sd=$(import -window root -colorspace gray -format '%[fx:standard_deviation]' info: 2>/dev/null)",
	"awk -v s=\"${sd:-0}\" 'BEGIN{ if (s+0 > 0.01) print \"ok \" s; else print \"wait 屏幕还是空白\" }'",
].join("; ");
export function parseReadyProbe(out: string): { ready: boolean; reason: string } {
	const line = out.trim().split("\n").pop() ?? "";
	return line.startsWith("ok") ? { ready: true, reason: line } : { ready: false, reason: line.replace(/^wait\s*/, "") || "未知" };
}
async function probeComputer(cid: string) {
	try {
		const { stdout } = await docker(["exec", containerName(cid), "bash", "-c", READY_PROBE], { timeout: 15_000 });
		return parseReadyProbe(String(stdout));
	} catch (e) {
		return { ready: false, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) };
	}
}
export const probeDesktop = (agentId: string) => probeComputer(computerFor(agentId));
/** 等到桌面真正可用（默认最多 60 秒） */
async function waitComputerReady(cid: string, timeoutMs = 60_000) {
	const end = Date.now() + timeoutMs;
	let last = "";
	while (Date.now() < end) {
		const r = await probeComputer(cid);
		if (r.ready) return;
		last = r.reason;
		await new Promise((res) => setTimeout(res, 500));
	}
	throw new DesktopNotReady(`助理电脑桌面没有准备好（${last}）`);
}
export const waitDesktopReady = (agentId: string, timeoutMs = 60_000) => waitComputerReady(computerFor(agentId), timeoutMs);
/** Mac 上一个空闲的 127.0.0.1 端口 */
export function freePort(): Promise<number> {
	return new Promise((res, rej) => {
		const srv = createServer();
		srv.unref();
		srv.on("error", rej);
		srv.listen(0, "127.0.0.1", () => {
			const p = (srv.address() as { port: number }).port;
			srv.close(() => res(p));
		});
	});
}
/** 宿主端口现在能不能被我们用（没被别的程序占） */
function portFree(port: number): Promise<boolean> {
	return new Promise((res) => {
		const srv = createServer();
		srv.once("error", () => res(false));
		srv.listen(port, "127.0.0.1", () => srv.close(() => res(true)));
	});
}
export function reachable(port: number, timeout = 1500): Promise<boolean> {
	return new Promise((res) => {
		const s = createConnection({ host: "127.0.0.1", port, timeout });
		s.once("connect", () => (s.destroy(), res(true)));
		s.once("error", () => res(false));
		s.once("timeout", () => (s.destroy(), res(false)));
	});
}
const PORTS_LABEL = "pia.ports";
/** 容器标签里记的端口映射：[[容器端口, 宿主端口]] */
async function labelPorts(name: string): Promise<[number, number][]> {
	const v = (await containerLabels(name))[PORTS_LABEL] ?? "";
	return v.split(",").map((x) => x.split(":").map(Number) as [number, number]).filter(([a, b]) => a > 0 && b > 0);
}
async function boundPortsFree(name: string) {
	{
		const ports = (await labelPorts(name)).map(([, h]) => h);
		if (!ports.length) return false;
		for (const p of ports) if (!(await portFree(p))) return false;
		return true;
	}
}

async function containerImage(name: string) {
	try {
		const { stdout } = await docker(["inspect", "-f", "{{.Config.Image}}", name]);
		return String(stdout).trim();
	} catch {
		return "";
	}
}

async function hasPort(name: string, port: string) {
	try {
		const { stdout } = await docker(["inspect", "-f", "{{json .HostConfig.PortBindings}}", name]);
		return port in (JSON.parse(String(stdout)) ?? {});
	} catch {
		return false;
	}
}

/**
 * 确保这个助理用的电脑里的 Chromium 在跑（主屏幕上有界面，出现在「电脑」实时画面里），并开着调试端口给 Playwright 连。
 * 一台电脑只有一个 Chromium 进程、一个用户目录（/home/agent/.config/pia-browser）：共用电脑上的助理共用登录状态，
 * 每个助理经自己的 CDP 连接只操作自己的标签页（ext-browser 的 shared 模式）。返回宿主上的 CDP 地址。
 */
export async function ensureDesktopBrowser(agentId: string): Promise<string> {
	const cid = computerFor(agentId);
	const st = await computerStatus(cid);
	if (st.state !== "running" || !st.cdpPort) throw new Error("助理电脑没有运行");
	const name = containerName(cid);
	const port = await innerCdpPort(name);
	const up = () => docker(["exec", name, "curl", "-sf", `http://127.0.0.1:${port}/json/version`], { timeout: 5000 }).then(() => true, () => false);
	if (!(await up())) {
		// 两个助理同时第一次用浏览器：只启动一次
		const key = `browser:${cid}`;
		let p = browserStarting.get(key);
		if (!p) {
			p = (async () => {
				// DISPLAY 继承容器环境 = 主屏幕（镜像默认 :1；host 网络的桌面在 run 时设了各自的编号）
				await docker(["exec", "-d", name, "chromium", ...desktopChromiumArgs(port)]);
				for (let i = 0; i < 40 && !(await up()); i++) await new Promise((r) => setTimeout(r, 250));
			})().finally(() => browserStarting.delete(key));
			browserStarting.set(key, p);
		}
		await p;
		if (!(await up())) throw new Error("助理电脑里的浏览器没有启动起来");
	}
	return `http://127.0.0.1:${st.cdpPort}`;
}
const browserStarting = new Map<string, Promise<void>>();
/** 容器即沙箱边界，Chromium 自带的沙箱在非特权容器里无法启用。几个助理的标签页同时在后台工作：不要因为窗口被挡住就降速 */
export const desktopChromiumArgs = (port = 9222) => DESKTOP_CHROMIUM_ARGS.map((a) => (a === "--remote-debugging-port=9222" ? `--remote-debugging-port=${port}` : a));
export const DESKTOP_CHROMIUM_ARGS = ["--user-data-dir=/home/agent/.config/pia-browser", "--remote-debugging-port=9222", "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--disable-dev-shm-usage", "--start-maximized", "--lang=zh-CN", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "about:blank"];

/** 「电脑」标签里的关机：这个助理用的电脑（共用电脑会影响所有用它的助理，界面上会提示） */
export async function stopDesktop(agentId: string) {
	await stopComputer(computerFor(agentId));
	return desktopStatus(agentId);
}
async function stopComputer(cid: string) {
	// 先让浏览器正常退出（把 cookie / 登录状态写到磁盘），再关容器：直接 docker stop（或 SIGTERM）会丢掉最近的登录
	await closeBrowserGracefully(cid).catch(() => {});
	await docker(["stop", "-t", "5", containerName(cid)]).catch(() => {});
	readyOnce.delete(cid);
	idle.forget(cid);
	forgetScreens(cid);
	mainLease.delete(cid);
	await stopEngineIfIdle();
	notify(cid);
}

/** 经 CDP 让电脑里的 Chromium 正常关闭（Browser.close 会把 cookie 写盘），最多等 8 秒 */
async function closeBrowserGracefully(cid: string) {
	const st = await computerStatus(cid);
	if (st.state !== "running" || !st.cdpPort) return;
	const v = (await (await fetch(`http://127.0.0.1:${st.cdpPort}/json/version`, { signal: AbortSignal.timeout(2000) })).json()) as { webSocketDebuggerUrl?: string };
	if (!v.webSocketDebuggerUrl) return;
	// 调试转发把地址里的主机写成容器内的，换成我们连得到的端口
	const u = new URL(v.webSocketDebuggerUrl);
	u.hostname = "127.0.0.1";
	u.port = String(st.cdpPort);
	await new Promise<void>((resolve) => {
		const ws = new WebSocket(u.toString());
		const done = () => (clearTimeout(t), resolve());
		const t = setTimeout(() => (ws.terminate(), resolve()), 3000);
		ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: "Browser.close" })));
		ws.on("close", done);
		ws.on("error", done);
	});
	for (let i = 0; i < 25; i++) {
		const alive = await docker(["exec", containerName(cid), "pgrep", "-x", "chromium"], { timeout: 5000 }).then(() => true, () => false);
		if (!alive) return;
		await new Promise((r) => setTimeout(r, 200));
	}
}

/** 正在运行的我们自己的电脑（按 pia.agent 标签过滤） → 电脑 id 列表（shared 或助理 id） */
export async function runningDesktops(): Promise<string[]> {
	// 虚拟机关机：一定没有在跑的桌面（不为了查询而开机）
	if (backend().fixedPorts && !(await backend().engineRunning())) return [];
	// {{.Labels}} 是 docker / podman / nerdctl 都支持的格式（k=v,k2=v2）
	const { stdout } = await docker(["ps", "--filter", `label=${LABEL}`, "--format", "{{.Labels}}"]);
	return labelValues(String(stdout), LABEL).filter((v) => v !== "merge");
}
async function allDesktops(): Promise<string[]> {
	if (backend().fixedPorts && !(await backend().engineRunning())) return [];
	const { stdout } = await docker(["ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.Names}}"]);
	return String(stdout).split("\n").map((s) => s.trim()).filter(Boolean);
}
async function stopEngineIfIdle() {
	try {
		if (!(await runningDesktops()).length) await backend().stopEngine();
	} catch {}
}

/** 关掉开关时：关机（全部电脑 + 虚拟机），登录状态保留 */
export async function shutdownAll() {
	try {
		for (const id of await runningDesktops()) await docker(["stop", "-t", "3", containerName(id)]).catch(() => {});
	} catch {}
	screens.clear();
	agentScreen.clear();
	mainLease.clear();
	await backend().stopEngine().catch(() => {});
}
/** 删除虚拟机和镜像释放空间：删我们的容器、家目录卷（登录状态清掉）、镜像，最后删虚拟机/发行版 */
export async function purgeAll() {
	await shutdownAll();
	const names = await allDesktops().catch(() => [] as string[]);
	for (const n of names) await docker(["rm", "-f", n]).catch(() => {});
	const { stdout } = await docker(["volume", "ls", "--filter", "name=pia-home-", "--format", "{{.Name}}"]).catch(() => ({ stdout: "" }));
	const vols = String(stdout).split("\n").map((s) => s.trim()).filter((v) => /^pia-home-/.test(v));
	if (vols.length) await docker(["volume", "rm", ...vols]).catch(() => {});
	await docker(["image", "rm", localImage()]).catch(() => {});
	await backend().destroyEngine().catch(() => {});
	resetAvailability();
}

// ---------------------------------------------------------------- 屏幕：同一台电脑里每个助理可以有自己的屏幕
interface Screen {
	key: string;
	display: number;
	port?: number;
	agentId?: string;
}
/** 电脑 id → 屏幕（不含主屏幕）；开机 / 关机时清空。服务重启后从容器里的 pia-screen ls 恢复 */
const screens = new Map<string, Map<string, Screen>>();
/** 助理 → 它在自己电脑上用的屏幕（没有 = 主屏幕） */
const agentScreen = new Map<string, string>();
/** 电脑 id → 最近在主屏幕上操作的助理 */
const mainLease = new Map<string, Lease>();
/** 助理最近一次用电脑的时间（自己的屏幕空闲了自动收回） */
const agentLastUse = new Map<string, number>();
export const touchAgent = (agentId: string) => (agentLastUse.set(agentId, Date.now()), idle.touch(computerFor(agentId)));
/**
 * 虚拟机资源信息（只读，不开机）：用户选择、这台机器的建议值与可调范围、现有实例实际值。
 * 只有 macOS 自带虚拟机（Lima）能在这里调：Docker 由 Docker Desktop 管，WSL2 由 Windows 的 .wslconfig 管，
 * 在这些后端上显示“不可调”而不是假装能调。
 */
export function vmResourceInfo() {
	const b = backend();
	const supported = b.id === "lima";
	return {
		supported,
		choice: desktopSettings().resources,
		suggested: suggestResources(),
		bounds: resourceBounds(),
		applied: supported ? limaInstanceResources() : null,
		note: supported ? null : "只有 macOS 自带虚拟机（Lima）能在这里调 CPU / 内存 / 磁盘。用 Docker 时资源由 Docker Desktop 管，用 WSL2 时由 Windows 的 .wslconfig 管。",
	};
}
/** 用户选的磁盘比现有虚拟机小 → 中文错误（只扩不缩，避免重建丢数据） */
export const vmResourceDiskError = (choice: { diskGiB?: number }) => (backend().id === "lima" ? checkDiskGrowOnly(choice, limaInstanceResources()) : null);
function forgetScreens(cid: string) {
	const m = screens.get(cid);
	screens.delete(cid);
	for (const s of m?.values() ?? []) if (s.agentId) agentScreen.delete(s.agentId);
	for (const id of [...agentScreen.keys()]) if (computerFor(id) === cid) agentScreen.delete(id);
}
export const screenOf = (agentId: string) => agentScreen.get(agentId) ?? MAIN;
const ownerOfKey = (cid: string, key: string) => (isSharedComputer(cid) ? agentsOn(cid) : [cid]).find((id) => ownScreenKey(id) === key);
/** 这台电脑上的屏幕（主屏幕 + 现有的）；内存里没有记录时从容器里恢复 */
async function screensOf(cid: string): Promise<Screen[]> {
	let m = screens.get(cid);
	if (!m) {
		m = new Map();
		try {
			const { stdout } = await docker(["exec", containerName(cid), "pia-screen", "ls"], { timeout: 10_000 });
			for (const line of String(stdout).split("\n")) {
				const [key, d, port] = line.trim().split(/\s+/);
				if (!key || key === MAIN) continue;
				const agentId = ownerOfKey(cid, key);
				m.set(key, { key, display: Number(d), port: Number(port), agentId });
				if (agentId) agentScreen.set(agentId, key);
			}
		} catch {}
		screens.set(cid, m);
	}
	return [{ key: MAIN, display: -1 }, ...m.values()];
}
/** 主屏幕的显示器编号（host 网络的电脑各不相同，其余是 1） */
async function mainDisplay(cid: string) {
	return Number((await containerLabels(containerName(cid)))[DISPLAY_LABEL]) || 1;
}
/** 这个助理的屏幕的显示器编号 */
export async function displayOf(agentId: string) {
	const cid = computerFor(agentId);
	await screensOf(cid);
	const key = screenOf(agentId);
	const s = screens.get(cid)?.get(key);
	return s ? s.display : mainDisplay(cid);
}
/** 给这个助理开一块自己的屏幕（同一台电脑、同一个家目录），之后它的 cua 操作、截图都在这块屏幕上 */
export async function ensureOwnScreen(agentId: string): Promise<Screen> {
	const cid = computerFor(agentId);
	const st = await computerStatus(cid);
	if (st.state !== "running") throw new Error("助理电脑没有运行");
	await screensOf(cid);
	const key = ownScreenKey(agentId);
	const m = screens.get(cid)!;
	const cur = m.get(key);
	if (cur) {
		agentScreen.set(agentId, key);
		await docker(["exec", containerName(cid), "pia-screen", "assign", safeKey(agentId), key], { timeout: 10_000 });
		return cur;
	}
	// VNC 端口：host 网络（WSL）的电脑共用一个网络，由我们挑空闲的；其他情况在容器自己的网络里，按顺序取
	const used = new Set([...m.values()].map((s) => s.display));
	const taken = new Set([...m.values()].map((x) => x.port));
	let port = 5910;
	while (taken.has(port)) port++;
	if (backend().hostNetwork) port = await freePort();
	const { stdout } = await docker(["exec", containerName(cid), "pia-screen", "add", key, String(port)], { timeout: 30_000 });
	const display = Number(String(stdout).trim().split("\n").pop());
	if (!(display >= 0) || used.has(display)) throw new Error("新屏幕没有启动起来");
	await docker(["exec", containerName(cid), "pia-screen", "assign", safeKey(agentId), key], { timeout: 10_000 });
	const s: Screen = { key, display, port, agentId };
	m.set(key, s);
	agentScreen.set(agentId, key);
	if (mainLease.get(cid)?.agentId === agentId) mainLease.delete(cid);
	notify(cid);
	return s;
}
/** 容器里 pia-screen / pia-cua-mcp 用的助理名（只留安全字符） */
const safeKey = (agentId: string) => agentId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "agent";
/** 删除助理：关掉它在共用电脑上的屏幕；单独的电脑关机并从列表里去掉（家目录卷和以前一样保留） */
export async function forgetAgentComputer(agentId: string) {
	const cid = computerFor(agentId);
	await releaseScreen(agentId, cid).catch(() => {});
	if (mainLease.get(cid)?.agentId === agentId) mainLease.delete(cid);
	agentLastUse.delete(agentId);
	if (!isSharedComputer(cid)) {
		await stopComputer(cid).catch(() => {});
		setSeparate(agentId, false);
	}
}
/** 回到主屏幕：关掉这个助理自己的屏幕（上面的窗口会关掉） */
export async function releaseScreen(agentId: string, cid = computerFor(agentId)) {
	const key = agentScreen.get(agentId);
	agentScreen.delete(agentId);
	if (!key) return;
	screens.get(cid)?.delete(key);
	await docker(["exec", containerName(cid), "pia-screen", "rm", key], { timeout: 15_000 }).catch(() => {});
	notify(cid);
}
/**
 * 会改变屏幕的电脑动作执行前（ext-computer 的 before）：主屏幕最近被另一个还在工作的助理用着 → 给这个助理开自己的屏幕，
 * 拦下这次动作让它先看新屏幕（之前算好的坐标 / 窗口在新屏幕上不成立）。单独的电脑只有它自己，不用管。
 */
export async function beforeComputerAction(agentId: string, busy: (agentId: string) => boolean): Promise<string | null> {
	touchAgent(agentId);
	const cid = computerFor(agentId);
	if (!isSharedComputer(cid) || screenOf(agentId) !== MAIN) return null;
	const lease = mainLease.get(cid);
	if (mainScreenDecision(agentId, lease, Date.now(), busy) === "ok") {
		mainLease.set(cid, { agentId, at: Date.now() });
		return null;
	}
	await ensureOwnScreen(agentId);
	return `主屏幕现在正被「${agentName(lease!.agentId)}」操作，为了不抢鼠标键盘，已经给你开了一块自己的屏幕（同一台电脑：同样的文件、浏览器登录状态和已装的应用）。这次操作没有执行：先用 computer_screenshot 看看新屏幕，再在新屏幕上重新打开需要的应用继续。顺便告诉用户你换到了自己的屏幕。`;
}
/** computer_screen 工具 */
export function screenTools(agentId: string) {
	const list = async () => {
		const cid = computerFor(agentId);
		const scr = await screensOf(cid);
		const head = isSharedComputer(cid) ? `你在用共用电脑（${agentsOn(cid).map(agentName).join("、")} 共用文件和登录状态）。` : "你在用自己单独的电脑。";
		return `${head}\n屏幕：\n${describeScreens(scr, agentId, screenOf(agentId), agentName)}`;
	};
	return {
		list,
		own: async () => {
			if (!isSharedComputer(computerFor(agentId))) return "你在用自己单独的电脑，主屏幕只有你在用，不需要另开屏幕。";
			await ensureOwnScreen(agentId);
			return `已切换到你自己的屏幕。之后的电脑操作和截图都在这块屏幕上（共用浏览器的窗口还在主屏幕上，浏览器操作照常用 browser_* 工具）。先用 computer_screenshot 看看。\n${await list()}`;
		},
		main: async () => {
			await releaseScreen(agentId);
			return `已回到主屏幕。\n${await list()}`;
		},
		separate: async (on: boolean, reason: string) => {
			if (on === !isSharedComputer(computerFor(agentId))) return on ? "你已经在用单独的电脑。" : "你已经在用共用电脑。";
			console.log(`[desktop] ${agentId} ${on ? "开启" : "关闭"}单独的电脑：${reason}`);
			await setSeparateComputer(agentId, on);
			return on
				? "已为你开启“单独的电脑”（自己的家目录和登录状态，和其他助理完全分开）。从用户的下一条消息开始生效；告诉用户你这样做的原因。之前在共用电脑里的登录状态在单独的电脑里没有，需要时重新登录。"
				: "已改回共用电脑（从下一条消息开始生效）。单独电脑里的数据保留着，用户可以在 设置 › 助理电脑 里合并到共用电脑。";
		},
	};
}

// ---------------------------------------------------------------- 按需启停：空闲自动关机（按电脑计时）
export const idle = new IdleTracker();
let vmIdleSince = 0;
const installBusy = () => installState().phase === "downloading";
let onChange: ((agentId: string) => void) | null = null;
/** 电脑忙：用它的任何一个助理在跑任务 */
const computerBusy = (busy: (agentId: string) => boolean) => (cid: string) => (isSharedComputer(cid) ? agentsOn(cid) : [cid]).some(busy);
export interface IdleWatcherDeps {
	busy: (agentId: string) => boolean;
	changed: (agentId: string) => void;
	intervalMs?: number;
	/** 以下可选参数供单测注入假时钟 / 假后端，不真睡眠、不碰真虚拟机 */
	now?: () => number;
	tracker?: IdleTracker;
	running?: () => Promise<string[]>;
	stop?: (cid: string) => Promise<void>;
	release?: (agentId: string) => Promise<void>;
	engineRunning?: () => Promise<boolean>;
	stopEngine?: () => Promise<void>;
	fixedPorts?: boolean;
	settings?: () => { enabled: boolean; idleMinutes: number };
}
/** main/http 启动时调用：每 30 秒检查一次；busy 由 runtime 提供（对话/后台任务/定时任务在跑）。返回 { stop, tick } 方便单测手动推进 */
export function startIdleWatcher(opts: IdleWatcherDeps) {
	onChange = opts.changed;
	const now = opts.now ?? Date.now;
	const tracker = opts.tracker ?? idle;
	const listRunning = opts.running ?? runningDesktops;
	const stopOne = opts.stop ?? stopComputer;
	const release = opts.release ?? releaseScreen;
	const engineRunning = opts.engineRunning ?? (() => backend().engineRunning());
	const stopEngine = opts.stopEngine ?? (() => backend().stopEngine());
	const fixedPorts = opts.fixedPorts ?? backend().fixedPorts === true;
	const readSettings = opts.settings ?? (() => {
		const s = desktopSettings();
		return { enabled: s.enabled, idleMinutes: s.idleMinutes };
	});
	const tick = async () => {
		const s = readSettings();
		if (!s.enabled || !s.idleMinutes) return;
		let running: string[];
		try {
			running = await listRunning();
		} catch {
			return;
		}
		// 虚拟机开着但一个桌面都没在跑（例如 App 重启前留下的、下载完镜像后的）：同样空闲时间后关掉虚拟机
		if (!running.length && !starting.size && fixedPorts) {
			if (!(await engineRunning())) vmIdleSince = 0;
			else if (!vmIdleSince) vmIdleSince = now();
			else if (now() - vmIdleSince >= s.idleMinutes * 60_000 && !installBusy()) {
				console.log(`[desktop] 虚拟机空闲超过 ${s.idleMinutes} 分钟，关机`);
				vmIdleSince = 0;
				await stopEngine().catch(() => {});
				opts.changed("");
			}
		} else vmIdleSince = 0;
		// 自己的屏幕：这个助理空闲超过设定时间就收回（电脑本身可能还有别的助理在用）
		for (const [agentId] of [...agentScreen]) {
			const last = agentLastUse.get(agentId) ?? 0;
			if (!opts.busy(agentId) && now() - last >= s.idleMinutes * 60_000) {
				console.log(`[desktop] ${agentId} 自己的屏幕空闲超过 ${s.idleMinutes} 分钟，收回`);
				await release(agentId).catch(() => {});
			}
		}
		for (const cid of tracker.due(running.filter((r) => !starting.has(r)), computerBusy(opts.busy), s.idleMinutes)) {
			console.log(`[desktop] ${cid === SHARED ? "共用电脑" : cid} 空闲超过 ${s.idleMinutes} 分钟，自动关机`);
			await stopOne(cid);
		}
	};
	const t = setInterval(() => void tick(), opts.intervalMs ?? 30_000);
	t.unref();
	return { stop: () => clearInterval(t), tick };
}
export { startInstall };

/** 这个助理的屏幕的整屏截图（PNG），给模型“看屏幕”或给手机推送扫码画面。 */
export async function screenshotDesktop(agentId: string, screenKey?: string): Promise<Buffer> {
	const cid = computerFor(agentId);
	// 刚开机（或别处启动）时先确认桌面已画出来，避免返回几百字节的纯色图
	if (!readyOnce.has(cid)) {
		await waitComputerReady(cid, 30_000).catch(() => {});
		readyOnce.add(cid);
	}
	let display: number;
	if (screenKey && screenKey !== screenOf(agentId)) {
		await screensOf(cid);
		const s = screens.get(cid)?.get(screenKey);
		display = s ? s.display : await mainDisplay(cid);
	} else display = await displayOf(agentId);
	const { stdout } = await docker(["exec", "-e", `DISPLAY=:${display}`, containerName(cid), "import", "-window", "root", "png:-"], { encoding: "buffer", timeout: 15_000 });
	touchAgent(agentId);
	return stdout as unknown as Buffer;
}
/** 本次服务运行期间确认过就绪的电脑（关机时清掉） */
const readyOnce = new Set<string>();
export const forgetReady = (agentId: string) => readyOnce.delete(computerFor(agentId));

/**
 * cua-driver 的 MCP stdio 命令：在这个助理用的电脑里运行中继 pia-cua-mcp，它按助理当前的屏幕连对应的 cua-driver 守护进程，
 * 换屏幕时自动切换（对 Pi 透明）。
 */
export function cuaMcpCommand(agentId: string): { command: string; args: string[] } {
	return engineCommand(["exec", "-i", containerOf(agentId), "pia-cua-mcp", safeKey(agentId)]);
}

// ---------------------------------------------------------------- 实时画面一次性票据（用于 WebSocket 代理）
const tickets = new Map<string, { agentId: string; screen?: string; exp: number }>();
/** screen：要看哪块屏幕（同一台电脑上的；默认 = 这个助理自己用的屏幕） */
export function issueTicket(agentId: string, screen?: string) {
	const t = randomBytes(18).toString("base64url");
	tickets.set(t, { agentId, screen: screen && /^[A-Za-z0-9_-]{1,64}$/.test(screen) ? screen : undefined, exp: Date.now() + 60_000 });
	return t;
}
export function useTicket(t: string | null): { agentId: string; screen?: string } | null {
	if (!t) return null;
	const v = tickets.get(t);
	tickets.delete(t);
	return v && v.exp > Date.now() ? { agentId: v.agentId, screen: v.screen } : null;
}
/** 实时画面要连的 noVNC token：只能看这个助理所在电脑上存在的屏幕 */
export async function viewToken(agentId: string, screen?: string) {
	const cid = computerFor(agentId);
	const scr = await screensOf(cid);
	const want = screen ?? screenOf(agentId);
	return scr.some((s) => s.key === want) ? want : MAIN;
}
/** 有人在看某个助理的电脑画面 */
export const viewerOpen = (agentId: string) => idle.viewerOpen(computerFor(agentId));
export const viewerClose = (agentId: string) => idle.viewerClose(computerFor(agentId));

// ---------------------------------------------------------------- 一键暂停（按助理）
const paused = new Set<string>();
export const desktopPause = {
	isPaused: (agentId: string) => paused.has(agentId),
	set(agentId: string, v: boolean) {
		if (v) paused.add(agentId);
		else paused.delete(agentId);
	},
};
