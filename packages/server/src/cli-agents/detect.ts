/**
 * 检测本机的 `claude` / `codex` / `agy` / `opencode`：在哪、什么版本、是否已登录（`claude auth status` / `codex login status` / `agy models` 成功）。
 * 不读任何凭证文件、不碰钥匙串，只问官方命令；环境和真正启动时同一套白名单（`buildClaudeEnv` / `buildCodexEnv`）。
 * 登录交给用户自己在终端里做（`claude auth login` / `codex login`），我们不代为登录。
 */
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { osAccountHome } from "../native-launch-env.ts";
import { parseAgyModels, type AgyFamily } from "./agy-models.ts";
import { buildAgyEnv } from "./agy-launch.ts";
import { buildCodexEnv } from "./codex-launch.ts";
import { buildOpencodeEnv, opencodeAuthPath, opencodeConfigHome } from "./opencode-launch.ts";
import { parseOpencodeModels, type OpencodeModel } from "./opencode-models.ts";
import { buildClaudeEnv, commonCliDirs } from "./launch.ts";

export interface ClaudeStatus {
	installed: boolean;
	/** 找到的可执行文件；没装时为 undefined */
	command?: string;
	version?: string;
	loggedIn: boolean;
	/** `claude auth status` 里的 authMethod，如 `claude.ai`、`oauth_token`、`none` */
	authMethod?: string;
	apiProvider?: string;
	/** 检测本身失败时的原因（没装、超时、输出看不懂） */
	error?: string;
}

/** 从桌面程序启动时 PATH 往往很短，常见安装位置也要找。 */
function candidateDirs(pathVar: string | undefined, home: string | null, platform: NodeJS.Platform, homeDirs: string[][]): string[] {
	const dirs = (pathVar ?? "").split(delimiter).filter(Boolean);
	if (home) dirs.push(...homeDirs.map((d) => join(home, ...d)));
	dirs.push(...commonCliDirs(home, platform));
	if (platform !== "win32") dirs.push("/usr/bin");
	return dirs;
}

const isExecutable = (p: string, platform: NodeJS.Platform): boolean => {
	try {
		if (!statSync(p).isFile()) return false;
		if (platform !== "win32") accessSync(p, constants.X_OK);
		return true;
	} catch {
		return false;
	}
};

interface FindOptions {
	env?: NodeJS.ProcessEnv;
	home?: string | null;
	platform?: NodeJS.Platform;
}

/** 在 PATH 和常见安装位置里找命令行工具；找不到返回 null。`homeDirs`：这个工具自己的家目录下安装位置。 */
function findCommand(name: string, homeDirs: string[][], opts: FindOptions): string | null {
	const platform = opts.platform ?? process.platform;
	const env = opts.env ?? process.env;
	const names = platform === "win32" ? [`${name}.exe`, `${name}.cmd`] : [name];
	for (const dir of candidateDirs(env.PATH ?? env.Path, opts.home === undefined ? osAccountHome() : opts.home, platform, homeDirs))
		for (const n of names) {
			const p = join(dir, n);
			if (isExecutable(p, platform)) return p;
		}
	return null;
}

/** 找 `claude` 可执行文件；找不到返回 null。 */
export const findClaudeCommand = (opts: FindOptions = {}): string | null => findCommand("claude", [[".claude", "local"]], opts);

/** 找 `codex` 可执行文件；找不到返回 null。 */
export const findCodexCommand = (opts: FindOptions = {}): string | null => findCommand("codex", [[".codex", "bin"]], opts);

/** 找 `agy` 可执行文件；找不到返回 null。 */
export const findAgyCommand = (opts: FindOptions = {}): string | null => findCommand("agy", [], opts);

/** 找 `opencode` 可执行文件（官方安装脚本装在 `~/.opencode/bin`）；找不到返回 null。 */
export const findOpencodeCommand = (opts: FindOptions = {}): string | null => findCommand("opencode", [[".opencode", "bin"]], opts);

