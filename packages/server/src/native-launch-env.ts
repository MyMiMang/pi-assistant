/**
 * 原生子进程启动环境（CuaDriver 守护进程 / cua-driver MCP / 本机浏览器）。
 *
 * 为什么需要这一层：测试与隔离启动会把**服务进程**的 HOME 指到临时目录（配合内存凭据，
 * 不碰用户真实数据目录与钥匙串，见 `test/launch-memory.ts`）。但 CuaDriver 守护进程、它拉起的
 * 系统 Chrome、以及我们自己用 Playwright 起的 Chrome 都是**原生 macOS 进程**：它们按 HOME 解析
 * 用户级状态与钥匙串搜索列表。合成 HOME 传下去时，Chrome 会找不到默认钥匙串并弹
 * 「找不到用于储存“Chrome”的钥匙串」，驱动也会把 `~/Library/Caches/cua-driver` 之类写进临时目录。
 *
 * 所以边界划在这里：**服务自己的隔离不动**（temp HOME / PIA_DATA_DIR / PIA_WORKSPACE / 内存凭据照旧），
 * 只给原生子进程一份「OS 账户语义」的环境。生产环境本来 HOME 就是登录用户家目录，这条规则对它是恒等变换。
 *
 * 规则（纯函数，不读文件、不读凭据、不按 env 猜家目录）：
 *  1. `HOME` 一律取调用方给的 **OS 账户家目录**（生产用 `os.userInfo().homedir`，不用 `$HOME`）；
 *     取不到时不改写、也不猜，`homeSource: "unknown"` 让调用方自己决定怎么记日志。
 *  2. `CFFIXED_USER_HOME` 一律删除：它会覆盖 HOME 让上面的设置失效（项目里本来也没有人设它）。
 *  3. 服务 HOME 与 OS 家目录不一致（= 这份环境来自隔离启动）时，`TMPDIR` / `TEMP` / `TMP` 一并剥离，
 *     交给 OS 默认临时目录；一致时只剥离落在已知合成根（数据目录等）里的值。**不保留合成临时目录。**
 *  4. 其余变量原样保留：`PIA_DATA_DIR` / `PIA_WORKSPACE` / `CUA_DRIVER_BROWSER_PROFILE_ROOT` /
 *     `CUA_DRIVER_TELEMETRY` 这些是**数据 / profile 隔离**用的，不靠改 HOME 实现，也不影响钥匙串。
 */

import { userInfo } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

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
