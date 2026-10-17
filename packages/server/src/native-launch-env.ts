/**
 * 原生子进程启动环境（CuaDriver 守护进程 / cua-driver MCP / 本机浏览器）。
 *
 * 为什么需要这一层：测试与隔离启动会把**服务进程**的 HOME 指到临时目录（配合内存凭据，
 * 不碰用户真实数据目录与钥匙串，见 `test/launch-memory.ts`）。但 CuaDriver 守护进程、它拉起的
 * 系统 Chrome、以及我们自己用 Playwright 起的 Chrome 都是**原生 macOS 进程**：它们按 HOME 解析
 * 用户级状态与钥匙串搜索列表。合成 HOME 传下去时，驱动会把 `~/Library/Caches/cua-driver` 之类写进临时目录，
 * Chrome 也不该拿一份不存在的家目录——这是已经证实的**环境传播**问题。至于本机那次
 * 「找不到用于储存“Chrome”的钥匙串」弹窗，目前只有**时间上的相关**，macOS 侧的因果**未验**，
 * 所以本文档不写「换回真实 HOME 就修好了钥匙串」。
 *
 * 所以边界划在这里：**服务自己的隔离不动**（temp HOME / PIA_DATA_DIR / PIA_WORKSPACE / 内存凭据照旧），
 * 只给原生子进程一份「OS 账户语义」的环境。生产环境里 HOME 本来就是登录用户家目录，所以默认是恒等变换
 * （例外：生产进程里如果有人设了 `CFFIXED_USER_HOME`，它会被清掉——那不是恒等）。
 *
 * 规则（纯函数，不读文件、不读凭据、不按 env 猜家目录）：
 *  1. `HOME` 一律取调用方给的 **OS 账户家目录**（生产用 `os.userInfo().homedir`，不用 `$HOME`）；
 *     取不到时不改写、也不猜，`homeSource: "unknown"` 让调用方自己决定怎么记日志。
 *  2. `CFFIXED_USER_HOME` 一律删除：它会覆盖 HOME 让上面的设置失效（项目里本来也没有人设它）。
 *  3. 服务 HOME 与 OS 家目录不一致（= 这份环境来自隔离启动）时，`TMPDIR` / `TEMP` / `TMP` 一并剥离，
 *     交给 OS 默认临时目录；一致时只剥离落在已知合成根（数据目录等）里的值。**不保留合成临时目录。**
 *  4. 其余变量原样保留：`PIA_DATA_DIR` / `PIA_WORKSPACE` / `CUA_DRIVER_BROWSER_PROFILE_ROOT` /
 *     `CUA_DRIVER_TELEMETRY` 这些是**数据 / profile 隔离**用的，不靠改 HOME 实现，也不影响钥匙串。
 *  5. 交给 MCP（Pi `StdioTransport`）这类**会把 `process.env` 合并回来**的通道时，必须用
 *     `nativeLaunchCommand()` 包一层自有启动器：只传「少几个键」的 env 对象删不掉任何东西。
 */

import { userInfo } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface NativeLaunchEnvInput {
	/** 服务进程当前环境（默认 `process.env`）；只读，不会被修改 */
	baseEnv?: NodeJS.ProcessEnv;
	/** OS 账户家目录（`os.userInfo().homedir`）；`null` = 取不到，此时不改写 HOME */
	realHome: string | null;
	/** 已知合成隔离根（数据目录、临时目录…）：落在其中的临时目录变量一律剥离 */
	syntheticRoots?: Array<string | undefined>;
	/** 目标平台（默认当前平台）；只影响是否顺带对齐 `USERPROFILE` */
	platform?: NodeJS.Platform;
	/** 额外设置 / 覆盖（例如 `CUA_DRIVER_TELEMETRY: "0"`） */
	extra?: Record<string, string>;
}

export interface NativeLaunchEnvResult {
	/** 给原生子进程用的环境（新对象） */
	env: NodeJS.ProcessEnv;
	/** 服务的 HOME 与 OS 账户家目录不一致（服务跑在合成 HOME 下；只记录，不因此拒绝启动） */
	diverged: boolean;
	/** 被删除的变量名（HOME 是改写，不在这里） */
	stripped: string[];
	/** 真实家目录来源：`os` = 来自 OS 账户信息；`unknown` = 取不到，未改写 */
	homeSource: "os" | "unknown";
	/** 实际用到的 OS 账户家目录（`homeSource:"unknown"` 时为 null） */
	realHome: string | null;
}

