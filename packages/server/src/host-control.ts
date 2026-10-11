/**
 * 操作这台电脑（host control）：让助理通过 Cua Driver（MIT）操作用户自己的电脑。
 *
 * 安全设计（DESIGN §14.6）：
 *  - 默认关闭；在 设置 › 操作这台电脑 里看完醒目提示、勾选允许的应用后才开启（只有本机能开启）。
 *  - Cua 以 `bounded` 权限模式运行，能力清单（capability manifest，v3）由我们按用户勾选生成：
 *    只允许列出的工具、只能碰清单里的应用（macOS 按 bundle_id，Windows/Linux 按可执行文件绝对路径），
 *    文件只能读写这个助理的工作区，整屏画面观察关闭（desktop.display: false）。清单之外 Cua 自己拒绝。
 *  - 我们这一层再逐个动作审批（可选“本任务内都允许”），一键暂停（电脑和手机都能点）会立即拒绝所有动作并
 *    让 Cua 撤销全部会话（`revoke --all`），恢复时重启 Cua。
 *  - Cua 二进制按 third-party.json 固定版本下载到 数据目录/bin，校验固定的 SHA256。
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { bus } from "./bus.ts";
import { config } from "./config.ts";
import { getSetting, setSetting } from "./db.ts";
import { readZip } from "./memory/hindsight/zip.ts";

const run = promisify(execFile);

export interface HostApp {
	/** 显示名 */
	name: string;
	/** macOS：bundle id（如 com.apple.TextEdit）；Windows / Linux：可执行文件绝对路径 */
	id: string;
}
export interface HostControlSettings {
	enabled: boolean;
	/** 哪些助理可以操作这台电脑 */
	agents: "all" | string[];
	apps: HostApp[];
	/** 允许读写这个助理的工作区（上传/下载、保存文件） */
	workspaceFiles: boolean;
	/** 开启时用户确认过的清单哈希（开启 = 用户已审阅这份清单） */
	approvedHash?: string;
	enabledAt?: number;
}
const DEFAULTS: HostControlSettings = { enabled: false, agents: "all", apps: [], workspaceFiles: true };
export const hostSettings = (): HostControlSettings => ({ ...DEFAULTS, ...(getSetting("hostControl", DEFAULTS) as Partial<HostControlSettings>) });

export const isMac = () => process.platform === "darwin";
export const appKey = () => (isMac() ? "bundle_id" : "executable");

/** 允许的工具：输入、读取窗口内容、启动/结束允许的应用。不含整屏观察、剪贴板、录屏、浏览器附着、改配置、扩展安装等 */
export const ALLOWED_TOOLS = [
	"start_session", "end_session", "list_apps", "list_windows", "launch_app", "bring_to_front", "get_window_state", "get_accessibility_tree", "zoom",
	"click", "double_click", "right_click", "type_text", "set_value", "press_key", "hotkey", "scroll", "invoke_menu", "kill_app", "get_screen_size", "get_cursor_position",
];

const yq = (s: string) => JSON.stringify(s); // JSON 字符串也是合法的 YAML 标量

/** 生成 Cua 能力清单（YAML，v3）。workspaces：可读写的工作区目录 */
export function buildManifest(s: Pick<HostControlSettings, "apps" | "workspaceFiles">, workspaces: string[], platform = process.platform): string {
	const key = platform === "darwin" ? "bundle_id" : "executable";
	const lines = [
		"# Pi Assistant 生成的 Cua 能力清单（bounded 模式）。在 设置 › 操作这台电脑 里修改，不要手改。",
		"version: 3",
		"expires_after: 8h",
		"idle_timeout: 30m",
		"allow:",
		"  tools:",
		...ALLOWED_TOOLS.map((t) => `    - ${t}`),
		"resources:",
		"  apps:" + (s.apps.length ? "" : " []"),
		...s.apps.flatMap((a) => [`    - ${key}: ${yq(a.id)}`, "      launch: true", "      windows: all", "      terminate: driver_launched"]),
	];
	if (s.workspaceFiles && workspaces.length) {
		lines.push("  files:", "    read:", ...workspaces.flatMap((w) => [`      - dir: ${yq(w)}`, "        recursive: true"]), "    write:", ...workspaces.flatMap((w) => [`      - dir: ${yq(w)}`, "        recursive: true"]));
	}
	lines.push("  desktop:", "    display: false");
	return `${lines.join("\n")}\n`;
}
export const manifestHash = (yaml: string) => createHash("sha256").update(yaml).digest("hex").slice(0, 16);

