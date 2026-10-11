/**
 * 内置隧道：管理 cloudflared 快速隧道子进程（无需账号），拿到 https://*.trycloudflare.com 地址，
 * 签名后上报 Rendezvous（入口域名），地址变化时通过 Web Push 通知已配对设备。
 * 只用 WebSocket（快速隧道不支持 SSE）。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bus } from "./bus.ts";
import { config } from "./config.ts";
import { getSetting } from "./db.ts";
import { identity, registrationMessage, signText } from "./identity.ts";
import { notify } from "./push.ts";

export interface TunnelStatus {
	enabled: boolean;
	state: "off" | "starting" | "online" | "error" | "missing";
	url: string | null;
	error?: string;
	rendezvous: { state: "idle" | "ok" | "error"; at?: number; error?: string };
	binary: string | null;
}

let child: ChildProcess | null = null;
let backoff = 2000;
let heartbeat: NodeJS.Timeout | null = null;
const status: TunnelStatus = { enabled: false, state: "off", url: null, rendezvous: { state: "idle" }, binary: null };

function emit() {
	bus.emit({ type: "tunnel.status", status: { ...status } });
}
export const tunnelStatus = () => ({ ...status });
export const entryDomain = () => getSetting<string>("entryDomain", config.defaultEntryDomain);

export function findCloudflared(): string | null {
	const exe = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
	const candidates = [config.cloudflared, join(config.dataDir, "bin", exe), join(import.meta.dirname, "..", "bin", exe)].filter(Boolean) as string[];
	for (const c of candidates) if (existsSync(c)) return c;
	for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) if (dir && existsSync(join(dir, exe))) return join(dir, exe);
	return null;
}

async function register(url: string) {
	const { serverId, publicKey } = identity();
	const ts = Date.now();
	const sig = signText(registrationMessage(serverId, url, ts));
	try {
		const res = await fetch(`https://${entryDomain()}/api/servers/${serverId}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ url, ts, sig, publicKey }),
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		status.rendezvous = { state: "ok", at: ts };
	} catch (e) {
		status.rendezvous = { state: "error", at: ts, error: e instanceof Error ? e.message : String(e) };
	}
	emit();
}

export function startTunnel() {
	status.enabled = true;
	if (child) return;
	const bin = findCloudflared();
	status.binary = bin;
	if (!bin) {
		status.state = "missing";
		status.error = "没有找到 cloudflared（安装包会内置；开发环境可放到 数据目录/bin/ 或 PATH 中）";
		emit();
		return;
	}
	status.state = "starting";
	status.error = undefined;
	emit();
	const p = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${config.port}`], { stdio: ["ignore", "pipe", "pipe"] });
	child = p;
	let pendingUrl: string | null = null;
	const watchdog = setTimeout(() => {
		if (status.state !== "online") {
			status.state = "error";
			status.error = "隧道地址已分配，但连不上 Cloudflare 网络（可能是出站 7844 端口/QUIC 被防火墙阻止）";
			emit();
		}
	}, 45_000);
	watchdog.unref();
	const goOnline = (url: string) => {
		const prev = status.url;
		status.url = url;
		status.state = "online";
		status.error = undefined;
		backoff = 2000;
		clearTimeout(watchdog);
		emit();
		void register(url);
		if (prev && prev !== url) notify({ title: "胡好好的访问地址已更新", body: "点开即可重新连接", data: { type: "server-url", serverId: identity().serverId, url } });
	};
	const onData = (d: Buffer) => {
		const text = d.toString();
		const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
		if (m) {
			pendingUrl = m[0];
			status.error = undefined;
			emit();
		}
		// 只有真正建立了到 Cloudflare 边缘的连接才算在线
		if (/Registered tunnel connection/i.test(text) && pendingUrl) goOnline(pendingUrl);
	};
	p.stdout?.on("data", onData);
	p.stderr?.on("data", onData);
	p.on("exit", (code) => {
		child = null;
		clearTimeout(watchdog);
		status.state = status.enabled ? "error" : "off";
		status.error = status.enabled ? `cloudflared 退出（${code}），${Math.round(backoff / 1000)} 秒后重试` : undefined;
		emit();
		if (status.enabled) {
			setTimeout(() => status.enabled && startTunnel(), backoff).unref();
			backoff = Math.min(backoff * 2, 60_000);
		}
	});
	heartbeat ??= setInterval(() => status.url && status.state === "online" && void register(status.url), 30 * 60_000);
	heartbeat.unref();
}

export function stopTunnel() {
	status.enabled = false;
	status.url = null;
	status.state = "off";
	child?.kill();
	child = null;
	emit();
}
