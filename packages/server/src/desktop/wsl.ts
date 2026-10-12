/**
 * Windows 自带运行时（DESIGN §15.2 第 3 步）：WSL2 + 我们自己的发行版 `PiAssistant-Desktop`。
 * - 发行版从我们发布的 rootfs 压缩包（GitHub Release 资产，third-party.json 固定 SHA256）`wsl --import` 到本机数据目录
 *   （%LOCALAPPDATA%\Pi Assistant\wsl，虚拟磁盘不放进漫游配置文件），里面是 containerd + nerdctl。
 * - 一个发行版给所有助理共用；每个助理一个桌面容器，用 host 网络 + 每个助理独立端口（WSL 把发行版里监听 127.0.0.1 的端口
 *   自动转发到 Windows 的 127.0.0.1）。发行版不挂载 Windows 磁盘、不能启动 Windows 程序（rootfs 里的 /etc/wsl.conf）。
 * - 引擎守护进程：我们用 `wsl.exe -d PiAssistant-Desktop -u root --exec /usr/local/bin/pia-engine` 拉起 containerd，
 *   这个进程在，发行版就不会被 WSL 自动关掉；所有桌面都停了 → `wsl --terminate PiAssistant-Desktop` 释放内存。
 * - 没有 WSL：用户点“安装 WSL”后，一次 UAC 管理员确认执行 `wsl --install --no-distribution`，需要重启时明确告诉用户。
 * - 硬性保护：只执行系统目录里的 wsl.exe（绝对路径），只对 PiAssistant-* 发行版下命令（assertWslArgs），
 *   从不 --shutdown（会关掉用户所有发行版）、不 --set-default、不碰用户的发行版和 Docker Desktop。
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { release, uptime } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { config } from "../config.ts";
import { getSetting, setSetting } from "../db.ts";
import { downloadFile, registerDownload, trackDownload, type FileSpec, type Progress } from "../downloads.ts";
import { isOwnWslDistro } from "./names.ts";
import { desktopSettings } from "./settings.ts";

const GiB = 1024 ** 3;
export const WSL_DISTRO = "PiAssistant-Desktop";

// ---------------------------------------------------------------- 清单（third-party.json：pia-wsl-rootfs）
interface Asset { file: string; sha256: string; size: number }
interface Comp { name: string; version: string; repo: string; tagPrefix: string; ghcr?: string; assets: Record<string, Asset> }
let manifestCache: Comp | null = null;
export function rootfsManifest(): Comp {
	if (manifestCache) return manifestCache;
	const j = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "third-party.json"), "utf8")) as { components: Comp[] };
	const c = j.components.find((x) => x.name === "pia-wsl-rootfs");
	if (!c) throw new Error("third-party.json 缺少 pia-wsl-rootfs");
	return (manifestCache = c);
}
/** Windows 的 CPU 架构 → 清单键 */
export function wslArchKey(arch = process.arch) {
	if (arch === "x64") return "win-x64";
	if (arch === "arm64") return "win-arm64";
	throw new Error(`不支持的 CPU 架构：${arch}`);
}

