/**
 * 远程访问隧道（cloudflared 子进程），两种模式：
 *  - named（固定地址，优先）：用户自己的 Cloudflare 账号里的命名隧道，地址固定 https://<sub>.<zone>，不需要 Rendezvous。
 *  - quick（临时地址，兜底）：trycloudflare 快速隧道，无需账号，地址每次变化，靠 Rendezvous / 重新扫码。
 *
 * 重试策略（绝不快速重试）：普通失败 30s → 1m → 2m → 5m → 10m → 15m（带抖动），连续 8 次后停止自动重试；
 * trycloudflare 返回 429（限流）时冷却 10–30 分钟（随机抖动，多次 429 逐步加长，上限 60 分钟）。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { bus } from "./bus.ts";
import { cfStatus, cfToken } from "./cloudflare.ts";
import { ensureCloudflared } from "./cloudflared-bin.ts";
import { config } from "./config.ts";
import { getSetting } from "./db.ts";
import { identity, registrationMessage, signText } from "./identity.ts";
import { checkNamedPerms, namedConfig, namedRunToken, type PermCheck, setupNamedTunnel } from "./named-tunnel.ts";
import { notify } from "./push.ts";
import { BRAND } from "@pi-assistant/shared";

export { findCloudflared } from "./cloudflared-bin.ts";

export type TunnelMode = "quick" | "named";
export interface TunnelStatus {
	enabled: boolean;
	state: "off" | "downloading" | "starting" | "online" | "error" | "cooldown" | "missing";
	mode: TunnelMode;
	url: string | null;
	error?: string;
	/** 下一次自动重试的时间（毫秒时间戳） */
	nextRetryAt?: number;
	failures: number;
	rendezvous: { state: "idle" | "off" | "ok" | "error"; at?: number; error?: string };
	binary: string | null;
	/** 固定地址：已配置的主机名，或权限检查结果（缺哪些权限） */
	named: { hostname?: string; check?: PermCheck; error?: string };
}

const MAX_FAILURES = 8;
const BACKOFF = [30_000, 60_000, 120_000, 300_000, 600_000, 900_000];
let child: ChildProcess | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let heartbeat: NodeJS.Timeout | null = null;
let rateLimitHits = 0;
let lastAutoNamedCheck = 0;
const status: TunnelStatus = { enabled: false, state: "off", mode: "quick", url: null, failures: 0, rendezvous: { state: "idle" }, binary: null, named: {} };

function emit() {
	bus.emit({ type: "tunnel.status", status: tunnelStatus() });
}
export const tunnelStatus = (): TunnelStatus => ({ ...status, named: { ...status.named } });
export const entryDomain = (): string | null => getSetting<string | null>("entryDomain", null) || config.entryDomainEnv;
const jitter = (ms: number, spread = 0.2) => Math.round(ms * (1 - spread + Math.random() * spread * 2));
const hhmm = (t: number) => new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

