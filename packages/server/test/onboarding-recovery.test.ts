/**
 * 首次向导恢复的 HTTP 级回归（真实服务进程，经公开 `initModels(credentials?)` 注入内存 `CredentialStore`，
 * 不构造走 OS 钥匙串的安全后端；临时数据目录 + 自由端口）。
 *
 * 证明：
 *   1. 全新数据目录 → `/api/system.onboarded=false`（仍然引导）；
 *   2. 已有助理 + 默认模型后 → `onboarded=true`、`modelReady=true`；
 *   3. 把向导标志显式改回 false（模拟升级 / 前端标志丢失）后 → `/api/system` 仍按「已配置」跳过，
 *      不再弹首次向导、不覆盖原配置。
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const freePort = () =>
	new Promise<number>((resolve) => {
		const sv = createServer().listen(0, "127.0.0.1", () => {
			const p = (sv.address() as { port: number }).port;
			sv.close(() => resolve(p));
		});
	});

interface Sys { onboarded: boolean; modelSetupDone?: boolean; modelReady?: boolean }

test("已配置但向导标志丢失：/api/system 仍跳过首次向导", { timeout: 90_000 }, async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "pia-onboarding-"));
	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	const j = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
		const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
		const data = await r.json();
		if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(data)}`);
		return data as T;
	};
	let server: ChildProcess | undefined;
	try {
		server = spawn(process.execPath, ["--import", "tsx", "packages/server/test/launch-memory.ts"], {
			cwd: ROOT,
			env: { ...process.env, PIA_DATA_DIR: dataDir, PIA_OFFLINE: "1", PIA_PORT: String(port) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		server.stdout?.on("data", (d) => process.stdout.write(`[launch-memory] ${d}`));
		server.stderr?.on("data", (d) => process.stderr.write(`[launch-memory] ${d}`));

		const end = Date.now() + 60_000;
		let ready = false;
		for (;;) {
			try {
				if ((await fetch(`${base}/api/system`)).ok) { ready = true; break; }
			} catch {
				/* 还没起 */
			}
			if (Date.now() > end) break;
			await new Promise((r) => setTimeout(r, 250));
		}
		assert.ok(ready, "服务应能正常启动");

		// 1. 全新数据目录：仍然引导
		const fresh = await j<Sys>("/api/system");
		assert.equal(fresh.onboarded, false, "全新安装应继续引导");
		assert.equal(fresh.modelSetupDone, false);

		// 2. 已有助理 + 默认模型
		await j("/api/agents", "POST", { name: "升级回归助理" });
		await j("/api/models/default", "PUT", { provider: "openai", model: "gpt-5" });
		const configured = await j<Sys>("/api/system");
		assert.equal(configured.onboarded, true);
		assert.equal(configured.modelSetupDone, true);
		assert.equal(configured.modelReady, true, "模型可解析时 modelReady 应为 true");

		// 3. 模拟向导标志丢失
		await j("/api/settings", "PUT", { onboarded: false });
		const recovered = await j<Sys>("/api/system");
		assert.equal(recovered.onboarded, true, "已有配置时不能因标志丢失就重弹首次向导");
		assert.equal(recovered.modelSetupDone, true);
	} finally {
		server?.kill("SIGKILL");
	}
});