// ---------------------------------------------------------------- 目录
/** 发行版和下载文件放在本机（非漫游）目录：%LOCALAPPDATA%\Pi Assistant\wsl；测试可用 PIA_WSL_HOME */
export function wslHome(env = process.env, dataDir = config.dataDir) {
	if (env.PIA_WSL_HOME) return resolve(env.PIA_WSL_HOME);
	if (env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "Pi Assistant", "wsl");
	return join(dataDir, "vm", "wsl");
}
export const distroDir = () => join(wslHome(), WSL_DISTRO);
const filesDir = () => join(wslHome(), "files");
const importedMarker = () => join(wslHome(), "imported.json");
export function isOwnWslHome(dir: string, env = process.env, dataDir = config.dataDir) {
	const d = resolve(dir);
	const ok = [env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Pi Assistant", "wsl"), join(dataDir, "vm", "wsl"), env.PIA_WSL_HOME && resolve(env.PIA_WSL_HOME)].filter(Boolean) as string[];
	return ok.some((o) => resolve(o) === d) && !/[\\/](Windows|System32)([\\/]|$)/i.test(d);
}

/** 系统自带的 wsl.exe（绝对路径，从不查 PATH）。测试可用 PIA_WSL_EXE 指向假 wsl */
export function wslExe(env = process.env) {
	if (env.PIA_WSL_EXE) return env.PIA_WSL_EXE;
	return join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", "wsl.exe");
}

// ---------------------------------------------------------------- 要下载的文件
/**
 * 下载地址（按顺序尝试，内容都按固定 SHA256 校验）：
 *  1) GHCR blob（公开包里的 OCI 制品，blob 摘要就是压缩包的 SHA256；设置了镜像加速地址时先走加速地址）
 *  2) GitHub Release 资产（设置了 GitHub 加速前缀时先走加速）——仓库公开后可用
 */
export function rootfsFile(arch = process.arch, mirror = desktopSettings().fileMirror, regMirror = desktopSettings().mirror): FileSpec & { label: string; version: string } {
	const m = rootfsManifest();
	const a = m.assets[wslArchKey(arch)];
	if (!a) throw new Error(`没有这台电脑 CPU 架构（${arch}）的助理电脑运行时`);
	const file = a.file.replaceAll("{v}", m.version);
	const urls: string[] = [];
	if (m.ghcr) {
		const [host, ...repo] = m.ghcr.split("/");
		const blob = (h: string) => `https://${h}/v2/${repo.join("/")}/blobs/sha256:${a.sha256}`;
		if (regMirror) urls.push(blob(regMirror));
		urls.push(blob(host));
	}
	const url = `https://github.com/${m.repo}/releases/download/${m.tagPrefix}${m.version}/${file}`;
	if (mirror) urls.push(`${mirror}${url}`);
	urls.push(url);
	if (process.env.PIA_WSL_ROOTFS_URL) urls.unshift(process.env.PIA_WSL_ROOTFS_URL);
	return { label: `助理电脑运行时 ${m.version}`, version: m.version, urls, dest: join(filesDir(), file), algo: "sha256", digest: a.sha256, size: a.size };
}
/** 解析 `WWW-Authenticate: Bearer realm="…",service="…",scope="…"` */
export function parseBearer(h: string | null) {
	if (!h || !/^Bearer\s/i.test(h)) return null;
	const out: Record<string, string> = {};
	for (const m of h.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
	return out.realm ? out : null;
}
const regTokens = new Map<string, string>();
/**
 * 容器镜像仓库的 blob 下载：先直接请求，401 时按 WWW-Authenticate 匿名换 token 再请求（GHCR 和常见加速地址都是这套）。
 * 跳转到存储地址时 fetch 会自动去掉 Authorization（预签名地址不需要），Range 头保留，所以断点续传照常可用。
 */
export function registryFetch(base: typeof fetch = fetch): typeof fetch {
	return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = String(input);
		if (!/\/v2\/.+\/blobs\/sha256:/.test(url)) return base(input, init);
		const host = new URL(url).host;
		const withTok = (t?: string) => ({ ...init, headers: { ...(init.headers as Record<string, string>), ...(t ? { Authorization: `Bearer ${t}` } : {}) } });
		let res = await base(url, withTok(regTokens.get(host)));
		if (res.status !== 401) return res;
		const b = parseBearer(res.headers.get("www-authenticate"));
		if (!b) return res;
		const q = new URLSearchParams();
		if (b.service) q.set("service", b.service);
		if (b.scope) q.set("scope", b.scope);
		const tr = await base(`${b.realm}?${q}`, { signal: init.signal });
		if (!tr.ok) return res;
		const j = (await tr.json()) as { token?: string; access_token?: string };
		const tok = j.token ?? j.access_token;
		if (!tok) return res;
		regTokens.set(host, tok);
		res = await base(url, withTok(tok));
		return res;
	}) as typeof fetch;
}
const rootfsReady = () => {
	try {
		const f = rootfsFile();
		return existsSync(f.dest) && existsSync(`${f.dest}.ok`) && readFileSync(`${f.dest}.ok`, "utf8").trim() === f.digest;
	} catch {
		return false;
	}
};
interface Imported { version: string; digest: string; at: number }
export const importedInfo = (): Imported | null => {
	try {
		return JSON.parse(readFileSync(importedMarker(), "utf8")) as Imported;
	} catch {
		return null;
	}
};

