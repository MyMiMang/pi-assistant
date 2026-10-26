/**
 * 检测本机的 `claude` / `codex`：在哪、什么版本、是否已登录（`claude auth status` / `codex login status`）。
 * 不读任何凭证文件、不碰钥匙串，只问官方命令；环境和真正启动时同一套白名单（`buildClaudeEnv` / `buildCodexEnv`）。
 * 登录交给用户自己在终端里做（`claude auth login` / `codex login`），我们不代为登录。
 */
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { osAccountHome } from "../native-launch-env.ts";
import { buildCodexEnv } from "./codex-launch.ts";
import { buildClaudeEnv } from "./launch.ts";

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
	if (home) dirs.push(...homeDirs.map((d) => join(home, ...d)), join(home, ".local", "bin"), join(home, ".npm-global", "bin"), join(home, ".bun", "bin"), join(home, ".volta", "bin"));
	if (platform !== "win32") dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin");
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
	const env = buildClaudeEnv({ baseEnv: opts.baseEnv, extra: opts.extraEnv });
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
	const env = buildCodexEnv({ baseEnv: opts.baseEnv, extra: opts.extraEnv });
	const timeout = opts.timeoutMs ?? 15_000;
	const ver = await run(command, ["--version"], env, timeout);
	if (ver.failed) return { installed: false, command, loggedIn: false, error: `运行 codex 失败：${ver.failed}` };
	const version = /\d+\.\d+\.\d+\S*/.exec(ver.stdout)?.[0];
	const st = await run(command, ["login", "status"], env, timeout);
	if (st.failed) return { installed: true, command, version, loggedIn: false, error: `检测登录状态失败：${st.failed}` };
	// 只看退出码，不转述输出（API key 登录时输出里可能带密钥片段）
	return { installed: true, command, version, loggedIn: st.code === 0 };
}
