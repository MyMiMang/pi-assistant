/**
 * 助理电脑（sandbox desktop）：每个助理一个 Docker 容器（Xvfb + xfce + noVNC + cua-driver），
 * 家目录是持久化卷，登录态长期保留。noVNC 端口只绑定到 127.0.0.1，由 pi-assistant-server 鉴权后反向代理。
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.ts";

const run = promisify(execFile);
const docker = (args: string[], opts: { timeout?: number; encoding?: "buffer" } = {}) =>
	run(config.docker[0], [...config.docker.slice(1), ...args], { timeout: opts.timeout ?? 20_000, maxBuffer: 64 * 1024 * 1024, encoding: opts.encoding as never });

const safe = (id: string) => id.replace(/[^a-zA-Z0-9_.-]/g, "");
export const containerOf = (agentId: string) => `pia-desk-${safe(agentId)}`;

export interface DesktopStatus {
	available: boolean;
	reason?: string;
	state: "none" | "stopped" | "running";
	port?: number;
	/** 容器里浏览器调试端口（经 socat 转发）在宿主 127.0.0.1 上的映射 */
	cdpPort?: number;
	image: string;
}

let availability: { ok: boolean; reason?: string; at: number } | null = null;
async function available() {
	if (availability && Date.now() - availability.at < 30_000) return availability;
	try {
		await docker(["image", "inspect", config.desktopImage], { timeout: 5000 });
		availability = { ok: true, at: Date.now() };
	} catch (e) {
		const msg = String((e as { stderr?: string }).stderr ?? e);
		availability = { ok: false, at: Date.now(), reason: /No such image|not found/i.test(msg) ? `还没有助理电脑镜像 ${config.desktopImage}` : "Docker 不可用（需要安装并启动 Docker Desktop）" };
	}
	return availability;
}

export async function desktopStatus(agentId: string): Promise<DesktopStatus> {
	const a = await available();
	const base = { available: a.ok, reason: a.reason, image: config.desktopImage };
	if (!a.ok) return { ...base, state: "none" };
	try {
		const { stdout } = await docker(["inspect", "-f", "{{.State.Running}} {{json .NetworkSettings.Ports}}", containerOf(agentId)]);
		const out = String(stdout).trim();
		const running = out.split(" ")[0];
		const ports = JSON.parse(out.slice(running.length + 1) || "{}") as Record<string, { HostPort: string }[] | null>;
		const hp = (k: string) => (ports[k]?.[0]?.HostPort ? Number(ports[k]![0].HostPort) : undefined);
		return running === "true" ? { ...base, state: "running", port: hp("6080/tcp"), cdpPort: hp("9223/tcp") } : { ...base, state: "stopped" };
	} catch (e) {
		const msg = String((e as { stderr?: string }).stderr ?? "");
		if (/No such object|No such container/i.test(msg)) return { ...base, state: "none" };
		return { ...base, state: "stopped" };
	}
}

export async function startDesktop(agentId: string): Promise<DesktopStatus> {
	const st = await desktopStatus(agentId);
	if (!st.available) throw new Error(st.reason);
	const name = containerOf(agentId);
	// 旧版容器没有发布浏览器调试端口：删掉容器重建（家目录在独立卷里，登录态不受影响）
	if (st.state !== "none" && !(await hasPort(name, "9223/tcp"))) {
		await docker(["rm", "-f", name]).catch(() => {});
		st.state = "none";
	}
	if (st.state === "stopped") await docker(["start", name]);
	if (st.state === "none")
		await docker(
			["run", "-d", "--name", name, "--restart", "unless-stopped", "--shm-size", "1g", "--cpus", "2", "--memory", "3g",
				"-p", "127.0.0.1::6080", "-p", "127.0.0.1::9223", "-v", `pia-home-${safe(agentId)}:/home/agent`, "--label", "pia.agent=" + agentId, config.desktopImage],
			{ timeout: 120_000 },
		);
	for (let i = 0; i < 60; i++) {
		const s = await desktopStatus(agentId);
		if (s.state === "running" && s.port) {
			try {
				const { stdout } = await docker(["logs", name]);
				if (String(stdout).includes("pia-desktop ready")) return s;
			} catch {}
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error("助理电脑启动超时");
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
	return desktopStatus(agentId);
}

/** 整屏截图（PNG），给模型“看屏幕”或给手机推送扫码画面。 */
export async function screenshotDesktop(agentId: string): Promise<Buffer> {
	const { stdout } = await docker(["exec", "-e", "DISPLAY=:1", containerOf(agentId), "import", "-window", "root", "png:-"], { encoding: "buffer", timeout: 15_000 });
	return stdout as unknown as Buffer;
}

/** cua-driver 的 MCP stdio 命令：在助理电脑容器里运行。 */
export function cuaMcpCommand(agentId: string): { command: string; args: string[] } {
	return { command: config.docker[0], args: [...config.docker.slice(1), "exec", "-i", "-e", "DISPLAY=:1", containerOf(agentId), "cua-driver", "mcp"] };
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