// ---------------------------------------------------------------- 硬性保护：wsl.exe 只对我们的发行版
/**
 * 允许的命令形态（其余一律拒绝）：
 *   --status / --version / --list --verbose（只读）
 *   --install --no-distribution（只装 WSL 本身，不装任何发行版；只经 UAC 提权路径调用）
 *   --import <我们的发行版> <我们的目录> <我们的压缩包> --version 2
 *   --terminate <我们的发行版> / --unregister <我们的发行版>
 *   -d <我们的发行版> -u root [--cd /] --exec <命令…>
 */
export function assertWslArgs(args: string[], ctx = { home: wslHome(), tarball: () => rootfsFile().dest }) {
	const bad = (why: string): never => {
		throw new Error(`拒绝执行 wsl ${args.slice(0, 3).join(" ")}：${why}`);
	};
	const own = (n: string | undefined) => (n === WSL_DISTRO && isOwnWslDistro(n)) || bad(`不是 Pi Assistant 的发行版（${n ?? "未指定"}）`);
	const [a0, a1] = args;
	if (args.length === 1 && (a0 === "--status" || a0 === "--version")) return;
	if (args.length === 2 && ((a0 === "--list" && a1 === "--verbose") || (a0 === "-l" && a1 === "-v"))) return;
	if (args.length === 2 && a0 === "--install" && a1 === "--no-distribution") return;
	if (a0 === "--import") {
		if (args.length !== 6 || args[4] !== "--version" || args[5] !== "2") bad("参数不正确");
		own(a1);
		if (resolve(args[2]) !== resolve(join(ctx.home, WSL_DISTRO))) bad("只能导入到 Pi Assistant 自己的目录");
		if (resolve(args[3]) !== resolve(ctx.tarball())) bad("只能导入 Pi Assistant 下载并校验过的运行时");
		return;
	}
	if ((a0 === "--terminate" || a0 === "-t" || a0 === "--unregister") && args.length === 2) return void own(a1);
	if (a0 === "-d" || a0 === "--distribution") {
		own(a1);
		let i = 2;
		if (args[i] !== "-u" || args[i + 1] !== "root") bad("必须以 -u root 运行");
		i += 2;
		if (args[i] === "--cd") {
			if (args[i + 1] !== "/") bad("--cd 只能是 /");
			i += 2;
		}
		if (args[i] !== "--exec" || !args[i + 1]) bad("必须用 --exec 直接执行命令");
		return;
	}
	bad("不允许的子命令（例如 --shutdown 会关掉你所有的发行版）");
}
/** 运行 wsl.exe：输出强制 UTF-8（WSL_UTF8=1），老版本仍可能输出 UTF-16，统一解码 */
export function decodeWsl(b: Buffer | string) {
	if (typeof b === "string") return b.replace(/\0/g, "");
	const zeros = b.subarray(0, 200).filter((x) => x === 0).length;
	return (zeros > 10 ? b.toString("utf16le") : b.toString("utf8")).replace(/^\uFEFF/, "").replace(/\0/g, "");
}
export function wslEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, WSL_UTF8: "1" };
	delete env.WSLENV; // 不把 Windows 环境变量传进发行版
	return env;
}
export function wsl(args: string[], timeout = 60_000): Promise<{ stdout: string; stderr: string; code: number }> {
	assertWslArgs(args);
	return new Promise((res, rej) => {
		execFile(wslExe(), args, { env: wslEnv(), timeout, encoding: "buffer", windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
			const out = { stdout: decodeWsl(stdout ?? ""), stderr: decodeWsl(stderr ?? ""), code: err ? Number((err as { code?: number }).code ?? 1) || 1 : 0 };
			if (err) return rej(Object.assign(new Error(out.stderr || out.stdout || err.message), out, { killed: (err as { killed?: boolean }).killed }));
			res(out);
		});
	});
}
/** docker 兼容命令前缀：wsl.exe -d PiAssistant-Desktop -u root --cd / --exec nerdctl … */
export function nerdctlCli() {
	const args = ["-d", WSL_DISTRO, "-u", "root", "--cd", "/", "--exec", "nerdctl"];
	assertWslArgs(args);
	return [wslExe(), ...args];
}

