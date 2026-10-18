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
 *  - 完全权限模式（可选）：用户在设置里看完强警告并手动输入确认语后，Cua 以 `unrestricted` 模式运行
 *    （`--permission-mode unrestricted --dangerously-bypass-approvals`），所有应用、不用清单；审批策略可选
 *    “只审批发送/付款/删除类动作”（默认）或“完全不审批”。一键暂停与操作记录在任何模式下都有效。
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
import { fetchWithProgress, registerDownload, trackDownload } from "./downloads.ts";
import { nativeLaunchCommand, nativeLaunchEnvForChild, nativeLaunchEnvProblems, osAccountHome, type NativeLaunchCommand } from "./native-launch-env.ts";

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
	/** 每个助理的权限档位（没设置的用 defaultTier） */
	tiers: Record<string, HostTier>;
	defaultTier: HostTier;
	/** 设为“完全权限”时用户输入确认语的时间（按助理） */
	fullAck: Record<string, number>;
	/** 开启时用户确认过的清单哈希（开启 = 用户已审阅这份清单） */
	approvedHash?: string;
	enabledAt?: number;
}
/**
 * 权限档位（按助理设置）：
 *  - observe 只看：截图、读取窗口内容，不能输入（Cua unrestricted 守护进程 + 我们这层拦下所有输入工具）
 *  - bounded 限定（默认）：只能操作勾选的应用（Cua bounded 清单强制），每个动作都问
 *  - trusted 信任：所有应用；日常动作不问，发送 / 付款 / 删除 / 提交类动作仍要问
 *  - full 完全权限：应用层不弹审批（包括关机、强制退出、系统设置这类受保护操作）；需要输入确认语才能设置
 * 任何档位：一键暂停有效；操作全部记录。“完全权限”之外的档位：硬性保护清单命中的动作一律要明确批准。
 */
export type HostTier = "observe" | "bounded" | "trusted" | "full";
export const TIERS: HostTier[] = ["observe", "bounded", "trusted", "full"];
export const TIER_LABEL: Record<HostTier, string> = { observe: "只看", bounded: "限定", trusted: "信任", full: "完全权限" };
const DEFAULTS: HostControlSettings = { enabled: false, agents: "all", apps: [], workspaceFiles: true, tiers: {}, defaultTier: "bounded", fullAck: {} };
/** 把某个助理设为“完全权限”时必须一字不差输入的确认语 */
export const FULL_CONFIRM = "我了解风险，允许完全控制这台电脑";
export const tierOf = (agentId: string, s = hostSettings()): HostTier => s.tiers[agentId] ?? s.defaultTier;
/** 本机操作的审批策略（按助理） */
export const hostApprovals = (agentId: string): "observe" | "all" | "sensitive" | "none" => ({ observe: "observe", bounded: "all", trusted: "sensitive", full: "none" } as const)[tierOf(agentId)];
/** 档位用哪个 Cua 守护进程：bounded 用清单限定的那个，其余用 unrestricted 的那个（由我们这层把关） */
export const daemonKindOf = (tier: HostTier): DaemonKind => (tier === "bounded" ? "bounded" : "open");
export type DaemonKind = "bounded" | "open";

/** 服务端注入：工作区路径、所有助理 */
let env: { workspaceOf: (id: string) => string; agentIds: () => string[] } = { workspaceOf: (id) => id, agentIds: () => [] };
export const setHostEnv = (e: typeof env) => (env = e);
const allowedAgents = (s = hostSettings()) => (s.agents === "all" ? env.agentIds() : s.agents.filter((a) => env.agentIds().includes(a)));
/** 当前设置需要哪些守护进程 */
export const neededDaemons = (s = hostSettings()): DaemonKind[] => [...new Set(allowedAgents(s).map((a) => daemonKindOf(tierOf(a, s))))].sort();

