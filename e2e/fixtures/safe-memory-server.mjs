/**
 * e2e 专用：用测试入口启动**真实 server**，保证测试隔离底线。
 *
 * 入口固定为 `packages/server/test/launch-memory.ts`（公开 `CredentialStore` 注入点，全程内存后端，
 * 绝不构造走 OS 钥匙串的安全后端；入口自身会在最前面把 `PIA_DATA_DIR` / `PIA_WORKSPACE` 收敛到临时目录）。
 *
 * 这里额外提供两层证据，供调用方断言：
 *  1. `PIA_TEST_STARTUP_FILE`：入口写出的 `{ storeCalls }`，`> 0` 证明启动期凭据访问确实走了内存后端；
 *  2. 假 `security` 探针（放进 PATH 前缀，owned by 临时目录）：计数必须为 0，说明没有调用系统 `security`。
 *
 * 不复制生产启动逻辑，不读 / 不改用户真实配置；只发给 e2e。
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 在 dir 下造一个假 `security`（PATH 前缀），每次被调用就追加一行；不触真实 /usr/bin/security。 */
export function createSecurityProbe(dir) {
	const binDir = join(dir, "probe-bin");
	mkdirSync(binDir, { recursive: true });
	const logFile = join(dir, "security-probe.log");
	const script = join(binDir, "security");
	// 用 node 写脚本，避免依赖 shell 引号；命中即记一行并返回非 0。
	writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(logFile)}\nexit 1\n`);
	chmodSync(script, 0o755);
	return {
		binDir,
		logFile,
		calls: () => {
			try {
				return readFileSync(logFile, "utf8").split("\n").filter(Boolean).length;
			} catch {
				return 0;
			}
		},
	};
}

/** 启动测试入口。env 只用于追加（DATA/WORKSPACE/PORT/MOCK 等由这里固定，调用方不能改）。 */
export function spawnMemoryServer({ repoRoot, dataDir, port, env = {}, probe }) {
	const startupFile = join(dataDir, "startup.json");
	const child = spawn(process.execPath, ["--import", "tsx", "packages/server/test/launch-memory.ts"], {
		cwd: repoRoot,
		env: {
			...process.env,
			...env,
			PIA_DATA_DIR: dataDir,
			PIA_WORKSPACE: join(dataDir, "workspace"),
			PIA_MOCK: "1",
			PIA_OFFLINE: "1",
			PIA_HOST: "127.0.0.1",
			PIA_PORT: String(port),
			PIA_TEST_STARTUP_FILE: startupFile,
			PATH: `${probe ? `${probe.binDir}:` : ""}${process.env.PATH ?? ""}`,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	return { child, startupFile };
}

/** 等入口写出的启动证据并读取；返回 { storeCalls, securityCalls }。 */
export async function startupEvidence(startupFile, probe, ms = 8000) {
	const end = Date.now() + ms;
	let storeCalls = null;
	while (Date.now() < end) {
		try {
			storeCalls = JSON.parse(readFileSync(startupFile, "utf8")).storeCalls;
			break;
		} catch {
			/* 还没写出 */
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	return { storeCalls, securityCalls: probe ? probe.calls() : 0 };
}