// ---------------------------------------------------------------- 环境检测（纯函数，单测）
export interface WinFacts { platform: string; release: string; arch: string }
/** Windows 10 2004（build 19041）起支持 WSL2；家庭版也行 */
export function checkWindows(f: WinFacts): { ok: boolean; reason?: string } {
	if (f.platform !== "win32") return { ok: false, reason: "WSL2 运行时只用于 Windows" };
	const build = Number(f.release.split(".")[2] ?? 0);
	if (!(build >= 19041)) return { ok: false, reason: "助理电脑需要 Windows 10 2004（内部版本 19041）或更新的 Windows 11，请先运行 Windows 更新" };
	if (f.arch !== "x64" && f.arch !== "arm64") return { ok: false, reason: `不支持这台电脑的 CPU 架构（${f.arch}）` };
	return { ok: true };
}
export type WslHealth = "ok" | "missing" | "reboot" | "virtualization" | "update" | "unknown";
/** 把 wsl.exe 的输出 / 错误码归类成用户能理解的状态 */
export function classifyWsl(text: string, code: number): { health: WslHealth; reason?: string } {
	const s = text;
	if (/0x80370102|virtualization.*(not enabled|disabled)|请启用虚拟机平台|BIOS/i.test(s))
		return { health: "virtualization", reason: "这台电脑没有开启硬件虚拟化（在 BIOS / UEFI 里打开 Intel VT-x 或 AMD-V / SVM 后重启），开启后才能运行助理电脑" };
	if (/0x8007019e|0x80370114|0x800701bc|Virtual Machine Platform|虚拟机平台|requires an update to its kernel|内核组件/i.test(s))
		return { health: "reboot", reason: "WSL 还没有准备好：如果刚安装过，请重启电脑；否则点“安装 WSL”" };
	if (/not installed|is not installed|未安装|wsl\.exe.*not (found|recognized)|ENOENT|0x8007007e|0x80070002/i.test(s)) return { health: "missing", reason: "这台电脑还没有安装 WSL（Windows 自带的 Linux 子系统）" };
	if (/unrecognized option|无法识别|invalid command line option.*--no-distribution/i.test(s)) return { health: "update", reason: "这台电脑的 WSL 版本太旧，请先运行 Windows 更新（或在 Microsoft Store 里更新“适用于 Linux 的 Windows 子系统”）" };
	if (code === 0) return { health: "ok" };
	return { health: "unknown", reason: s.trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300) || `WSL 检查失败（${code}）` };
}
/** 磁盘空间：要下载的剩余字节 + 发行版余量（导入解压、镜像层、家目录） */
export function diskShortfall(freeBytes: number, missingDownloadBytes: number, distroExists: boolean) {
	const need = missingDownloadBytes + (distroExists ? 2 : 6) * GiB;
	return freeBytes >= need ? null : `磁盘空间不足：助理电脑还需要约 ${(need / GiB).toFixed(1)} GB，当前只剩 ${(freeBytes / GiB).toFixed(1)} GB。请清理磁盘后再试`;
}
function freeBytes(dir: string) {
	let d = dir;
	while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
	try {
		const s = statfsSync(d);
		return Number(s.bavail) * Number(s.bsize);
	} catch {
		return Number.MAX_SAFE_INTEGER;
	}
}