interface Ran {
	stdout: string;
	stderr: string;
	code: number | null;
	/** 起不来（不存在 / 超时）的原因 */
	failed?: string;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Ran> {
	return new Promise((resolve) => {
		execFile(command, args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
			if (!err) return resolve({ stdout, stderr, code: 0 });
			const e = err as NodeJS.ErrnoException & { killed?: boolean };
			if (typeof e.code === "number") return resolve({ stdout, stderr, code: e.code }); // 正常退出但码非 0（未登录时 auth status 退出 1）
			resolve({ stdout, stderr, code: null, failed: e.killed ? `超时（${Math.round(timeoutMs / 1000)} 秒）` : String(e.code ?? e.message) });
		});
	});
}

export interface DetectOptions {
	/** 指定 claude 路径（默认自己找） */
	command?: string;
	baseEnv?: NodeJS.ProcessEnv;
	/** 额外环境变量（测试用假 claude） */
	extraEnv?: Record<string, string>;
	timeoutMs?: number;
}

/** 检测是否安装、版本、是否已登录。永不抛错。 */
export async function detectClaude(opts: DetectOptions = {}): Promise<ClaudeStatus> {
	const command = opts.command ?? findClaudeCommand({ env: opts.baseEnv });
	if (!command) return { installed: false, loggedIn: false, error: "没有找到 claude 命令" };
	const env = buildClaudeEnv({ baseEnv: opts.baseEnv, command, extra: opts.extraEnv });
	const timeout = opts.timeoutMs ?? 15_000;
	const ver = await run(command, ["--version"], env, timeout);
	if (ver.failed) return { installed: false, command, loggedIn: false, error: `运行 claude 失败：${ver.failed}` };
	const version = /\d+\.\d+\.\d+\S*/.exec(ver.stdout)?.[0];
	const st = await run(command, ["auth", "status"], env, timeout);
	if (st.failed) return { installed: true, command, version, loggedIn: false, error: `检测登录状态失败：${st.failed}` };
	try {
		const j = JSON.parse(st.stdout) as { loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown };
		return {
			installed: true,
			command,
			version,
			loggedIn: j.loggedIn === true,
			authMethod: typeof j.authMethod === "string" ? j.authMethod : undefined,
			apiProvider: typeof j.apiProvider === "string" ? j.apiProvider : undefined,
		};
	} catch {
		return { installed: true, command, version, loggedIn: false, error: `看不懂 claude auth status 的输出：${(st.stdout || st.stderr).trim().slice(0, 200)}` };
	}
}

export interface CodexStatus {
	installed: boolean;
	command?: string;
	version?: string;
	loggedIn: boolean;
	error?: string;
}

/** 检测 codex 是否安装、版本、是否已登录（`codex login status` 退出码 0 = 已登录）。永不抛错，不读任何凭证文件。 */
export async function detectCodex(opts: DetectOptions = {}): Promise<CodexStatus> {
	const command = opts.command ?? findCodexCommand({ env: opts.baseEnv });
	if (!command) return { installed: false, loggedIn: false, error: "没有找到 codex 命令" };
	const env = buildCodexEnv({ baseEnv: opts.baseEnv, command, extra: opts.extraEnv });
	const timeout = opts.timeoutMs ?? 15_000;
	const ver = await run(command, ["--version"], env, timeout);
	if (ver.failed) return { installed: false, command, loggedIn: false, error: `运行 codex 失败：${ver.failed}` };
	const version = /\d+\.\d+\.\d+\S*/.exec(ver.stdout)?.[0];
	const st = await run(command, ["login", "status"], env, timeout);
	if (st.failed) return { installed: true, command, version, loggedIn: false, error: `检测登录状态失败：${st.failed}` };
	// 只看退出码，不转述输出（API key 登录时输出里可能带密钥片段）
	return { installed: true, command, version, loggedIn: st.code === 0 };
}

export interface AgyStatus {
	installed: boolean;
	command?: string;
	version?: string;
	/** `agy models` 成功并列出了模型 = 已登录（agy 没有 `auth status`；这条命令要联网，但不消耗模型额度） */
	loggedIn: boolean;
	error?: string;
}

