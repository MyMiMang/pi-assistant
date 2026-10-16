/**
 * 测试入口隔离底线（`packages/server/test/launch-memory.ts`）的真实证据：
 *
 *  - 故意继承一个「生产样」的 `PIA_WORKSPACE` 毒值（tmp 下的 fake-production sentinel，**绝不使用真实用户路径**），
 *    断言入口把它覆盖为 `<DATA>/workspace`，sentinel 目录保持为空 —— launcher 不会写用户工作区；
 *  - `PIA_TEST_STARTUP_FILE`：启动期内存凭据被调用（storeCalls > 0），说明走的是注入的内存后端；
 *  - PATH 前缀里的假 `security` 探针计数为 0 —— 没有碰系统 `security` / 钥匙串。
 *
 * 运行：node e2e/launch-memory-safety.mjs   （真实 server + Mock + 临时数据目录，不联网 / 不碰真实配置）
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSecurityProbe, startupEvidence } from "./fixtures/safe-memory-server.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = mkdtempSync(join(tmpdir(), "pia-launch-safety-"));
const POISON = join(tmpdir(), `pia-fake-production-workspace-${process.pid}`);
mkdirSync(POISON, { recursive: true });
const probe = createSecurityProbe(DATA);
const startupFile = join(DATA, "startup.json");
const PORT = await new Promise((r) => {
	const s = createServer().listen(0, "127.0.0.1", () => {
		const p = s.address().port;
		s.close(() => r(p));
	});
});
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
const check = (name, cond, detail = "") => {
	if (cond) console.log(`  ✅ ${name}`);
	else {
		failed++;
		console.error(`  ❌ ${name} ${detail}`);
	}
};

const child = spawn(process.execPath, ["--import", "tsx", "packages/server/test/launch-memory.ts"], {
	cwd: ROOT,
	env: {
		...process.env,
		PIA_DATA_DIR: DATA,
		PIA_WORKSPACE: POISON,
		PIA_MOCK: "1",
		PIA_OFFLINE: "1",
		PIA_HOST: "127.0.0.1",
		PIA_PORT: String(PORT),
		PIA_TEST_STARTUP_FILE: startupFile,
		PATH: `${probe.binDir}:${process.env.PATH ?? ""}`,
	},
	stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (d) => (logs += d));
child.stderr.on("data", (d) => (logs += d));

try {
	const end = Date.now() + 40_000;
	let up = false;
	while (Date.now() < end) {
		try {
			if ((await fetch(`${BASE}/api/system/public`)).ok) {
				up = true;
				break;
			}
		} catch {}
		await new Promise((r) => setTimeout(r, 120));
	}
	assert.ok(up, `server 未起来：${logs.slice(-800)}`);

	const ev = await startupEvidence(startupFile, probe);
	check("启动期凭据走内存后端（storeCalls > 0）", ev.storeCalls > 0, `storeCalls=${ev.storeCalls}`);
	check("0 次系统 security 探针（不碰钥匙串）", ev.securityCalls === 0, `security=${ev.securityCalls}`);
	check("毒值 PIA_WORKSPACE 未被写入（sentinel 空）", readdirSync(POISON).length === 0, `entries=${readdirSync(POISON).length}`);
	check("入口确实覆盖了越界 workspace（有 stderr 提示）", /覆盖为/.test(logs));
} catch (e) {
	console.error("运行失败：", e);
	console.error(logs.slice(-1200));
	failed++;
} finally {
	child.kill("SIGTERM");
	await new Promise((r) => setTimeout(r, 300));
	if (child.exitCode === null) child.kill("SIGKILL");
	rmSync(DATA, { recursive: true, force: true });
	rmSync(POISON, { recursive: true, force: true });
}
console.log(failed === 0 ? "\n全部通过 ✅" : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