// ---------------------------------------------------------------- WSL 是否可用 / 安装 WSL（UAC）
const INSTALL_KEY = "desktopWslInstall";
interface InstallRec { at: number; ok: boolean; error?: string }
/** 装过 WSL 但电脑还没重启（安装时间晚于本次开机时间） */
export function rebootPending(rec: InstallRec | null = getSetting<InstallRec | null>(INSTALL_KEY, null), now = Date.now(), up = uptime()) {
	return !!rec?.ok && rec.at > now - up * 1000;
}
let wslProbe: { at: number; r: { health: WslHealth; reason?: string } } | null = null;
export async function probeWsl(force = false): Promise<{ health: WslHealth; reason?: string }> {
	if (!force && wslProbe && Date.now() - wslProbe.at < 30_000) return wslProbe.r;
	let r: { health: WslHealth; reason?: string };
	if (!existsSync(wslExe())) r = { health: "missing", reason: "这台电脑还没有安装 WSL（Windows 自带的 Linux 子系统）" };
	else {
		try {
			const o = await wsl(["--status"], 30_000);
			r = classifyWsl(o.stdout + o.stderr, 0);
		} catch (e) {
			const x = e as { stdout?: string; stderr?: string; code?: number; message?: string };
			r = classifyWsl(`${x.stdout ?? ""}\n${x.stderr ?? ""}\n${x.message ?? ""}`, x.code ?? 1);
		}
	}
	if (r.health !== "ok" && rebootPending()) r = { health: "reboot", reason: "WSL 已安装，需要重启电脑后才能使用助理电脑" };
	wslProbe = { at: Date.now(), r };
	return r;
}
let installing: Promise<{ ok: boolean; reboot: boolean; message: string }> | null = null;
export const wslInstalling = () => !!installing;
/**
 * 安装 WSL：一次 UAC 管理员确认，执行 `wsl --install --no-distribution`（只装 WSL 本身，不装 Ubuntu 等发行版）。
 * 结果：ok + 是否需要重启 + 给用户看的中文说明。
 */
export function installWsl(): Promise<{ ok: boolean; reboot: boolean; message: string }> {
	installing ??= doInstallWsl().finally(() => (installing = null));
	return installing;
}
/** PowerShell 提权命令（纯函数，单测）：Start-Process wsl.exe -Verb RunAs -Wait，返回退出码 */
export function elevationCommand(exe = wslExe()) {
	assertWslArgs(["--install", "--no-distribution"]);
	const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
	const script = `$ErrorActionPreference='Stop'; try { $p = Start-Process -FilePath ${lit(exe)} -ArgumentList '--install','--no-distribution' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode } catch { Write-Output ('PIA_ELEVATION_FAILED ' + $_.Exception.Message); exit 1223 }`;
	const ps = process.env.PIA_POWERSHELL ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	return { command: ps, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script] };
}
async function doInstallWsl() {
	const { command, args } = elevationCommand();
	const r = await new Promise<{ code: number; out: string }>((res) => {
		execFile(command, args, { timeout: 30 * 60_000, windowsHide: true, encoding: "buffer" }, (err, stdout, stderr) =>
			res({ code: err ? Number((err as { code?: number }).code ?? 1) || 1 : 0, out: decodeWsl(stdout ?? "") + decodeWsl(stderr ?? "") }),
		);
	});
	if (r.code === 1223 || /canceled by the user|已取消|PIA_ELEVATION_FAILED.*(cancel|取消)/i.test(r.out)) {
		return { ok: false, reboot: false, message: "你取消了管理员确认，WSL 没有安装。需要时再点“安装 WSL”" };
	}
	// 3010 = ERROR_SUCCESS_REBOOT_REQUIRED
	if (r.code !== 0 && r.code !== 3010) {
		const c = classifyWsl(r.out, r.code);
		setSetting(INSTALL_KEY, { at: Date.now(), ok: false, error: c.reason } satisfies InstallRec);
		return { ok: false, reboot: false, message: `安装 WSL 失败：${c.reason ?? `错误码 ${r.code}`}` };
	}
	wslProbe = null;
	const now = await probeWsl(true).catch(() => ({ health: "unknown" as WslHealth }));
	const reboot = r.code === 3010 || now.health !== "ok";
	setSetting(INSTALL_KEY, { at: Date.now(), ok: true } satisfies InstallRec);
	wslProbe = null;
	return reboot
		? { ok: true, reboot: true, message: "WSL 已安装。请保存好手头的工作后重启电脑，重启后回到这里就能继续安装助理电脑" }
		: { ok: true, reboot: false, message: "WSL 已安装，可以继续安装助理电脑了" };
}