/** 问 `agy models`：成功返回模型家族，失败抛带原文的错误。不读任何凭证文件。 */
export async function listAgyModels(command: string, opts: Omit<DetectOptions, "command"> = {}): Promise<AgyFamily[]> {
	const r = await run(command, ["models"], buildAgyEnv({ baseEnv: opts.baseEnv, command, extra: opts.extraEnv }), opts.timeoutMs ?? 30_000);
	if (r.failed) throw new Error(`运行 agy models 失败：${r.failed}`);
	if (r.code !== 0) throw new Error((r.stdout + r.stderr).trim().slice(0, 300) || `agy models 退出码 ${r.code}`);
	const families = parseAgyModels(r.stdout);
	if (!families.length) throw new Error("agy models 没有列出任何模型");
	return families;
}

/** 检测 agy 是否安装、版本、是否已登录。永不抛错。 */
export async function detectAgy(opts: DetectOptions = {}): Promise<AgyStatus> {
	const command = opts.command ?? findAgyCommand({ env: opts.baseEnv });
	if (!command) return { installed: false, loggedIn: false, error: "没有找到 agy 命令" };
	const env = buildAgyEnv({ baseEnv: opts.baseEnv, command, extra: opts.extraEnv });
	const ver = await run(command, ["--version"], env, opts.timeoutMs ?? 15_000);
	if (ver.failed) return { installed: false, command, loggedIn: false, error: `运行 agy 失败：${ver.failed}` };
	const version = /\d+\.\d+\.\d+\S*/.exec(ver.stdout)?.[0];
	try {
		await listAgyModels(command, opts);
		return { installed: true, command, version, loggedIn: true };
	} catch (e) {
		return { installed: true, command, version, loggedIn: false, error: e instanceof Error ? e.message : String(e) };
	}
}

export interface OpencodeStatus {
	installed: boolean;
	command?: string;
	version?: string;
	/** 登录凭据文件 `auth.json` 在不在（只看文件在不在，不读内容）。没登录也能用免费模型，所以不是「能不能用」 */
	loggedIn: boolean;
	error?: string;
}

export interface OpencodeDetectOptions extends Omit<DetectOptions, "command"> {
	command?: string;
	/** 数据目录：隔离的配置目录在它下面（列模型时用） */
	dataDir: string;
}

/** 问 `opencode models --verbose`（用和真正运行时同一套隔离环境）：返回支持工具调用的模型；失败或一个都没有就抛带原文的错误。 */
export async function listOpencodeModels(command: string, opts: OpencodeDetectOptions): Promise<OpencodeModel[]> {
	mkdirSync(opencodeConfigHome(opts.dataDir), { recursive: true, mode: 0o700 });
	const r = await run(command, ["models", "--verbose"], buildOpencodeEnv({ baseEnv: opts.baseEnv, command, dataDir: opts.dataDir, extra: opts.extraEnv }), opts.timeoutMs ?? 60_000);
	if (r.failed) throw new Error(`运行 opencode models 失败：${r.failed}`);
	if (r.code !== 0) throw new Error((r.stdout + r.stderr).trim().slice(0, 300) || `opencode models 退出码 ${r.code}`);
	const models = parseOpencodeModels(r.stdout);
	if (!models.length) throw new Error("opencode models 没有列出任何支持工具调用的模型");
	return models;
}

/** 检测 opencode 是否安装、版本、登录凭据在不在。永不抛错，不读任何凭证文件。 */
export async function detectOpencode(opts: OpencodeDetectOptions): Promise<OpencodeStatus> {
	const command = opts.command ?? findOpencodeCommand({ env: opts.baseEnv });
	if (!command) return { installed: false, loggedIn: false, error: "没有找到 opencode 命令" };
	const ver = await run(command, ["--version"], buildOpencodeEnv({ baseEnv: opts.baseEnv, command, dataDir: opts.dataDir, extra: opts.extraEnv }), opts.timeoutMs ?? 15_000);
	if (ver.failed) return { installed: false, command, loggedIn: false, error: `运行 opencode 失败：${ver.failed}` };
	const version = /\d+\.\d+\.\d+\S*/.exec(ver.stdout)?.[0];
	const auth = opencodeAuthPath(opts.baseEnv ?? process.env, osAccountHome());
	return { installed: true, command, version, loggedIn: !!auth && existsSync(auth) };
}