/** 助理自己的电脑（Docker 桌面）的审批策略：默认 none（它自己的电脑，完全权限） */
export interface SandboxComputerSettings {
	approvals: "all" | "sensitive" | "none";
}
export const sandboxComputerSettings = (): SandboxComputerSettings => ({ approvals: "none", ...(getSetting("sandboxComputer", {}) as Partial<SandboxComputerSettings>) });
export const saveSandboxComputerSettings = (p: Partial<SandboxComputerSettings>) => {
	const next = { ...sandboxComputerSettings(), ...p };
	if (!["all", "sensitive", "none"].includes(next.approvals)) throw new Error("approvals 取值不对");
	setSetting("sandboxComputer", next);
	return next;
};
export const hostSettings = (): HostControlSettings => ({ ...DEFAULTS, ...(getSetting("hostControl", DEFAULTS) as Partial<HostControlSettings>) });

export const isMac = () => process.platform === "darwin";
export const appKey = () => (isMac() ? "bundle_id" : "executable");

/**
 * 允许的工具：输入、读取窗口内容、启动/结束允许的应用。不含整屏观察、剪贴板、录屏、浏览器附着（CDP 浏览器工具）、改配置、扩展安装等。
 * CDP 浏览器工具不放进 bounded：cua bounded 模式的网页导航必须在清单里列出确切的 origin，开放式网页任务做不了；
 * 要让助理用用户的 Chrome 做网页任务需要“信任”或以上档位（走 unrestricted 守护进程 + 我们这层审批，DESIGN §14.8）。
 */
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
registerDownload({ id: "cua-driver", name: "Cua Driver（操作这台电脑）", group: "操作这台电脑", size: 30e6, installed: () => cuaInstalled(), start: () => ensureCua() });
export function ensureCua(onProgress?: (m: string) => void): Promise<string> {
	if (cuaInstalled()) return Promise.resolve(cuaPaths().exe);
	installing ??= trackDownload("cua-driver", async (prog) => {
		const m = cuaManifest();
		const a = m.assets[cuaAssetKey()];
		if (!a) throw new Error(`Cua Driver 不支持这个平台：${cuaAssetKey()}`);
		const file = a.file.replaceAll("{v}", m.version);
		onProgress?.(`正在下载 Cua Driver ${m.version}…`);
		const buf = await fetchWithProgress(`https://github.com/${m.repo}/releases/download/${m.tagPrefix}${m.version}/${file}`, prog, { timeoutMs: 10 * 60_000 }).catch((e) => Promise.reject(new Error(`下载 Cua Driver 失败：${e instanceof Error ? e.message : e}`)));
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
	}).finally(() => (installing = null));
	return installing;
}

// ---------------------------------------------------------------- 守护进程（bounded）
const hcDir = () => join(config.dataDir, "host-control");

/**
 * 原生驱动 / 浏览器用的环境：服务自己的合成 HOME（隔离启动时）**不传给原生进程**。
 * 规则与理由见 `native-launch-env.ts`；这里只管“生产上取 OS 账户家目录 + 数据目录算合成根 + 只记一次日志”。
 */
let nativeEnvNotice: string | null = null;
function driverEnv(why?: string): NodeJS.ProcessEnv {
	const r = nativeLaunchEnvForChild({ CUA_DRIVER_TELEMETRY: "0" }, { syntheticRoots: [config.dataDir] });
	if (nativeEnvNotice === null) {
		const problems = nativeLaunchEnvProblems(r.env, { realHome: r.realHome, syntheticRoots: [config.dataDir] });
		// 只记录、不拒绝启动：隔离问题不该变成“电脑操作打不开”。
		// 取不到 OS 账户家目录时必须说实话：HOME 没被改写，原生进程仍会看到服务自己的 HOME。
		const unknown = r.homeSource === "unknown" ? "取不到 OS 账户家目录（os.userInfo 失败）：HOME 未改写，原生驱动仍会拿到服务自己的 HOME，隔离环境下的家目录问题**未解决**" : "";
		nativeEnvNotice = [
			r.diverged ? "服务的 HOME 不是登录用户家目录，原生驱动改用 OS 账户家目录" : "",
			r.stripped.length ? `已剥离 ${r.stripped.join(" / ")}` : "",
			problems.length ? `自检问题：${problems.join("；")}` : "",
			unknown,
		]
			.filter(Boolean)
			.join("，");
		if (nativeEnvNotice) console.warn(`[host] ${nativeEnvNotice}${why ? `（${why}）` : ""}`);
	}
	return r.env;
}