// ---------------------------------------------------------------- 发行版状态
export type DistroState = "missing" | "stopped" | "running" | "installing";
/** 解析 `wsl --list --verbose`：  NAME  STATE  VERSION（默认发行版前有 *） */
export function parseWslList(stdout: string, name = WSL_DISTRO): { state: DistroState; version?: number } {
	for (const raw of stdout.split(/\r?\n/)) {
		const cols = raw.replace(/^\s*\*?\s*/, "").trim().split(/\s+/);
		if (cols[0] !== name) continue;
		const st = (cols[1] ?? "").toLowerCase();
		const version = Number(cols[2]) || undefined;
		return { state: st === "running" ? "running" : st === "installing" || st === "converting" ? "installing" : "stopped", version };
	}
	return { state: "missing" };
}
export async function distroState(): Promise<DistroState> {
	if (!existsSync(wslExe())) return "missing";
	try {
		const { stdout } = await wsl(["--list", "--verbose"], 20_000);
		return parseWslList(stdout).state;
	} catch (e) {
		// 一个发行版都没有时 wsl -l 返回非 0（“没有已安装的分发”）
		const s = `${(e as { stdout?: string }).stdout ?? ""}${(e as Error).message}`;
		const p = parseWslList(s);
		return p.state;
	}
}

// ---------------------------------------------------------------- 阶段（给界面显示）
export type VmPhase = "idle" | "downloading" | "creating" | "booting" | "running" | "stopping" | "error";
let phase: { phase: VmPhase; detail?: string } = { phase: "idle" };
export const wslPhase = () => phase;
const setPhase = (p: VmPhase, detail?: string) => (phase = { phase: p, detail });

// ---------------------------------------------------------------- 下载（统一下载管理器 desktop-wsl）
registerDownload({
	id: "desktop-wsl",
	name: "助理电脑运行时（WSL2 发行版 + containerd）",
	group: "助理电脑",
	size: (() => {
		try {
			return rootfsFile(process.arch === "arm64" ? "arm64" : "x64", "").size;
		} catch {
			return 0.1e9;
		}
	})(),
	installed: () => rootfsReady() || !!importedInfo(),
	start: () => ensureRootfs(),
	hidden: () => !(process.platform === "win32" || process.env.PIA_TEST_WSL === "1") || desktopSettings().backend === "docker",
});
let filesInflight: Promise<void> | null = null;
let abort: AbortController | null = null;
export function ensureRootfs(): Promise<void> {
	if (rootfsReady() || importedInfo()) return Promise.resolve();
	filesInflight ??= trackDownload("desktop-wsl", (p) => downloadRootfs(p)).finally(() => ((filesInflight = null), (abort = null)));
	return filesInflight;
}
export function cancelWslDownload() {
	abort?.abort();
}
async function downloadRootfs(p: Progress) {
	const f = rootfsFile();
	const short = diskShortfall(freeBytes(wslHome()), f.size ?? 0, !!importedInfo());
	if (short) throw new Error(short);
	abort = new AbortController();
	setPhase("downloading", `正在下载 ${f.label}`);
	p.detail(`正在下载 ${f.label}`);
	await downloadFile(f, { bytes: (r, t) => p.bytes(r, t), detail: (t) => p.detail(`${f.label}：${t}`) }, { signal: abort.signal, fetchImpl: registryFetch() }).catch((e) => {
		setPhase("error", e instanceof Error ? e.message : String(e));
		throw new Error(`${f.label} 下载失败：${e instanceof Error ? e.message : e}`);
	});
	setPhase("idle");
}

