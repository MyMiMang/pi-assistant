/**
 * “操作这台电脑”冒烟测试：用我们生成的能力清单真跑 Cua Driver 的 bounded 模式（需要 Docker 与 pi-assistant/desktop 镜像，
 * 镜像里的 Linux 桌面充当“用户的电脑”）：
 *   PIA_DOCKER="sudo docker" node --import tsx test/host-control.smoke.ts
 * 验证：清单被 Cua 接受 → 经 `cua-driver mcp --socket`（与正式运行相同的接入方式）调用 →
 * 允许的应用能打开并读取窗口 → 清单外的工具 / 整屏观察被 Cua 拒绝 → 一键暂停（revoke --all）后一切调用被拒。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { config } from "../src/config.ts";
import { buildManifest } from "../src/host-control.ts";

const D = config.docker;
const NAME = "pia-host-smoke";
const dk = (...a: string[]) => execFileSync(D[0], [...D.slice(1), ...a], { encoding: "utf8" });
const log = (m: string) => console.log(`[host-smoke] ${m}`);
const yaml = buildManifest({ apps: [{ name: "终端", id: "/usr/bin/xfce4-terminal" }], workspaceFiles: true }, ["/home/agent/ws"], "linux");
writeFileSync("/tmp/pia-host-manifest.yaml", yaml);
try {
	dk("run", "-d", "--name", NAME, config.desktopImage);
	for (let i = 0; i < 40 && !dk("logs", NAME).includes("pia-desktop ready"); i++) await new Promise((r) => setTimeout(r, 250));
	dk("cp", "/tmp/pia-host-manifest.yaml", `${NAME}:/tmp/m.yaml`);
	dk("exec", NAME, "mkdir", "-p", "/home/agent/ws");
	dk("exec", "-d", "-e", "DISPLAY=:1", "-e", "CUA_DRIVER_TELEMETRY=0", NAME, "sh", "-c", "cua-driver serve --socket /tmp/c.sock --permission-mode bounded --capability-manifest /tmp/m.yaml --approve-capability-manifest --no-permissions-gate --no-overlay >/tmp/serve.log 2>&1");
	await new Promise((r) => setTimeout(r, 2500));
	const st = dk("exec", NAME, "cua-driver", "status", "--socket", "/tmp/c.sock");
	assert.match(st, /permission mode: bounded/);
	assert.match(st, /capability manifest: configured=true, approved_at_startup=true, valid=true/);
	log("Cua 接受了生成的清单（bounded）");

	// MCP（换行分隔的 JSON-RPC）
	const mcp = spawn(D[0], [...D.slice(1), "exec", "-i", "-e", "DISPLAY=:1", NAME, "cua-driver", "mcp", "--socket", "/tmp/c.sock"], { stdio: ["pipe", "pipe", "inherit"] });
	let buf = "";
	const waiters = new Map<number, (v: unknown) => void>();
	mcp.stdout.on("data", (d) => {
		buf += d;
		for (let i; (i = buf.indexOf("\n")) >= 0; ) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			try {
				const j = JSON.parse(line) as { id?: number };
				if (j.id !== undefined) waiters.get(j.id)?.(j);
			} catch {}
		}
	});
	let seq = 0;
	const rpc = (method: string, params: unknown) =>
		new Promise<{ result?: { content?: { text?: string }[]; tools?: { name: string }[]; isError?: boolean }; error?: unknown }>((res) => {
			const id = ++seq;
			waiters.set(id, res as never);
			mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pia-smoke", version: "0" } });
	mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const tools = (await rpc("tools/list", {})).result?.tools?.map((t) => t.name) ?? [];
	log(`MCP 工具 ${tools.length} 个`);
	const callText = async (name: string, args: Record<string, unknown>) => {
		const r = await rpc("tools/call", { name, arguments: args });
		return JSON.stringify(r.result ?? r.error);
	};
	const launched = await callText("launch_app", { name: "xfce4-terminal" });
	assert.match(launched, /"pid\\?":\s*\d+/);
	const pid = Number(/"pid\\?":\s*(\d+)/.exec(launched)![1]);
	const wid = Number(/"window_id\\?":\s*(\d+)/.exec(launched)?.[1] ?? 0);
	log(`允许的应用已打开 pid=${pid}`);
	if (wid) assert.doesNotMatch(await callText("get_window_state", { pid, window_id: wid }), /outside the capability manifest/, "允许的应用能读窗口");
	assert.match(await callText("get_desktop_state", {}), /outside the capability manifest|permission_denied/i, "整屏观察被拒绝");
	assert.match(await callText("clipboard_read", {}), /outside the capability manifest|permission_denied/i, "清单外工具被拒绝");
	log("清单外的工具与整屏观察被 Cua 拒绝");
	dk("exec", NAME, "cua-driver", "revoke", "--all", "--socket", "/tmp/c.sock");
	assert.match(await callText("list_apps", {}), /authorization_suspended|session has ended/);
	assert.match(await callText("start_session", {}), /authorization_suspended/, "撤销后也不能重新开会话（直到我们重启守护进程）");
	log("一键暂停（revoke --all）后所有调用被拒");
	mcp.kill();
	log("✓ 通过");
} finally {
	try {
		dk("rm", "-f", NAME);
	} catch {}
}
