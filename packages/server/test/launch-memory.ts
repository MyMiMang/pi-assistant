/**
 * 仅测试：用公开 `CredentialStore` 注入点启动**真实服务**，全程不构造走 OS 钥匙串的安全后端。
 * 用法：node --import tsx test/launch-memory.ts
 *
 * 与 `src/main.ts` 的唯一差别：先经公开注入点 `initModels(memoryCredentialStore())` 注入内存后端，
 * 再动态加载 `src/main.ts`；main.ts 内部的无参 `initModels()` 会复用已注入的后端（见 models.ts），
 * 因此不会 `new EncryptedCredentialStore()`、不会调用 `security`。
 *
 * 证据：用一个计数代理包住注入的内存后端，启动完成后把「内存后端被调用次数」写进
 * `PIA_TEST_STARTUP_FILE` 指定的 JSON。次数 > 0 说明启动期的凭据访问确实走了内存后端。
 * 是否调用 `security` 由测试方用 PATH 上的假 `security` 探测。
 * 只在测试里使用；生产仍走 `src/main.ts`，不读取本文件。
 */
import { writeFileSync } from "node:fs";
import type { CredentialStore } from "@earendil-works/pi-ai";

const statusFile = process.env.PIA_TEST_STARTUP_FILE;

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