/** 用户自己的家目录（列应用用）：取 OS 账户信息，不拿服务的合成 HOME 当用户目录。 */
const userHomeDir = () => osAccountHome() ?? process.env.HOME;

export const socketPath = (kind: DaemonKind = "bounded") =>
	process.platform === "win32" ? `\\\\.\\pipe\\pia-cua-${kind}-${createHash("sha1").update(config.dataDir).digest("hex").slice(0, 8)}` : join(hcDir(), `cua-${kind}.sock`);
const manifestPath = () => join(hcDir(), "manifest.yaml");

export type DaemonState = "off" | "starting" | "running" | "paused" | "error";
/**
 * 启动失败的原因分类：只有“还没起来 / 下载中断”这两类值得重试；
 * 权限计划已变化、校验失败、以及任何没认出来的错误都必须立即停，等用户或人来看（不能靠“消息里出现某个词”猜）。
 */
export type DaemonFailReason = "permissions_changed" | "not_ready" | "download" | "other";
export class HostDaemonError extends Error {
	constructor(
		message: string,
		readonly reason: Exclude<DaemonFailReason, "other">,
	) {
		super(message);
		this.name = "HostDaemonError";
	}
}
export function daemonFailReason(e: unknown): DaemonFailReason {
	if (e instanceof HostDaemonError) return e.reason;
	const msg = e instanceof Error ? e.message : String(e);
	// 兼容未带类型的历史抛出点：只认确切文案，不做“含权限 / 含失败”这类模糊匹配
	if (msg.startsWith("权限设置已变化")) return "permissions_changed";
	if (/没有在 10 秒内就绪$/.test(msg)) return "not_ready";
	if (msg.startsWith("下载 Cua Driver 失败")) return "download";
	return "other";
}
/** 是否值得（再一次性地）重试启动：每次失败都要重新判，不能沿用上一次的结论 */
export function retryableDaemonFailure(e: unknown) {
	const r = daemonFailReason(e);
	return r === "not_ready" || r === "download";
}
const daemons = new Map<DaemonKind, ChildProcess>();
let state: { state: DaemonState; detail: string } = { state: "off", detail: "未开启" };
let paused = false;
const setState = (s: DaemonState, detail: string) => {
	state = { state: s, detail };
	bus.emit({ type: "host.changed", status: hostStatus() });
};

export function hostStatus() {
	const s = hostSettings();
	// macPermissions 是最近一次只读探测的结果（没有探测过就是 null），绝不在这里触发系统授权弹窗
	return { enabled: s.enabled, tiers: Object.fromEntries(allowedAgents(s).map((a) => [a, tierOf(a, s)])), paused, daemon: state, platform: process.platform, installed: cuaInstalled(), version: cuaManifest().version, macPermissions: hostPermissionsCache() };
}
export const hostPaused = () => paused;
/** “正在操作你的电脑”：最近一次 host 动作还在进行，或结束不到 HOST_ACTIVE_MS。聊天顶部提示、托盘悬浮条共用这个判断 */
export const HOST_ACTIVE_MS = 8_000;
export function hostActive(last: { outcome: string; started_at: number; finished_at?: number | null } | null | undefined, now = Date.now()): boolean {
	if (!last) return false;
	if (last.outcome === "running") return now - last.started_at < 10 * 60_000; // 卡住的 running 记录不至于永远显示
	return now - (last.finished_at ?? last.started_at) < HOST_ACTIVE_MS;
}

export function hostAllowedFor(agentId: string) {
	const s = hostSettings();
	return s.enabled && !!s.approvedHash && (s.agents === "all" || s.agents.includes(agentId));
}

