/**
 * 助理电脑（sandbox desktop）：共用一个容器引擎（见 desktop/backend.ts），每个助理一个容器（Xvfb + xfce + noVNC + cua-driver），
 * 家目录是持久化卷，登录态长期保留。noVNC 端口只绑定到 127.0.0.1，由 pi-assistant-server 鉴权后反向代理。
 */
import { randomBytes } from "node:crypto";
import { backend, engine, engineCommand } from "./desktop/backend.ts";
import { IdleTracker } from "./desktop/idle.ts";
import { imagePresent, installState, startInstall } from "./desktop/image.ts";
import { containerName, LABEL, volumeName } from "./desktop/names.ts";
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
	try {
		const { stdout } = await docker(["inspect", "-f", "{{.State.Running}} {{json .NetworkSettings.Ports}}", containerOf(agentId)]);
		const out = String(stdout).trim();
		const running = out.split(" ")[0];
		const ports = JSON.parse(out.slice(running.length + 1) || "{}") as Record<string, { HostPort: string }[] | null>;
		const hp = (k: string) => (ports[k]?.[0]?.HostPort ? Number(ports[k]![0].HostPort) : undefined);
		if (starting.has(agentId)) return { ...base, state: "starting" };
		return running === "true" ? { ...base, state: "running", port: hp("6080/tcp"), cdpPort: hp("9223/tcp") } : { ...base, state: "stopped" };
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
	const name = containerOf(agentId);
	// 旧版容器没有发布浏览器调试端口 / 镜像版本变了：删掉容器重建（家目录在独立卷里，登录态不受影响）
	if (st.state !== "none" && (!(await hasPort(name, "9223/tcp")) || (await containerImage(name)) !== localImage())) {
		await docker(["rm", "-f", name]).catch(() => {});
		st.state = "none";
	}
	// 只看这次开机之后的日志（容器日志会保留上次开机时的 “ready”）
	const since = new Date(Date.now() - 1000).toISOString();
	if (st.state === "stopped") await docker(["start", name]);
	if (st.state === "none")
		// 不设 --restart：空闲关机后不会被引擎自动拉起，下次按需再启动
		await docker(
			["run", "-d", "--name", name, "--shm-size", "1g", "--cpus", "2", "--memory", "3g",
				"-p", "127.0.0.1::6080", "-p", "127.0.0.1::9223", "-v", `${volumeName(agentId)}:/home/agent`, "--label", `${LABEL}=${agentId}`, localImage()],
			{ timeout: 120_000 },
		);
	starting.delete(agentId);
	for (let i = 0; i < 60; i++) {
		const s = await desktopStatus(agentId);
		if (s.state === "running" && s.port) {
			try {
				const { stdout } = await docker(["logs", "--since", since, name]);
				if (String(stdout).includes("pia-desktop ready")) return (idle.touch(agentId), s);
			} catch {}
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error("助理电脑启动超时");
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
	idle.forget(agentId);
	await stopEngineIfIdle();
	return desktopStatus(agentId);
}

/** 正在运行的我们自己的桌面（按 pia.agent 标签过滤） → agentId 列表 */
export async function runningDesktops(): Promise<string[]> {
	const { stdout } = await docker(["ps", "--filter", `label=${LABEL}`, "--format", `{{.Label "${LABEL}"}}`]);
	return String(stdout).split("\n").map((s) => s.trim()).filter(Boolean);
}
async function allDesktops(): Promise<string[]> {
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
	const { stdout } = await docker(["exec", "-e", "DISPLAY=:1", containerOf(agentId), "import", "-window", "root", "png:-"], { encoding: "buffer", timeout: 15_000 });
	idle.touch(agentId);
	return stdout as unknown as Buffer;
}

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
