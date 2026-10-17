/**
 * e2e 里要起的**原生浏览器 / 原生子进程**用的环境（和 `packages/server/src/native-launch-env.ts` 同一套规则）。
 *
 * 为什么 e2e 需要单独一份：e2e 是纯 `.mjs`（不经过 tsx），拿不到 TS 模块；而且 e2e 自己会把服务进程的
 * HOME / TMPDIR 换成临时目录（隔离底线，不能动）。这里只负责“给原生进程的那一份”。
 *
 * 与 TS 版一致的规则：
 *  1. `HOME` 取 `os.userInfo().homedir`（不是 `$HOME`，也不采信调用方可能已经改过的 `process.env.HOME`）；
 *  2. 删 `CFFIXED_USER_HOME`（它会覆盖 HOME）；
 *  3. `TMPDIR` / `TEMP` / `TMP`：服务的 HOME 与真实家目录不一致（= 这次是隔离启动），或值落在已知合成根里，
 *     一律删掉——**不要在调用方已经改成合成值之后再读 `process.env.TMPDIR` 当成真实值**（旧写法就这么错的）。
 *
 * 注意：这是「给原生进程」的环境，不能拿去起服务端（服务端必须继续用临时 HOME + 临时 TMPDIR）。
 */
import { userInfo } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

const isWithin = (p, root) => {
	try {
		const r = relative(resolve(root), resolve(p));
		return r === "" || (!r.startsWith("..") && !isAbsolute(r));
	} catch {
		return false;
	}
};

const TEMP_VARS = ["TMPDIR", "TEMP", "TMP"];

/**
 * @param {{ baseEnv?: NodeJS.ProcessEnv, realHome?: string | null, syntheticRoots?: string[] }} [opts]
 * @returns {NodeJS.ProcessEnv} 新对象，不改调用方 env
 */
export function nativeLaunchBrowserEnv(opts = {}) {
	const env = { ...(opts.baseEnv ?? process.env) };
	const realHome = opts.realHome === undefined ? userInfo().homedir || null : opts.realHome;
	const roots = opts.syntheticRoots ?? [];
	delete env.CFFIXED_USER_HOME;
	if (realHome) env.HOME = realHome;
	const diverged = !!realHome && !!env.HOME && env.HOME !== realHome;
	for (const name of TEMP_VARS) {
		const v = env[name];
		if (!v) continue;
		if (diverged || roots.some((root) => root && isWithin(v, root))) delete env[name];
	}
	return env;
}