/**
 * “完全权限”对用户主机的统一文件 / 命令访问：档位为 full、已开启并允许该助理、且未暂停。
 * 这是唯一的“full 主机文件/命令”开关，ext-sandbox / ext-approval / runtime 都调用它。
 * 每次调用求值（不缓存），所以降权 / 暂停对已存在的会话立即生效；docker 偏好不影响它——
 * full 时命令在用户主机执行，不挂载全盘进容器（见 DESIGN §23）。
 */
export function hostFileAccess(agentId: string): boolean {
	return hostAllowedFor(agentId) && !hostPaused() && tierOf(agentId) === "full";
}

/** bounded 守护进程用的清单（只包含“限定”档位助理的工作区） */
export function boundedManifest(s = hostSettings()) {
	const ids = allowedAgents(s).filter((a) => tierOf(a, s) === "bounded");
	return buildManifest(s, ids.map(env.workspaceOf));
}
/**
 * 把请求里的字段并进当前设置（纯函数，不保存）：改默认档位时把现有助理固定成旧默认档位。
 * “预览权限计划”与实际“保存”都用它，保证两边的计划 hash 一致。
 */
export function draftHostSettings(
	b: { agents?: "all" | string[]; apps?: HostApp[]; workspaceFiles?: boolean; tiers?: Record<string, HostTier>; defaultTier?: HostTier },
	cur = hostSettings(),
): HostControlSettings {
	const apps = (b.apps ?? cur.apps)
		.filter((a) => a && typeof a.id === "string" && a.id.trim())
		.map((a) => ({ name: String(a.name || a.id).slice(0, 60), id: a.id.trim().slice(0, 300) }));
	const tiers = { ...cur.tiers, ...(b.tiers ?? {}) };
	if (b.defaultTier && b.defaultTier !== cur.defaultTier) for (const id of env.agentIds()) tiers[id] ??= cur.defaultTier;
	return { ...cur, agents: b.agents ?? cur.agents, apps, workspaceFiles: b.workspaceFiles ?? cur.workspaceFiles, tiers, defaultTier: b.defaultTier ?? cur.defaultTier };
}
/** 给用户审阅的完整权限计划：各助理档位 + bounded 清单。开启 = 用户确认了这份计划（哈希） */
export function hostPlan(s = hostSettings()) {
	const ids = allowedAgents(s);
	const lines = ["# 各助理的权限档位（非“完全权限”档位：硬性保护清单里的动作都要你明确批准；“完全权限”档位应用层不再弹审批，包括受保护动作；任何档位：一键暂停有效、操作全部记录）", `# 新助理默认：${TIER_LABEL[s.defaultTier]}`];
	for (const id of ids) lines.push(`# - ${id}: ${TIER_LABEL[tierOf(id, s)]}`);
	if (!ids.length) lines.push("# （没有允许的助理）");
	if (ids.some((a) => tierOf(a, s) !== "bounded")) lines.push("# 只看 / 信任 / 完全权限 的助理连接 Cua unrestricted 守护进程（所有应用），由 Pi Assistant 这一层把关：只看拦下所有输入，信任问发送/付款/删除类动作，完全权限不再弹审批。");
	if (ids.some((a) => tierOf(a, s) === "bounded")) lines.push("", boundedManifest(s));
	return `${lines.join("\n")}\n`;
}
/**
 * 助理增删后：新助理继承默认档位（写成显式设置，之后改默认不影响它），删掉的助理清理设置；
 * 已开启时按新计划自动更新确认哈希并重启守护进程（用户已经确认过“新助理默认档位”）。
 */
export async function hostAgentsChanged() {
	const s = hostSettings();
	const ids = env.agentIds();
	const tiers: Record<string, HostTier> = {};
	for (const id of ids) tiers[id] = s.tiers[id] ?? s.defaultTier;
	const fullAck = Object.fromEntries(Object.entries(s.fullAck).filter(([id]) => ids.includes(id)));
	for (const id of ids) if (tiers[id] === "full" && !fullAck[id]) fullAck[id] = Date.now();
	saveHostSettings({ tiers, fullAck });
	if (!s.enabled) return;
	saveHostSettings({ approvedHash: manifestHash(hostPlan()) });
	await startDaemon().catch(() => {});
}

