/**
 * benchmark harness 的**纯函数**环境助手（无副作用、不读磁盘、不读凭据、不读 env）。
 *
 * 为什么单独抽出来：harness 自己的隔离有两层，混在一起最容易错——
 *  1. **服务进程**（本脚本、生产 TS 模块、fixture 网关）：HOME / TMPDIR / PIA_DATA_DIR / PIA_WORKSPACE
 *     必须全部落在本次 scratch 根内（合成 HOME）。这是测试隔离底线（内存凭据 + 临时数据目录），
 *     **不能**因为「原生子进程需要真实 HOME」就把服务进程也改成原生 HOME。
 *  2. **原生边界**（CuaDriver daemon、它拉起的 Chrome、cua-driver MCP）：需要一份 OS 账户语义的环境，
 *     由生产 `native-launch-env.ts` 的 `nativeLaunchEnv()` 从**显式 clone 的 base env** 计算，
 *     本进程的 HOME 是什么都不影响它。
 *
 * 这里只放第 1 层的规划 / 判定，以及第 2 层的 base env clone；原生规则本身仍只由 TS 生产模块提供
 * （不在这里复制一份规则，避免和 `e2e/fixtures/native-launch-env.mjs` 那样出现两份实现漂移）。
 */
import { isAbsolute, join, relative, resolve } from "node:path";

/** scratch 根归属标记（和 laya-real-smoke 同一套：存在且内容为 owner 才认）。 */
export const SYNTHETIC_ROOT_MARKER = ".pia-laya-bench-owner";

/** 路径 `p` 是否落在 `root` 内（按路径段比较，不用裸前缀，避免 `/tmpx` 命中 `/tmp`）。 */
export function isWithin(p, root) {
	try {
		const rel = relative(resolve(root), resolve(p));
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	} catch {
		return false;
	}
}

/**
 * scratch 根下的目录规划。**服务进程与原生 profile 分开**：profile 目录给 daemon 用，
 * 其余（home / tmp / data / workspace）给服务进程用。
 */
export function planScratchDirs(root) {
	return {
		root,
		home: join(root, "home"),
		tmp: join(root, "tmp"),
		dataDir: join(root, "data"),
		workspaceDir: join(root, "workspace"),
		profileRoot: join(root, "browser-profile"),
	};
}

/**
 * 服务进程要设置的 env 覆盖（新对象，不改入参）。
 * HOME / TMPDIR / TEMP / TMP 都指向 scratch 根内，**不要**在这里透传 OS 临时目录。
 */
export function serviceIsolationEnv({ baseEnv = process.env, dirs }) {
	return {
		...baseEnv,
		HOME: dirs.home,
		TMPDIR: dirs.tmp,
		TEMP: dirs.tmp,
		TMP: dirs.tmp,
		PIA_DATA_DIR: dirs.dataDir,
		PIA_WORKSPACE: dirs.workspaceDir,
		PIA_OFFLINE: "1",
	};
}

/** 白名单只读这几项（打印 / 落证据用；不遍历 env，不碰凭据类变量）。 */
export function envWhitelist(env, { root, realHome }) {
	const tmp = env.TMPDIR ?? null;
	const dataDir = env.PIA_DATA_DIR ?? null;
	const workspace = env.PIA_WORKSPACE ?? null;
	return {
		home: env.HOME ?? null,
		homeIsOsAccount: !!realHome && env.HOME === realHome,
		cffixedUserHomePresent: Object.prototype.hasOwnProperty.call(env, "CFFIXED_USER_HOME"),
		tmpdir: tmp,
		tmpdirUnderSyntheticRoot: tmp ? isWithin(tmp, root) : false,
		piaDataDir: dataDir,
		piaDataDirUnderSyntheticRoot: dataDir ? isWithin(dataDir, root) : false,
		piaWorkspaceUnderSyntheticRoot: workspace ? isWithin(workspace, root) : false,
	};
}

/**
 * 服务进程隔离自检：空数组 = 服务进程确实跑在合成环境里。
 * 原生 HOME **不是**这里的通过条件（原生边界由 `nativeLaunchEnv()` 单独构造）。
 */
export function serviceIsolationProblems(env, { root, realHome }) {
	const problems = [];
	const home = env.HOME ?? null;
	if (!home) problems.push("服务进程 HOME 缺失");
	else if (realHome && home === realHome) problems.push(`服务进程 HOME 仍是 OS 账户家目录（${home}）——违反临时 HOME 隔离要求`);
	else if (!isWithin(home, root)) problems.push(`服务进程 HOME 不在本次 scratch 根内（${home}）`);

	for (const name of ["TMPDIR", "TEMP", "TMP"]) {
		const v = env[name];
		if (!v) continue;
		if (!isWithin(v, root)) problems.push(`服务进程 ${name} 不在本次 scratch 根内（${v}）`);
	}
	if (!env.PIA_DATA_DIR) problems.push("服务进程 PIA_DATA_DIR 缺失");
	else if (!isWithin(env.PIA_DATA_DIR, root)) problems.push(`服务进程 PIA_DATA_DIR 不在本次 scratch 根内（${env.PIA_DATA_DIR}）`);
	if (!env.PIA_WORKSPACE) problems.push("服务进程 PIA_WORKSPACE 缺失");
	else if (!isWithin(env.PIA_WORKSPACE, root)) problems.push(`服务进程 PIA_WORKSPACE 不在本次 scratch 根内（${env.PIA_WORKSPACE}）`);
	return problems;
}

/**
 * 原生边界的 base env：显式 clone 一份快照，交给生产 `nativeLaunchEnv()` 计算。
 * 之后本进程再改 `process.env` 也不会影响这份输入（反过来也不会），
 * 这样「服务隔离」和「原生子进程环境」是两条可分别审计的路径。
 */
export function cloneNativeBaseEnv(baseEnv = process.env) {
	return { ...baseEnv };
}