// ---------------------------------------------------------------- 引擎守护进程（让发行版保持运行）
let keeper: ChildProcess | null = null;
let keeperLog = "";
function startKeeper() {
	if (keeper && keeper.exitCode === null && !keeper.killed) return;
	const args = ["-d", WSL_DISTRO, "-u", "root", "--cd", "/", "--exec", "/usr/local/bin/pia-engine"];
	assertWslArgs(args);
	keeperLog = "";
	const k = spawn(wslExe(), args, { env: wslEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	const onData = (b: Buffer) => void (keeperLog = (keeperLog + decodeWsl(b)).slice(-2000));
	k.stdout?.on("data", onData);
	k.stderr?.on("data", onData);
	k.on("exit", () => keeper === k && (keeper = null));
	k.on("error", (e) => void (keeperLog += String(e)));
	keeper = k;
}
async function engineHealthy(timeout = 20_000) {
	const cli = nerdctlCli();
	return new Promise<boolean>((res) =>
		execFile(cli[0], [...cli.slice(1), "version", "--format", "{{json .Server}}"], { env: wslEnv(), timeout, windowsHide: true }, (err, stdout) => res(!err && /containerd/i.test(String(stdout)))),
	);
}

// ---------------------------------------------------------------- 开机 / 关机 / 删除
let bootInflight: Promise<void> | null = null;
/** 确保发行版在跑、里面的 containerd 可用（并发调用合并） */
export function ensureWsl(): Promise<void> {
	bootInflight ??= bootWsl()
		.then(() => void setPhase("running"))
		.catch((e) => {
			setPhase("error", e instanceof Error ? e.message : String(e));
			throw e;
		})
		.finally(() => (bootInflight = null));
	return bootInflight;
}
async function bootWsl() {
	const h = await probeWsl(true);
	if (h.health !== "ok") throw new Error(h.reason ?? "WSL 不可用");
	await ensureRootfs();
	let st = await distroState();
	if (st === "installing") {
		for (let i = 0; i < 60 && st === "installing"; i++) {
			await new Promise((r) => setTimeout(r, 2000));
			st = await distroState();
		}
	}
	if (st === "missing") {
		// 上次导入到一半（或用户手动 unregister 了）：目录里可能有残留的 vhdx，清掉再导入
		const short = diskShortfall(freeBytes(wslHome()), 0, false);
		if (short) throw new Error(short);
		setPhase("creating", "正在安装助理电脑运行时（约 1 分钟）");
		rmSync(distroDir(), { recursive: true, force: true });
		mkdirSync(distroDir(), { recursive: true });
		const f = rootfsFile();
		await wsl(["--import", WSL_DISTRO, distroDir(), f.dest, "--version", "2"], 10 * 60_000).catch((e) => {
			throw new Error(`安装助理电脑运行时失败：${wslErr(e)}`);
		});
		writeFileSync(importedMarker(), JSON.stringify({ version: f.version, digest: f.digest, at: Date.now() } satisfies Imported));
	} else {
		const short = diskShortfall(freeBytes(wslHome()), 0, true);
		if (short) throw new Error(short);
	}
	if (await engineHealthy(10_000)) {
		startKeeper(); // containerd 在（App 重启前留下的）：仍然要拉起守护进程保持发行版运行
		return;
	}
	setPhase("booting", st === "missing" ? "第一次开机，正在启动容器引擎" : "正在启动助理电脑运行时");
	startKeeper();
	for (let i = 0; i < 45; i++) {
		if (await engineHealthy(10_000)) return;
		if (!keeper && i > 2) {
			// 守护进程退出了（containerd 起不来）：再试一次，仍失败就报错
			if (i > 10) break;
			startKeeper();
		}
		await new Promise((r) => setTimeout(r, 2000));
	}
	throw new Error(`助理电脑运行时已启动，但容器引擎没有就绪${keeperLog ? `（${wslErr({ message: keeperLog })}）` : ""}`);
}
export function wslErr(e: unknown) {
	const s = String((e as { stderr?: string }).stderr || (e as Error)?.message || e);
	const c = classifyWsl(s, 1);
	if (c.health !== "unknown") return c.reason!;
	if (/no space left|ENOSPC|0x80070070/i.test(s)) return "磁盘空间不足";
	if (/timed? ?out|ETIMEDOUT/i.test(s)) return "等待超时，请稍后重试";
	if (/already exists|已存在/i.test(s)) return "同名发行版已存在（可以在 设置 › 助理电脑 关闭后选“删除虚拟机和镜像”再重新开启）";
	return s.trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300) || "未知错误";
}
export async function stopWsl() {
	if ((await distroState()) !== "running") {
		keeper?.kill();
		return;
	}
	setPhase("stopping");
	await wsl(["--terminate", WSL_DISTRO], 60_000).catch(() => {});
	keeper?.kill();
	keeper = null;
	setPhase("idle");
}
/** App 退出时：不等，交给独立进程关掉发行版 */
export function stopWslDetached() {
	if (!existsSync(wslExe())) return;
	try {
		assertWslArgs(["--terminate", WSL_DISTRO]);
		spawn(wslExe(), ["--terminate", WSL_DISTRO], { env: wslEnv(), detached: true, stdio: "ignore", windowsHide: true }).unref();
	} catch {}
}
/** 删除发行版（连同里面的镜像 / 家目录）+ 我们下载的文件；目录只在确认是我们自己的时删除 */
export async function destroyWsl() {
	cancelWslDownload();
	keeper?.kill();
	keeper = null;
	if ((await distroState()) !== "missing") await wsl(["--unregister", WSL_DISTRO], 120_000).catch(() => {});
	const home = wslHome();
	if (isOwnWslHome(home)) rmSync(home, { recursive: true, force: true });
	setPhase("idle");
}
export async function wslRunning() {
	return (await distroState()) === "running" && (await engineHealthy(10_000));
}

// ---------------------------------------------------------------- 镜像已下载标记（发行版关机时也知道“已安装”）
const markerPath = () => join(wslHome(), "image.ok");
export const imageMarked = (ref: string) => existsSync(markerPath()) && readFileSync(markerPath(), "utf8").trim() === ref;
export function markImage(ref: string | null) {
	if (ref === null) return rmSync(markerPath(), { force: true });
	mkdirSync(wslHome(), { recursive: true });
	writeFileSync(markerPath(), ref);
}

// ---------------------------------------------------------------- 检测
export async function detectWsl(): Promise<{ ok: boolean; reason?: string; fix?: "install-wsl" | "reboot" }> {
	if (process.env.PIA_TEST_WSL !== "1") {
		const r = checkWindows({ platform: process.platform, release: release(), arch: process.arch });
		if (!r.ok) return r;
	}
	const h = await probeWsl();
	if (h.health === "ok") return { ok: true };
	return { ok: false, reason: h.reason, fix: h.health === "missing" || h.health === "update" ? "install-wsl" : h.health === "reboot" ? (rebootPending() ? "reboot" : "install-wsl") : undefined };
}
export const _resetWslProbe = () => void (wslProbe = null);
export const isUnder = (child: string, parent: string) => resolve(child).startsWith(resolve(parent) + sep);