/** 路径 `p` 是否落在 `root` 内（按路径段比较，不用裸前缀，避免 `/tmpx` 命中 `/tmp`）。 */
function isWithin(p: string, root: string): boolean {
	try {
		const r = relative(resolve(root), resolve(p));
		return r === "" || (!r.startsWith("..") && !isAbsolute(r));
	} catch {
		return false;
	}
}

const withinAny = (p: string, roots: Array<string | undefined>): boolean => roots.some((root) => !!root && isWithin(p, root));

/** 与「按用户隔离」有关、必须剥离的临时目录变量（macOS 主要看 TMPDIR，Windows 用 TEMP/TMP）。 */
const TEMP_VARS = ["TMPDIR", "TEMP", "TMP"] as const;

/**
 * 构造原生子进程的环境。纯函数：同一个输入永远同一个输出，不读磁盘、不读凭据、不读数据库。
 */
export function nativeLaunchEnv(input: NativeLaunchEnvInput): NativeLaunchEnvResult {
	const platform = input.platform ?? process.platform;
	const env: NodeJS.ProcessEnv = { ...(input.baseEnv ?? process.env) };
	const stripped: string[] = [];
	const realHome = input.realHome && input.realHome.trim() ? input.realHome : null;
	const diverged = !!realHome && !!env.HOME && env.HOME !== realHome;

	// 1) CFFIXED_USER_HOME 会覆盖 HOME（CoreFoundation 系进程优先读它），留着等于没改。
	if (env.CFFIXED_USER_HOME !== undefined) {
		delete env.CFFIXED_USER_HOME;
		stripped.push("CFFIXED_USER_HOME");
	}

	// 2) HOME = OS 账户家目录。取不到就原样返回，绝不按 env 猜一个「看起来像家目录」的值。
	if (realHome) {
		env.HOME = realHome;
		// Windows 原生进程（Chrome 等）看 USERPROFILE；存在才对齐，不凭空造。
		if (platform === "win32" && env.USERPROFILE !== undefined) env.USERPROFILE = realHome;
	}

	// 3) 合成临时目录不传给原生进程：服务本身跑在合成 HOME 下时整份环境都是隔离的，
	//    临时目录同属这套隔离；否则只剥离明确落在合成根里的值。
	const roots = input.syntheticRoots ?? [];
	for (const name of TEMP_VARS) {
		const v = env[name];
		if (!v) continue;
		if (diverged || withinAny(v, roots)) {
			delete env[name];
			stripped.push(name);
		}
	}

	if (input.extra) for (const [k, v] of Object.entries(input.extra)) env[k] = v;
	return { env, diverged, stripped, homeSource: realHome ? "os" : "unknown", realHome };
}

/** 收紧成 `Record<string, string>`（丢掉 undefined），给只收纯字符串 env 的公开接口（如 MCP stdio）用。 */
export const envStrings = (env: NodeJS.ProcessEnv): Record<string, string> =>
	Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string"));

/** 自有启动器：argv 只带键名 / 非敏感 HOME，环境在启动器进程内构造（见 `mcp-env-launcher.mjs`）。 */
const LAUNCHER = fileURLToPath(new URL("./mcp-env-launcher.mjs", import.meta.url));

export interface NativeLaunchCommand {
	/** 要 spawn 的可执行文件：自己的启动器（由 `process.execPath` 跑） */
	command: string;
	args: string[];
	/** 目标命令应当拿到的环境（纯字符串；实际生效靠启动器内的 `spawn(...,{env})` 全量替换） */
	env: Record<string, string>;
	/**
	 * true = 最终子进程环境由启动器**全量替换**，调用方再额外塞 env 也不会把删掉的键带回来。
	 *
	 * 为什么必须这样：Pi 的 `StdioTransport` 默认 `{...process.env, ...cmd.env}`（`inheritEnv` 没关），
	 * 而 Pi 内置 MCP 扩展构造 transport 时不传 `inheritEnv` → 只传一份缺键的 env 对象删不掉任何东西
	 * （`CFFIXED_USER_HOME` / 合成 `TMPDIR` 会从父进程重新长回来）。公开接口改不了这条合并规则、也不改
	 * node_modules，所以由**自有启动器**在进程内构造好环境再 spawn 真实命令。
	 *
	 * 不用 `env -i K=V …` 的理由：那会把整份环境写进 argv（`ps` / 操作历史可见），可能泄露 token / key。
	 */
	envReplaced: boolean;
	/** 给自己构造 `StdioTransport` 的调用方（如 `createMcpInvoke`）：传它就不用再合并 `process.env` */
	inheritEnv: false;
	/** 服务的 HOME 与 OS 账户家目录不一致（隔离启动） */
	diverged: boolean;
	stripped: string[];
	homeSource: "os" | "unknown";
	realHome: string | null;
}

