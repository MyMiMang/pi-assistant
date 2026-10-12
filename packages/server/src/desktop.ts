/**
 * 助理电脑（sandbox desktop）：共用一个容器引擎（见 desktop/backend.ts），每个助理一个容器（Xvfb + xfce + noVNC + cua-driver），
 * 家目录是持久化卷，登录态长期保留。noVNC 端口只绑定到 127.0.0.1，由 pi-assistant-server 鉴权后反向代理。
 */
import { randomBytes } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { backend, engine, engineCommand } from "./desktop/backend.ts";
import { IdleTracker } from "./desktop/idle.ts";
import { imagePresent, installState, startInstall } from "./desktop/image.ts";
import { vmPhase } from "./desktop/lima.ts";
import { containerName, LABEL, labelValues, volumeName } from "./desktop/names.ts";
import { desktopSettings, localImage } from "./desktop/settings.ts";

const docker = engine;
export const containerOf = containerName;

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
	/** 虚拟机后端（macOS）：虚拟机本身的状态与阶段说明，例如“正在启动虚拟机” */
	vm?: { running: boolean; phase: string; detail?: string };
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
export async function desktopStatus(agentId: string): Promise<DesktopStatus> {
	const s = desktopSettings();
	const common = { enabled: s.enabled, image: localImage(), backend: backend().id, install: installState(), idleMinutes: s.idleMinutes };
	if (!s.enabled) return { ...common, available: false, installed: false, state: "none", reason: "还没有安装助理电脑，去 设置 › 助理电脑 开启" };
	const a = await available();
	const base = { ...common, available: a.ok, installed: a.installed, reason: a.reason };
	if (!a.ok) return { ...base, state: "none" };
	if (backend().fixedPorts) {
		// 虚拟机关机时不为了查状态而开机：桌面一定是关着的
		const ph = vmPhase();
		const running = await backend().engineRunning();
		const vm = { running, phase: ph.phase, detail: ph.detail };
		if (!running) return { ...base, vm, state: starting.has(agentId) ? "starting" : "stopped" };
		Object.assign(base, { vm });
	}
	try {
		const { stdout } = await docker(["inspect", "-f", "{{.State.Running}} {{json .NetworkSettings.Ports}}", containerOf(agentId)]);
		const out = String(stdout).trim();
		const running = out.split(" ")[0];
		const ports = JSON.parse(out.slice(running.length + 1) || "{}") as Record<string, { HostPort: string }[] | null>;
		const hp = (k: string) => (ports[k]?.[0]?.HostPort ? Number(ports[k]![0].HostPort) : undefined);
		if (starting.has(agentId)) return { ...base, state: "starting" };
		if (running !== "true") return { ...base, state: "stopped" };
		let port = hp("6080/tcp");
		let cdpPort = hp("9223/tcp");
		if (backend().fixedPorts && (!port || !cdpPort)) {
			const lp = new Map(await labelPorts(containerOf(agentId)));
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
/** 按需启动（打开「电脑」标签 / 助理要用电脑工具时调用）；同一个助理并发调用只启动一次 */
export function startDesktop(agentId: string): Promise<DesktopStatus> {
	const cur = inflight.get(agentId);
	if (cur) return cur;
	const p = doStart(agentId).finally(() => (inflight.delete(agentId), starting.delete(agentId), onChange?.(agentId)));
	inflight.set(agentId, p);
	return p;
}
async function doStart(agentId: string): Promise<DesktopStatus> {
	const st = await desktopStatus(agentId);
	if (!st.available) throw new Error(st.reason);
	if (st.state === "running") return (idle.touch(agentId), st);
	starting.add(agentId);
	onChange?.(agentId);
	await backend().ensureEngine();
	const fixed = !!backend().fixedPorts;
	if (fixed) {
		// 虚拟机刚开机：重新看一次容器在不在
		starting.delete(agentId);
		const again = await desktopStatus(agentId);
		starting.add(agentId);
		if (again.state === "running" && again.port) return (starting.delete(agentId), idle.touch(agentId), again);
		st.state = again.state === "none" ? "none" : "stopped";
	}
	const name = containerOf(agentId);
	// 旧版容器没有发布浏览器调试端口 / 镜像版本变了 / （虚拟机后端）上次的宿主端口现在被 Mac 上别的程序占了：
	// 删掉容器重建（家目录在独立卷里，登录态不受影响）
	if (st.state !== "none" && (!(fixed ? (await labelPorts(name)).length === 2 : await hasPort(name, "9223/tcp")) || (await containerImage(name)) !== localImage() || (fixed && !(await boundPortsFree(name))))) {
		await docker(["rm", "-f", name]).catch(() => {});
		st.state = "none";
	}
	// 只看这次开机之后的日志（容器日志会保留上次开机时的 “ready”）
	const since = new Date(Date.now() - 1000).toISOString();
	if (st.state === "stopped") await docker(["start", name]);
	if (st.state === "none") {
		// 虚拟机后端：宿主端口由我们挑 Mac 上空闲的，虚拟机里发布同号端口，Lima 转发到 Mac 的 127.0.0.1（虚拟机网络只有本机能到）
		const [vnc, cdp] = fixed ? [await freePort(), await freePort()] : [0, 0];
		const ports = fixed ? [`0.0.0.0:${vnc}:6080`, `0.0.0.0:${cdp}:9223`] : ["127.0.0.1::6080", "127.0.0.1::9223"];
		// 不设 --restart：空闲关机后不会被引擎自动拉起，下次按需再启动
		await docker(
			["run", "-d", "--name", name, "--shm-size", "1g", "--cpus", "2", "--memory", "3g",
				"-p", ports[0], "-p", ports[1], "-v", `${volumeName(agentId)}:/home/agent`, "--label", `${LABEL}=${agentId}`,
				// 虚拟机后端：把宿主端口也记在标签里（关机的容器也能读到，不依赖各引擎 inspect 格式的差异）
				...(fixed ? ["--label", `${PORTS_LABEL}=6080:${vnc},9223:${cdp}`] : []), localImage()],
			{ timeout: 120_000 },
		);
	}
	starting.delete(agentId);
	for (let i = 0; i < 60; i++) {
		const s = await desktopStatus(agentId);
		if (s.state === "running" && s.port) {
			try {
				const { stdout } = await docker(["logs", "--since", since, name]);
				// 虚拟机后端还要等 Lima 把端口转发到 Mac 上（通常 1–2 秒）
				if (String(stdout).includes("pia-desktop ready") && (!fixed || (await reachable(s.port)))) {
					// 容器脚本的 “ready” 只代表进程都拉起了；再等桌面真正画出来（否则第一张截图是空白的）
					await waitDesktopReady(agentId);
					readyOnce.add(agentId);
					return (idle.touch(agentId), await desktopStatus(agentId));
				}
			} catch (e) {
				if (e instanceof DesktopNotReady) throw e;
			}
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error("助理电脑启动超时");
}

class DesktopNotReady extends Error {}
/**
 * 桌面就绪检查（一次 docker exec）：X 服务器能连上、窗口管理器（xfwm4）和桌面（xfdesktop）在跑、
 * VNC（5900）和 noVNC（6080）在监听、cua-driver 守护进程在跑，且整屏截图不是纯色（标准差 > 0.01）。
 * 输出 “ok <标准差>” 或 “wait <原因>”。
 */
export const READY_PROBE = [
	"export DISPLAY=:1",
	"xdpyinfo >/dev/null 2>&1 || { echo 'wait X'; exit 0; }",
	"pgrep -x xfwm4 >/dev/null || { echo 'wait 窗口管理器'; exit 0; }",
	"pgrep -x xfdesktop >/dev/null || { echo 'wait 桌面'; exit 0; }",
	"(exec 3<>/dev/tcp/127.0.0.1/5900) 2>/dev/null || { echo 'wait VNC'; exit 0; }",
	"(exec 3<>/dev/tcp/127.0.0.1/6080) 2>/dev/null || { echo 'wait noVNC'; exit 0; }",
	"pgrep -f 'cua-driver serve' >/dev/null || { echo 'wait cua-driver'; exit 0; }",
	"sd=$(import -window root -colorspace gray -format '%[fx:standard_deviation]' info: 2>/dev/null)",
	"awk -v s=\"${sd:-0}\" 'BEGIN{ if (s+0 > 0.01) print \"ok \" s; else print \"wait 屏幕还是空白\" }'",
].join("; ");
export function parseReadyProbe(out: string): { ready: boolean; reason: string } {
	const line = out.trim().split("\n").pop() ?? "";
	return line.startsWith("ok") ? { ready: true, reason: line } : { ready: false, reason: line.replace(/^wait\s*/, "") || "未知" };
}
export async function probeDesktop(agentId: string) {
	try {
		const { stdout } = await docker(["exec", containerOf(agentId), "bash", "-c", READY_PROBE], { timeout: 15_000 });
		return parseReadyProbe(String(stdout));
	} catch (e) {
		return { ready: false, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) };
	}
}
/** 等到桌面真正可用（默认最多 60 秒） */
export async function waitDesktopReady(agentId: string, timeoutMs = 60_000) {
	const end = Date.now() + timeoutMs;
	let last = "";
	while (Date.now() < end) {
		const r = await probeDesktop(agentId);
		if (r.ready) return;
		last = r.reason;
		await new Promise((res) => setTimeout(res, 500));
	}
	throw new DesktopNotReady(`助理电脑桌面没有准备好（${last}）`);
}
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
	try {
		const { stdout } = await docker(["inspect", "-f", "{{json .Config.Labels}}", name]);
		const v = ((JSON.parse(String(stdout)) ?? {}) as Record<string, string>)[PORTS_LABEL] ?? "";
		return v.split(",").map((x) => x.split(":").map(Number) as [number, number]).filter(([a, b]) => a > 0 && b > 0);
	} catch {
		return [];
	}
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
 * 确保助理电脑里的 Chromium 在跑（有界面，出现在「电脑」实时画面里），并开着调试端口给 Playwright 连。
 * 用户目录在家目录卷里（/home/agent/.config/pia-browser），登录态长期保留。返回宿主上的 CDP 地址。
 */
export async function ensureDesktopBrowser(agentId: string): Promise<string> {
	const st = await desktopStatus(agentId);
	if (st.state !== "running" || !st.cdpPort) throw new Error("助理电脑没有运行");
	const name = containerOf(agentId);
	const up = () => docker(["exec", name, "curl", "-sf", "http://127.0.0.1:9222/json/version"], { timeout: 5000 }).then(() => true, () => false);
	if (!(await up())) {
		await docker(["exec", "-d", "-e", "DISPLAY=:1", name, "chromium", ...DESKTOP_CHROMIUM_ARGS]);
		for (let i = 0; i < 40 && !(await up()); i++) await new Promise((r) => setTimeout(r, 250));
		if (!(await up())) throw new Error("助理电脑里的浏览器没有启动起来");
	}
	return `http://127.0.0.1:${st.cdpPort}`;
}
/** 容器即沙箱边界，Chromium 自带的沙箱在非特权容器里无法启用 */
export const DESKTOP_CHROMIUM_ARGS = ["--user-data-dir=/home/agent/.config/pia-browser", "--remote-debugging-port=9222", "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--disable-dev-shm-usage", "--start-maximized", "--lang=zh-CN", "about:blank"];

export async function stopDesktop(agentId: string) {
	await docker(["stop", "-t", "3", containerOf(agentId)]).catch(() => {});
	readyOnce.delete(agentId);
	idle.forget(agentId);
	await stopEngineIfIdle();
	return desktopStatus(agentId);
}

/** 正在运行的我们自己的桌面（按 pia.agent 标签过滤） → agentId 列表 */
export async function runningDesktops(): Promise<string[]> {
	// 虚拟机关机：一定没有在跑的桌面（不为了查询而开机）
	if (backend().fixedPorts && !(await backend().engineRunning())) return [];
	// {{.Labels}} 是 docker / podman / nerdctl 都支持的格式（k=v,k2=v2）
	const { stdout } = await docker(["ps", "--filter", `label=${LABEL}`, "--format", "{{.Labels}}"]);
	return labelValues(String(stdout), LABEL);
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

/** 关掉开关时：关机（全部桌面 + 虚拟机），登录状态保留 */
export async function shutdownAll() {
	try {
		for (const id of await runningDesktops()) await docker(["stop", "-t", "3", containerOf(id)]).catch(() => {});
	} catch {}
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

// ---------------------------------------------------------------- 按需启停：空闲自动关机
export const idle = new IdleTracker();
let vmIdleSince = 0;
const installBusy = () => installState().phase === "downloading";
let onChange: ((agentId: string) => void) | null = null;
/** main/http 启动时调用：每 30 秒检查一次；busy 由 runtime 提供（对话/后台任务/定时任务在跑） */
export function startIdleWatcher(opts: { busy: (agentId: string) => boolean; changed: (agentId: string) => void; intervalMs?: number }) {
	onChange = opts.changed;
	const tick = async () => {
		const s = desktopSettings();
		if (!s.enabled || !s.idleMinutes) return;
		let running: string[];
		try {
			running = await runningDesktops();
		} catch {
			return;
		}
		// 虚拟机开着但一个桌面都没在跑（例如 App 重启前留下的、下载完镜像后的）：同样空闲时间后关掉虚拟机
		if (!running.length && !starting.size && backend().fixedPorts) {
			if (!(await backend().engineRunning())) vmIdleSince = 0;
			else if (!vmIdleSince) vmIdleSince = Date.now();
			else if (Date.now() - vmIdleSince >= s.idleMinutes * 60_000 && !installBusy()) {
				console.log(`[desktop] 虚拟机空闲超过 ${s.idleMinutes} 分钟，关机`);
				vmIdleSince = 0;
				await backend().stopEngine().catch(() => {});
				opts.changed("");
			}
		} else vmIdleSince = 0;
		for (const id of idle.due(running.filter((r) => !starting.has(r)), opts.busy, s.idleMinutes)) {
			console.log(`[desktop] ${id} 空闲超过 ${s.idleMinutes} 分钟，自动关机`);
			await stopDesktop(id);
			opts.changed(id);
		}
	};
	const t = setInterval(() => void tick(), opts.intervalMs ?? 30_000);
	t.unref();
	return () => clearInterval(t);
}
export { startInstall };

/** 整屏截图（PNG），给模型“看屏幕”或给手机推送扫码画面。 */
export async function screenshotDesktop(agentId: string): Promise<Buffer> {
	// 刚开机（或别处启动）时先确认桌面已画出来，避免返回几百字节的纯色图
	if (!readyOnce.has(agentId)) {
		await waitDesktopReady(agentId, 30_000).catch(() => {});
		readyOnce.add(agentId);
	}
	const { stdout } = await docker(["exec", "-e", "DISPLAY=:1", containerOf(agentId), "import", "-window", "root", "png:-"], { encoding: "buffer", timeout: 15_000 });
	idle.touch(agentId);
	return stdout as unknown as Buffer;
}
/** 本次服务运行期间确认过就绪的助理电脑（关机时清掉） */
const readyOnce = new Set<string>();
export const forgetReady = (agentId: string) => readyOnce.delete(agentId);

/** cua-driver 的 MCP stdio 命令：在助理电脑容器里运行。 */
export function cuaMcpCommand(agentId: string): { command: string; args: string[] } {
	return engineCommand(["exec", "-i", "-e", "DISPLAY=:1", containerOf(agentId), "cua-driver", "mcp"]);
}

// ---------------------------------------------------------------- 实时画面一次性票据（用于 WebSocket 代理）
const tickets = new Map<string, { agentId: string; exp: number }>();
export function issueTicket(agentId: string) {
	const t = randomBytes(18).toString("base64url");
	tickets.set(t, { agentId, exp: Date.now() + 60_000 });
	return t;
}
export function useTicket(t: string | null): string | null {
	if (!t) return null;
	const v = tickets.get(t);
	tickets.delete(t);
	return v && v.exp > Date.now() ? v.agentId : null;
}

// ---------------------------------------------------------------- 一键暂停
const paused = new Set<string>();
export const desktopPause = {
	isPaused: (agentId: string) => paused.has(agentId),
	set(agentId: string, v: boolean) {
		if (v) paused.add(agentId);
		else paused.delete(agentId);
	},
};