// ---------------------------------------------------------------- Cua 二进制
type Asset = { file: string; sha256: string };
function cuaManifest(): { version: string; repo: string; tagPrefix: string; assets: Record<string, Asset> } {
	const j = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "third-party.json"), "utf8")) as { components: { name: string }[] };
	return j.components.find((x) => x.name === "cua-driver") as never;
}
export function cuaAssetKey(platform = process.platform, arch = process.arch) {
	if (platform === "darwin") return "darwin";
	if (platform === "win32") return arch === "arm64" ? "win-arm64" : "win-x64";
	return arch === "arm64" ? "linux-arm64" : "linux-x64";
}
const cuaDir = () => join(config.dataDir, "bin", `cua-driver-${cuaManifest().version}`);
/** 可执行文件（macOS 用 .app 里的那个，权限归属于 CuaDriver.app） */
export function cuaPaths() {
	const dir = cuaDir();
	if (isMac()) {
		const sub = existsSync(dir) ? readdirSync(dir).find((d) => d.startsWith("cua-driver-rs-")) : undefined;
		const app = sub ? join(dir, sub, "CuaDriver.app") : join(dir, "CuaDriver.app");
		return { dir, app, exe: join(app, "Contents", "MacOS", "cua-driver") };
	}
	return { dir, app: null, exe: join(dir, process.platform === "win32" ? "cua-driver.exe" : "cua-driver") };
}
export const cuaInstalled = () => existsSync(cuaPaths().exe);

let installing: Promise<string> | null = null;
export function ensureCua(onProgress?: (m: string) => void): Promise<string> {
	if (cuaInstalled()) return Promise.resolve(cuaPaths().exe);
	installing ??= (async () => {
		const m = cuaManifest();
		const a = m.assets[cuaAssetKey()];
		if (!a) throw new Error(`Cua Driver 不支持这个平台：${cuaAssetKey()}`);
		const file = a.file.replaceAll("{v}", m.version);
		onProgress?.(`正在下载 Cua Driver ${m.version}…`);
		const res = await fetch(`https://github.com/${m.repo}/releases/download/${m.tagPrefix}${m.version}/${file}`, { signal: AbortSignal.timeout(300_000), redirect: "follow" });
		if (!res.ok) throw new Error(`下载 Cua Driver 失败：HTTP ${res.status}`);
		const buf = Buffer.from(await res.arrayBuffer());
		if (createHash("sha256").update(buf).digest("hex") !== a.sha256) throw new Error("Cua Driver 校验失败（SHA256 与 third-party.json 不一致），已丢弃");
		const dir = cuaDir();
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		if (file.endsWith(".zip")) {
			for (const e of readZip(buf)) if (!e.name.endsWith("/")) writeFileSync(join(dir, e.name.split("/").pop()!), e.data());
		} else {
			const tgz = join(dir, file);
			writeFileSync(tgz, buf);
			await run("tar", ["xzf", tgz, "-C", dir]);
			rmSync(tgz, { force: true });
		}
		const { exe } = cuaPaths();
		if (!existsSync(exe)) throw new Error("Cua Driver 解压后找不到可执行文件");
		if (process.platform !== "win32") chmodSync(exe, 0o755);
		onProgress?.(`Cua Driver ${m.version} 已就绪`);
		return exe;
	})().finally(() => (installing = null));
	return installing;
}

// ---------------------------------------------------------------- 守护进程（bounded）
const hcDir = () => join(config.dataDir, "host-control");
export const socketPath = () => (process.platform === "win32" ? `\\\\.\\pipe\\pia-cua-${createHash("sha1").update(config.dataDir).digest("hex").slice(0, 8)}` : join(hcDir(), "cua.sock"));
const manifestPath = () => join(hcDir(), "manifest.yaml");

export type DaemonState = "off" | "starting" | "running" | "paused" | "error";
let daemon: ChildProcess | null = null;
let state: { state: DaemonState; detail: string } = { state: "off", detail: "未开启" };
let paused = false;
const setState = (s: DaemonState, detail: string) => {
	state = { state: s, detail };
	bus.emit({ type: "host.changed", status: hostStatus() } as never);
};

export function hostStatus() {
	const s = hostSettings();
	return { enabled: s.enabled, paused, daemon: state, platform: process.platform, installed: cuaInstalled(), version: cuaManifest().version };
}
export const hostPaused = () => paused;

