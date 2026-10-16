/**
 * 仅测试：用公开 `CredentialStore` 注入点启动**真实服务**，全程不构造走 OS 钥匙串的安全后端。
 * 用法：PIA_DATA_DIR=<临时目录> node --import tsx test/launch-memory.ts
 *
 * 与 `src/main.ts` 的唯一差别：先经公开注入点 `initModels(memoryCredentialStore())` 注入内存后端，
 * 再动态加载 `src/main.ts`；main.ts 内部的无参 `initModels()` 会复用已注入的后端（见 models.ts），
 * 因此不会 `new EncryptedCredentialStore()`、不会调用 `security`。
 *
 * 隔离底线（在最前面、任何动态 import（config / models / 内存凭据）之前执行）：
 *  - `PIA_DATA_DIR` 必须是可信临时目录（`os.tmpdir()`、`/tmp`、`/private/tmp`）；缺失或不可信时
 *    改用一个新的 `mkdtempSync` 临时目录，**绝不沿用用户真实数据目录**；
 *  - `PIA_WORKSPACE` 必须落在该临时数据目录内，否则强制覆盖为 `<DATA>/workspace`，绝不写用户真实工作区。
 *
 * 证据：用一个计数代理包住注入的内存后端，启动完成后把「内存后端被调用次数」写进
 * `PIA_TEST_STARTUP_FILE` 指定的 JSON。次数 > 0 说明启动期的凭据访问确实走了内存后端。
 * 是否调用 `security` 由测试方用 PATH 上的假 `security` 探测。
 * 只在测试里使用；生产仍走 `src/main.ts`，不读取本文件。
 */
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";

const statusFile = process.env.PIA_TEST_STARTUP_FILE;

/** 规范化到真实路径（跟随 macOS `/tmp` → `/private/tmp` 这类符号链接）；不存在时用最近的存在祖先。 */
const canonical = (p: string): string => {
	let abs = resolve(p);
	if (existsSync(abs)) return realpathSync(abs);
	const tail: string[] = [];
	while (!existsSync(abs) && dirname(abs) !== abs) {
		tail.unshift(basename(abs));
		abs = dirname(abs);
	}
	return join(existsSync(abs) ? realpathSync(abs) : abs, ...tail);
};
const isWithin = (child: string, parent: string): boolean => {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
/** 用 path.relative 精确判断，避免 `/tmpx`、`/tmpfoo` 被简单前缀误判。 */
const trustedRoots = [tmpdir(), "/tmp", "/private/tmp"].map(canonical);
const isTrustedTemp = (p: string): boolean => {
	const c = canonical(p);
	return trustedRoots.some((root) => isWithin(c, root));
};

const rawData = process.env.PIA_DATA_DIR?.trim() ?? "";
if (!rawData || !isTrustedTemp(rawData)) {
	const fresh = mkdtempSync(join(tmpdir(), "pia-launch-memory-"));
	process.stderr.write(`[launch-memory] 不可信/缺失的 PIA_DATA_DIR=${JSON.stringify(rawData)} → 改用临时目录 ${fresh}\n`);
	process.env.PIA_DATA_DIR = fresh;
}
const dataDir = process.env.PIA_DATA_DIR as string;
const rawWorkspace = process.env.PIA_WORKSPACE?.trim() ?? "";
if (!rawWorkspace || !isTrustedTemp(rawWorkspace) || !isWithin(canonical(rawWorkspace), canonical(dataDir))) {
	const safe = join(dataDir, "workspace");
	process.stderr.write(`[launch-memory] 越界/不可信的 PIA_WORKSPACE=${JSON.stringify(rawWorkspace)} → 覆盖为 ${safe}\n`);
	process.env.PIA_WORKSPACE = safe;
}

let storeCalls = 0;
const base = (await import("./in-memory-credentials.ts")).memoryCredentialStore();
const countingStore = new Proxy(base, {
	get(target, prop, receiver) {
		const v = Reflect.get(target, prop, receiver) as unknown;
		if (typeof v !== "function") return v;
		return (...args: unknown[]) => {
			storeCalls++;
			return (v as (...a: unknown[]) => unknown).apply(target, args);
		};
	},
}) as CredentialStore;

const { initModels } = await import("../src/models.ts");
await initModels(countingStore);
// 动态导入 main.ts：它内部的无参 initModels() 复用上面注入的内存后端，不碰 OS 钥匙串。
await import("../src/main.ts");

if (statusFile) {
	try {
		writeFileSync(statusFile, JSON.stringify({ storeCalls }));
	} catch {
		/* 状态文件只是证据，写不进去不影响服务 */
	}
}
// 服务已经在跑，保活；被 SIGKILL 时不需要清理。
await new Promise(() => {});