export async function register(url: string) {
	const { serverId, publicKey } = identity();
	const ts = Date.now();
	const domain = entryDomain();
	if (!domain || status.mode === "named") {
		status.rendezvous = { state: "off", at: ts };
		return emit();
	}
	const sig = signText(registrationMessage(serverId, url, ts));
	try {
		const res = await fetch(`https://${domain}/api/servers/${serverId}`, {
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

/** 有 Token 且未明确选择临时地址时，自动尝试固定地址（只做只读权限检查；权限齐全才创建）。 */
async function maybeAutoNamed(): Promise<void> {
	if (namedConfig() || getSetting<string>("tunnelMode", "auto") === "quick") return;
	const zone = cfStatus().config?.zone ?? getSetting<string | null>("namedZone", null);
	if (!zone || !cfToken()) return;
	if (Date.now() - lastAutoNamedCheck < 10 * 60_000 && status.named.check) return;
	lastAutoNamedCheck = Date.now();
	try {
		const check = await checkNamedPerms(zone);
		status.named = { check };
		if (check.ok) {
			const cfg = await setupNamedTunnel({ zone, subdomain: getSetting<string>("namedSubdomain", "pi") });
			status.named = { hostname: cfg.hostname, check };
		}
	} catch (e) {
		status.named = { ...status.named, error: e instanceof Error ? e.message : String(e) };
	}
	emit();
}

export function startTunnel() {
	status.enabled = true;
	if (child || retryTimer) return;
	void launch();
}

/** 用户点“重新连接”：清掉失败计数（429 冷却期内也允许，但会提示可能再次被限流）。 */
export function retryTunnel() {
	if (retryTimer) clearTimeout(retryTimer);
	retryTimer = null;
	status.failures = 0;
	status.nextRetryAt = undefined;
	status.enabled = true;
	child?.kill();
	child = null;
	void launch();
}

/** 配置变化（设置/删除固定地址）后重启隧道进程。 */
export function restartTunnel() {
	if (!status.enabled) return;
	retryTunnel();
}

async function launch() {
	if (!status.enabled || child) return;
	let bin: string;
	try {
		status.state = "downloading";
		status.error = undefined;
		emit();
		bin = await ensureCloudflared((msg) => ((status.error = msg), emit()));
		status.binary = bin;
	} catch (e) {
		status.state = "missing";
		status.error = `cloudflared 不可用：${e instanceof Error ? e.message : String(e)}`;
		return emit();
	}
	await maybeAutoNamed();
	if (!status.enabled || child) return;
	const named = namedConfig();
	const runToken = named ? namedRunToken() : null;
	status.mode = named && runToken ? "named" : "quick";
	status.state = "starting";
	status.error = undefined;
	status.nextRetryAt = undefined;
	if (named) status.named = { ...status.named, hostname: named.hostname };
	emit();

	const args = status.mode === "named" ? ["tunnel", "--no-autoupdate", "run"] : ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${config.port}`];
	// 命名隧道凭据走环境变量，不出现在进程参数里
	const env = status.mode === "named" ? { ...process.env, TUNNEL_TOKEN: runToken! } : process.env;
	const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env });
	child = p;
	let pendingUrl: string | null = status.mode === "named" ? `https://${named!.hostname}` : null;
	let saw429 = false;
	let fatal: string | null = null;
	const watchdog = setTimeout(() => {
		if (status.state !== "online") {
			status.state = "error";
			status.error = "连不上 Cloudflare 网络（可能是出站 7844 端口 / QUIC 被防火墙阻止），仍在尝试…";
			emit();
		}
	}, 45_000);
	watchdog.unref();
	const goOnline = (url: string) => {
		const prev = status.url;
		status.url = url;
		status.state = "online";
		status.error = undefined;
		status.failures = 0;
		rateLimitHits = 0;
		clearTimeout(watchdog);
		emit();
		void register(url);
		if (prev && prev !== url) notify({ title: `${BRAND.name} 的访问地址已更新`, body: "点开即可重新连接", data: { type: "server-url", serverId: identity().serverId, url } });
	};
	const onData = (d: Buffer) => {
		const text = d.toString();
		if (status.mode === "quick") {
			const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
			if (m) pendingUrl = m[0];
			if (/\b429\b|Too Many Requests|rate.?limit/i.test(text)) saw429 = true;
		} else if (/Unauthorized|invalid token|Invalid tunnel secret|tunnel not found/i.test(text)) {
			fatal = "固定地址的隧道凭据已失效（隧道可能在 Cloudflare 后台被删除），请在「远程访问」里重新设置固定地址。";
		}
		// 只有真正建立了到 Cloudflare 边缘的连接才算在线
		if (/Registered tunnel connection/i.test(text) && pendingUrl) goOnline(pendingUrl);
	};
	p.stdout?.on("data", onData);
	p.stderr?.on("data", onData);
	p.on("exit", (code) => {
		if (child === p) child = null;
		clearTimeout(watchdog);
		if (!status.enabled) {
			status.state = "off";
			return emit();
		}
		status.url = status.mode === "named" ? status.url : null;
		status.failures++;
		if (fatal) {
			status.state = "error";
			status.error = fatal;
			return emit();
		}
		let delay: number;
		if (saw429) {
			rateLimitHits++;
			const base = (10 + Math.random() * 20) * 60_000; // 10–30 分钟
			delay = Math.min(base * Math.min(2 ** (rateLimitHits - 1), 3), 60 * 60_000);
			status.state = "cooldown";
			status.error = `Cloudflare 临时隧道服务限流（429）：短时间内申请次数太多。将在 ${hhmm(Date.now() + delay)} 自动重试（约 ${Math.round(delay / 60_000)} 分钟后）。设置“固定地址”可以彻底避免这个问题。`;
		} else if (status.failures >= MAX_FAILURES) {
			status.state = "error";
			status.error = `cloudflared 已连续失败 ${status.failures} 次（最后退出码 ${code}），已停止自动重试。请检查网络后点“重新连接”。`;
			status.nextRetryAt = undefined;
			return emit();
		} else {
			delay = jitter(BACKOFF[Math.min(status.failures - 1, BACKOFF.length - 1)]);
			status.state = "error";
			status.error = `cloudflared 退出（${code}），${delay >= 60_000 ? `${Math.round(delay / 60_000)} 分钟` : `${Math.round(delay / 1000)} 秒`}后重试（第 ${status.failures}/${MAX_FAILURES} 次）`;
		}
		status.nextRetryAt = Date.now() + delay;
		emit();
		retryTimer = setTimeout(() => {
			retryTimer = null;
			if (status.enabled) void launch();
		}, delay);
		retryTimer.unref();
	});
	heartbeat ??= setInterval(() => status.url && status.state === "online" && void register(status.url), 30 * 60_000);
	heartbeat.unref();
}

export function stopTunnel() {
	status.enabled = false;
	status.url = null;
	status.state = "off";
	status.error = undefined;
	status.nextRetryAt = undefined;
	status.failures = 0;
	if (retryTimer) clearTimeout(retryTimer);
	retryTimer = null;
	child?.kill();
	child = null;
	emit();
}