export function hostAllowedFor(agentId: string) {
	const s = hostSettings();
	return s.enabled && !!s.approvedHash && (s.agents === "all" || s.agents.includes(agentId));
}

/** 当前设置对应的清单（所有允许的助理的工作区都可读写） */
export function currentManifest(workspaceOf: (agentId: string) => string, agentIds: string[]) {
	const s = hostSettings();
	const ids = s.agents === "all" ? agentIds : s.agents;
	return buildManifest(s, ids.map(workspaceOf));
}

const serveArgs = () => ["serve", "--socket", socketPath(), "--permission-mode", "bounded", "--capability-manifest", manifestPath(), "--approve-capability-manifest", "--no-permissions-gate"];

/** 启动（或重启）bounded 守护进程。yaml = 用户审阅并批准过的清单 */
export async function startDaemon(yaml: string) {
	const s = hostSettings();
	if (!s.enabled || s.approvedHash !== manifestHash(yaml)) throw new Error("清单已变化，需要在设置里重新确认后才能开启");
	setState("starting", "正在启动 Cua Driver…");
	await stopDaemon(true);
	try {
		const exe = await ensureCua((m) => setState("starting", m));
		mkdirSync(hcDir(), { recursive: true });
		writeFileSync(manifestPath(), yaml, { mode: 0o600 });
		if (process.platform !== "win32") rmSync(socketPath(), { force: true });
		const env = { ...process.env, CUA_DRIVER_TELEMETRY: "0" };
		if (isMac()) {
			// macOS：经 LaunchServices 启动 CuaDriver.app，辅助功能/屏幕录制授权归属于它（而不是终端或我们的服务）
			await run("open", ["-n", "-g", "-a", cuaPaths().app!, "--args", ...serveArgs()], { env });
		} else {
			daemon = spawn(exe, serveArgs(), { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
			let err = "";
			daemon.stderr?.on("data", (d) => (err = (err + d).slice(-2000)));
			daemon.on("exit", (code) => {
				daemon = null;
				if (state.state === "running" || state.state === "starting") setState("error", `Cua Driver 退出了（${code}）：${err.split("\n").filter(Boolean).at(-1) ?? ""}`);
			});
		}
		for (let i = 0; i < 40; i++) {
			if (await ping(exe)) {
				setState(paused ? "paused" : "running", paused ? "已暂停" : "运行中（bounded）");
				return;
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		throw new Error("Cua Driver 没有在 10 秒内就绪");
	} catch (e) {
		setState("error", e instanceof Error ? e.message : String(e));
		throw e;
	}
}
async function ping(exe: string) {
	try {
		await run(exe, ["status", "--socket", socketPath()], { timeout: 3000 });
		return true;
	} catch {
		return false;
	}
}
export async function stopDaemon(quiet = false) {
	if (cuaInstalled()) await run(cuaPaths().exe, ["stop", "--socket", socketPath()], { timeout: 5000 }).catch(() => {});
	daemon?.kill();
	daemon = null;
	if (!quiet) setState("off", "未开启");
}

/** 一键暂停：立即拒绝所有动作，并让 Cua 撤销全部会话；恢复时重启守护进程 */
export async function setHostPaused(v: boolean, yaml: () => string) {
	paused = v;
	if (v) {
		if (cuaInstalled()) await run(cuaPaths().exe, ["revoke", "--all", "--socket", socketPath()], { timeout: 5000 }).catch(() => {});
		setState(state.state === "off" ? "off" : "paused", "已暂停");
	} else if (hostSettings().enabled) await startDaemon(yaml()).catch(() => {});
	else setState("off", "未开启");
}

/** MCP 命令：连到 bounded 守护进程 */
export function hostMcpCommand() {
	return { command: cuaPaths().exe, args: ["mcp", "--socket", socketPath()] };
}

export function saveHostSettings(patch: Partial<HostControlSettings>) {
	const next = { ...hostSettings(), ...patch };
	setSetting("hostControl", next);
	return next;
}

// ---------------------------------------------------------------- macOS 权限
export async function macPermissions(): Promise<{ accessibility: string; screenRecording: string } | null> {
	if (!isMac() || !cuaInstalled()) return null;
	try {
		const { stdout } = await run(cuaPaths().exe, ["permissions", "status", "--json", "--socket", socketPath()], { timeout: 8000 });
		const j = JSON.parse(String(stdout)) as Record<string, unknown>;
		const pick = (k: RegExp) => String(Object.entries(j).find(([x]) => k.test(x))?.[1] ?? "unknown");
		return { accessibility: pick(/accessib/i), screenRecording: pick(/screen/i) };
	} catch {
		return { accessibility: "unknown", screenRecording: "unknown" };
	}
}
export async function macGrantPermissions() {
	if (!isMac()) return;
	await ensureCua();
	await run("open", ["-n", "-a", cuaPaths().app!, "--args", "permissions", "grant"]);
}

// ---------------------------------------------------------------- 可选应用列表（帮用户勾选）
export async function suggestApps(): Promise<HostApp[]> {
	const out: HostApp[] = [];
	try {
		if (isMac()) {
			for (const root of ["/Applications", "/System/Applications", join(process.env.HOME ?? "", "Applications")]) {
				if (!existsSync(root)) continue;
				for (const d of readdirSync(root).filter((x) => x.endsWith(".app")).slice(0, 300)) {
					const plist = join(root, d, "Contents", "Info.plist");
					const id = await run("plutil", ["-extract", "CFBundleIdentifier", "raw", plist], { timeout: 2000 }).then((r) => String(r.stdout).trim(), () => "");
					if (id) out.push({ name: d.replace(/\.app$/, ""), id });
				}
			}
		} else if (process.platform === "win32") {
			const pf = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean) as string[];
			const known: [string, string][] = [
				["记事本", "C:\\Windows\\System32\\notepad.exe"], ["画图", "C:\\Windows\\System32\\mspaint.exe"], ["计算器", "C:\\Windows\\System32\\calc.exe"],
				...pf.flatMap((d): [string, string][] => [
					["微信", join(d, "Tencent", "WeChat", "WeChat.exe")], ["微信", join(d, "Tencent", "Weixin", "Weixin.exe")], ["企业微信", join(d, "WXWork", "WXWork.exe")],
					["钉钉", join(d, "DingDing", "DingtalkLauncher.exe")], ["飞书", join(d, "Feishu", "Feishu.exe")], ["WPS", join(d, "Kingsoft", "WPS Office", "ksolaunch.exe")],
					["Excel", join(d, "Microsoft Office", "root", "Office16", "EXCEL.EXE")], ["Word", join(d, "Microsoft Office", "root", "Office16", "WINWORD.EXE")],
				]),
			];
			for (const [name, id] of known) if (existsSync(id) && !out.some((x) => x.id === id)) out.push({ name, id });
		} else {
			for (const dir of ["/usr/share/applications", join(process.env.HOME ?? "", ".local/share/applications")]) {
				if (!existsSync(dir)) continue;
				for (const f of readdirSync(dir).filter((x) => x.endsWith(".desktop")).slice(0, 300)) {
					const t = readFileSync(join(dir, f), "utf8");
					if (/^NoDisplay=true/m.test(t)) continue;
					const name = /^Name\[zh_CN\]=(.+)$/m.exec(t)?.[1] ?? /^Name=(.+)$/m.exec(t)?.[1];
					const cmd = /^Exec=(\S+)/m.exec(t)?.[1];
					if (!name || !cmd) continue;
					const abs = cmd.startsWith("/") ? cmd : (process.env.PATH ?? "").split(":").map((p) => join(p, cmd)).find((p) => existsSync(p));
					if (abs && !out.some((x) => x.id === abs)) out.push({ name, id: abs });
				}
			}
		}
	} catch {}
	return out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

/** 审批卡片上的人话说明 */
export function describeHostAction(tool: string, input: Record<string, unknown>) {
	const s = hostSettings();
	const app = (() => {
		const v = String(input.bundle_id ?? input.name ?? input.launch_path ?? "");
		return s.apps.find((a) => a.id === v || a.name === v)?.name ?? v;
	})();
	const label: Record<string, string> = {
		launch_app: `打开应用「${app}」`, kill_app: `关闭应用「${app}」`, click: "点击", double_click: "双击", right_click: "右键点击", type_text: `输入文字「${String(input.text ?? "").slice(0, 60)}」`,
		set_value: `填写「${String(input.value ?? "").slice(0, 60)}」`, press_key: `按键 ${String(input.key ?? "")}`, hotkey: `快捷键 ${JSON.stringify(input.keys ?? input.key ?? "")}`, scroll: "滚动", invoke_menu: `点菜单 ${JSON.stringify(input.path ?? input.menu ?? "")}`, bring_to_front: "切换到窗口",
	};
	return `在你的电脑上${label[tool] ?? `执行 ${tool}`}`;
}