/** 兼容旧调用：返回审阅用的计划 */
export function currentManifest(workspaceOf: (agentId: string) => string, agentIds: string[]) {
	setHostEnv({ workspaceOf, agentIds: () => agentIds });
	return hostPlan();
}

export const serveArgs = (kind: DaemonKind) =>
	kind === "open"
		? ["serve", "--socket", socketPath("open"), "--permission-mode", "unrestricted", "--dangerously-bypass-approvals", "--no-permissions-gate"]
		: ["serve", "--socket", socketPath("bounded"), "--permission-mode", "bounded", "--capability-manifest", manifestPath(), "--approve-capability-manifest", "--no-permissions-gate"];

/**
 * 启动（或重启）需要的 Cua 守护进程。plan = 用户审阅并批准过的权限计划（hostPlan）。
 * bounded 守护进程用清单限定；open 守护进程以 unrestricted 运行，给“只看/信任/完全权限”档位的助理用。
 */
export async function startDaemon(plan = hostPlan()) {
	const s = hostSettings();
	if (!s.enabled || s.approvedHash !== manifestHash(plan)) throw new HostDaemonError("权限设置已变化，需要在设置里重新确认后才能开启", "permissions_changed");
	setState("starting", "正在启动 Cua Driver…");
	await stopDaemon(true);
	// 端到端测试用：不下载、不启动 Cua，只走设置与审批流程
	if (process.env.PIA_HOST_CONTROL_DRY_RUN === "1") return setState(paused ? "paused" : "running", "运行中（演练模式，未启动 Cua）");
	try {
		const exe = await ensureCua((m) => setState("starting", m));
		mkdirSync(hcDir(), { recursive: true });
		const kinds = neededDaemons(s);
		if (kinds.includes("bounded")) writeFileSync(manifestPath(), boundedManifest(s), { mode: 0o600 });
		else rmSync(manifestPath(), { force: true });
		for (const kind of kinds) await spawnDaemon(kind, exe);
		const label = kinds.length ? kinds.map((k) => (k === "bounded" ? "限定" : "开放")).join(" + ") : "没有允许的助理";
		setState(paused ? "paused" : "running", paused ? "已暂停" : `运行中（${label}）`);
	} catch (e) {
		setState("error", e instanceof Error ? e.message : String(e));
		throw e;
	}
}
async function spawnDaemon(kind: DaemonKind, exe: string) {
	if (process.platform !== "win32") rmSync(socketPath(kind), { force: true });
	const penv = driverEnv("启动守护进程");
	if (isMac()) {
		// macOS：经 LaunchServices 启动 CuaDriver.app，辅助功能/屏幕录制授权归属于它（而不是终端或我们的服务）。
		// 环境怎么过去：本机 `man open` 明说 “Opened applications inherit environment variables just as if you had
		// launched the application directly through its full path”，并提供 `--env NAME=VALUE` 显式追加。
		// 所以先给 `open` 本身一份已剥离好的 env（这是继承的原样），再把必要的 HOME 用 `--env` 写死一次，
		// 不靠“继承一定发生”这一条假设（`--env` 只能加、不能删，所以删 `CFFIXED_USER_HOME` 只能靠前者）。
		const args = ["-n", "-g", "-a", cuaPaths().app!, ...(penv.HOME ? ["--env", `HOME=${penv.HOME}`] : []), "--args", ...serveArgs(kind)];
		await run("open", args, { env: penv });
	} else {
		const child = spawn(exe, serveArgs(kind), { env: penv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		daemons.set(kind, child);
		let err = "";
		child.stderr?.on("data", (d) => (err = (err + d).slice(-2000)));
		child.on("exit", (code) => {
			if (daemons.get(kind) === child) daemons.delete(kind);
			if (state.state === "running" || state.state === "starting") setState("error", `Cua Driver（${kind}）退出了（${code}）：${err.split("\n").filter(Boolean).at(-1) ?? ""}`);
		});
	}
	for (let i = 0; i < 40; i++) {
		if (await ping(exe, kind)) return;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new HostDaemonError(`Cua Driver（${kind}）没有在 10 秒内就绪`, "not_ready");
}
async function ping(exe: string, kind: DaemonKind) {
	try {
		await run(exe, ["status", "--socket", socketPath(kind)], { timeout: 3000, env: driverEnv() });
		return true;
	} catch {
		return false;
	}
}
export async function stopDaemon(quiet = false) {
	if (cuaInstalled()) for (const k of ["bounded", "open"] as DaemonKind[]) await run(cuaPaths().exe, ["stop", "--socket", socketPath(k)], { timeout: 5000, env: driverEnv() }).catch(() => {});
	for (const c of daemons.values()) c.kill();
	daemons.clear();
	if (!quiet) setState("off", "未开启");
}

/** 一键暂停：立即拒绝所有动作（我们这层），并让 Cua 撤销全部会话；恢复时重启守护进程 */
export async function setHostPaused(v: boolean) {
	paused = v;
	if (v) {
		if (cuaInstalled()) for (const k of ["bounded", "open"] as DaemonKind[]) await run(cuaPaths().exe, ["revoke", "--all", "--socket", socketPath(k)], { timeout: 5000, env: driverEnv() }).catch(() => {});
		setState(state.state === "off" ? "off" : "paused", "已暂停");
	} else if (hostSettings().enabled) await startDaemon().catch(() => {});
	else setState("off", "未开启");
}

/** MCP 命令：按助理档位连到对应的守护进程 */
export function hostMcpCommand(agentId: string): NativeLaunchCommand {
	// `cua-driver mcp` 也是原生进程，而且它是经 Pi 的 StdioTransport 起的：那条路会把 process.env 合并回来，
	// 只传一份缺键的 env 删不掉 `CFFIXED_USER_HOME` / 合成 `TMPDIR`，因此由自有启动器在内存中删键后启动驱动。
	// argv 只含待删键名、账户路径及下列固定开关，不包含整份环境；扩展侧开关在这里一起声明以保持一致。
	return nativeLaunchCommand(
		{ command: cuaPaths().exe, args: ["mcp", "--socket", socketPath(daemonKindOf(tierOf(agentId)))] },
		{ syntheticRoots: [config.dataDir], extra: { CUA_DRIVER_TELEMETRY: "0", CUA_DRIVER_DISABLE_RUN_SCRIPT: "1" } },
	);
}

export function saveHostSettings(patch: Partial<HostControlSettings>) {
	const next = { ...hostSettings(), ...patch };
	setSetting("hostControl", next);
	return next;
}

// ---------------------------------------------------------------- macOS 权限
/**
 * 系统权限（辅助功能 / 屏幕录制）的**只读**探测与缓存。
 * 设置页会轮询、系统提示也会引用，所以不能每次都起一个 `permissions status` 进程（最多 8 秒超时）；
 * 但也不能因此去“请求”授权：这里只读状态，绝不弹系统框，弹框只由用户在 设置 › 操作这台电脑 主动点。
 */
const PERM_CACHE_MS = 15_000;
type MacPermissions = { accessibility: string; screenRecording: string };
let permCacheAt = 0;
let permCacheValue: MacPermissions | null = null;
let permProbe: Promise<MacPermissions | null> | null = null;
const permCacheValid = (now = Date.now()) => permCacheAt > 0 && now - permCacheAt < PERM_CACHE_MS;
/**
 * 最近一次探测结果（过期或没探测过返回 null，调用方按“未知”处理，不额外起进程）。
 * 注意：null 也是“有效结果”（例如非 macOS / 未安装 Cua），所以缓存时刻单独记，不能拿 null 当“没探过”。
 */
export function hostPermissionsCache(now = Date.now()): MacPermissions | null {
	return permCacheValid(now) ? permCacheValue : null;
}
/** 上次只读探测的时间（0 = 从未探测）；供状态提示 / 测试判断“有没有重复起进程” */
export const lastMacPermissionProbeAt = () => permCacheAt;
/**
 * 系统授权状态只有三值：明确有、明确没有、未知。`unknown` / 空 / 认不出的值一律不得当“已授权”。
 */
export type MacPermissionState = "granted" | "denied" | "unknown";
export function macPermissionState(v: string | null | undefined): MacPermissionState {
	const s = String(v ?? "").trim().toLowerCase();
	if (["granted", "true", "yes", "authorized", "allowed", "ok"].includes(s)) return "granted";
	if (["denied", "false", "no", "not_granted", "not granted", "missing", "revoked"].includes(s)) return "denied";
	return "unknown";
}
export async function macPermissions(force = false): Promise<MacPermissions | null> {
	if (!force) {
		if (permCacheValid()) return permCacheValue;
		if (permProbe) return permProbe; // 设置页轮询 / 状态查询同时来，合并成一次只读探测
	}
	permProbe = probeMacPermissions().finally(() => (permProbe = null));
	return permProbe;
}
async function probeMacPermissions(): Promise<MacPermissions | null> {
	let value: MacPermissions | null;
	if (!isMac() || !cuaInstalled()) {
		value = null;
	} else {
		try {
			const { stdout } = await run(cuaPaths().exe, ["permissions", "status", "--json", "--socket", socketPath()], { timeout: 8000, env: driverEnv() });
			const j = JSON.parse(String(stdout)) as Record<string, unknown>;
			const pick = (k: RegExp) => String(Object.entries(j).find(([x]) => k.test(x))?.[1] ?? "unknown");
			value = { accessibility: pick(/accessib/i), screenRecording: pick(/screen/i) };
		} catch {
			// 探测失败只是“不知道”，不是“没授权”，也不是“已授权”
			value = { accessibility: "unknown", screenRecording: "unknown" };
		}
	}
	permCacheAt = Date.now();
	permCacheValue = value;
	return value;
}
export async function macGrantPermissions() {
	if (!isMac()) return;
	await ensureCua();
	await run("open", ["-n", "-a", cuaPaths().app!, "--args", "permissions", "grant"], { env: driverEnv() });
}

// ---------------------------------------------------------------- 可选应用列表（帮用户勾选）
export async function suggestApps(): Promise<HostApp[]> {
	const out: HostApp[] = [];
	try {
		if (isMac()) {
			for (const root of ["/Applications", "/System/Applications", join(userHomeDir() ?? "", "Applications")]) {
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
			for (const dir of ["/usr/share/applications", join(userHomeDir() ?? "", ".local/share/applications")]) {
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
		browser_prepare: "连接你的浏览器（Chrome/Edge）", get_browser_state: "读取网页", browser_navigate: `打开网址 ${String(input.url ?? "").slice(0, 120)}`, browser_click: `点击网页元素 ${String(input.ref ?? "")}`,
		browser_type: `在网页里输入「${String(input.text ?? "").slice(0, 60)}」`, browser_pointer: `网页${String(input.action ?? "操作")}`, browser_download: "从网页下载文件到工作区", browser_set_input_files: "把工作区里的文件上传到网页", browser_dialog: `处理网页弹窗（${String(input.action ?? "")}）`,
		launch_app: `打开应用「${app}」`, kill_app: `关闭应用「${app}」`, click: "点击", double_click: "双击", right_click: "右键点击", type_text: `输入文字「${String(input.text ?? "").slice(0, 60)}」`,
		set_value: `填写「${String(input.value ?? "").slice(0, 60)}」`, press_key: `按键 ${String(input.key ?? "")}`, hotkey: `快捷键 ${JSON.stringify(input.keys ?? input.key ?? "")}`, scroll: "滚动", invoke_menu: `点菜单 ${JSON.stringify(input.path ?? input.menu ?? "")}`, bring_to_front: "切换到窗口",
	};
	return `在你的电脑上${label[tool] ?? `执行 ${tool}`}`;
}