/**
 * 把一条要交给原生进程（如 `cua-driver mcp`）的命令包成「最终环境全量替换」的形式。
 *
 * 实现：`node mcp-env-launcher.mjs --strip=KEY… --set=KEY=VALUE… -- <原命令> <原参数>`。
 * argv 里只出现**键名**和**非敏感路径值（HOME）**，不出现任何其它环境变量的值。
 */
export function nativeLaunchCommand(
	cmd: { command: string; args: readonly string[] },
	opts: {
		baseEnv?: NodeJS.ProcessEnv;
		realHome?: string | null;
		syntheticRoots?: Array<string | undefined>;
		platform?: NodeJS.Platform;
		extra?: Record<string, string>;
	} = {},
): NativeLaunchCommand {
	const platform = opts.platform ?? process.platform;
	const r = nativeLaunchEnv({
		baseEnv: opts.baseEnv,
		realHome: opts.realHome === undefined ? osAccountHome() : opts.realHome,
		syntheticRoots: opts.syntheticRoots,
		platform,
		extra: opts.extra,
	});
	const env = envStrings(r.env);
	// 启动器从自己继承的 env 出发：删掉被剥的键，把 HOME 覆盖成 OS 账户家目录。
	// 拿不到 OS 家目录时不覆盖（保持继承值），并在调用方可见的 `homeSource` 里说明。
	const strip = [...r.stripped];
	// `extra` 是**非敏感**固定开关（如 `CUA_DRIVER_TELEMETRY=0`）：它们会被写进 argv（`--set=K=V`），
	// 所以只允许常量 / 路径类值。密钥 / token 绝不能走 `extra`（会被 `ps` / 操作历史看到）。
	const setArgs = [
		...(r.realHome ? [`--set=HOME=${r.realHome}`] : []),
		...(platform === "win32" && r.realHome && env.USERPROFILE !== undefined ? [`--set=USERPROFILE=${r.realHome}`] : []),
		...Object.entries(opts.extra ?? {}).map(([k, v]) => `--set=${k}=${v}`),
	];
	return {
		command: process.execPath,
		args: [
			LAUNCHER,
			...strip.map((k) => `--strip=${k}`),
			...setArgs,
			"--",
			cmd.command,
			...cmd.args,
		],
		env,
		envReplaced: true,
		inheritEnv: false,
		diverged: r.diverged,
		stripped: r.stripped,
		homeSource: r.homeSource,
		realHome: r.realHome,
	};
}

/** OS 账户家目录（`os.userInfo().homedir`）；取不到返回 null。不要用 `$HOME` 代替。 */
export function osAccountHome(): string | null {
	try {
		return userInfo().homedir || null;
	} catch {
		return null;
	}
}

/**
 * 生产便捷入口：家目录取 `os.userInfo().homedir`（OS 账户信息，不是 `$HOME`）。
 * `os.userInfo()` 在极端环境（无 passwd 条目等）会抛，此时返回 `homeSource: "unknown"` 且不改写 HOME。
 */
export function nativeLaunchEnvForChild(
	extra?: Record<string, string>,
	opts: { syntheticRoots?: Array<string | undefined>; platform?: NodeJS.Platform } = {},
): NativeLaunchEnvResult {
	return nativeLaunchEnv({ realHome: osAccountHome(), syntheticRoots: opts.syntheticRoots, platform: opts.platform, extra });
}

/**
 * 校验一份准备交给原生进程的环境（纯判断、无副作用）：返回问题清单，空数组 = 可以启动。
 * 用于单测与启动前的一次自检（自检只记日志，不因此拒绝启动——把隔离问题变成启动失败只会更难排查）。
 */
export function nativeLaunchEnvProblems(
	env: NodeJS.ProcessEnv,
	opts: { realHome: string | null; syntheticRoots?: Array<string | undefined> },
): string[] {
	const problems: string[] = [];
	const realHome = opts.realHome && opts.realHome.trim() ? opts.realHome : null;
	if (env.CFFIXED_USER_HOME !== undefined) problems.push("CFFIXED_USER_HOME 仍然存在（会覆盖 HOME）");
	if (realHome) {
		if (!env.HOME) problems.push("HOME 缺失");
		else if (env.HOME !== realHome) problems.push(`HOME 不是 OS 账户家目录（${env.HOME}）`);
	}
	const roots = opts.syntheticRoots ?? [];
	for (const name of TEMP_VARS) {
		const v = env[name];
		if (v && withinAny(v, roots)) problems.push(`${name} 指向合成隔离目录（${v}）`);
	}
	return problems;
}
