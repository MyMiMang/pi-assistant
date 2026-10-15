/**
 * 快速操作模型 · 基准测试的运行时接线：把「当前环境到底哪台电脑可用 + 怎么调统一 computer backend」接成 BenchmarkDriver。
 *
 * 目标选择（用户显式选择，绝不偷偷开 VM）：
 *  - `hostpc`：用户在设置 › 电脑里开启了「操作这台电脑」且 cua 守护进程在跑；
 *  - `computer`：助理电脑正在运行；
 *  - 都没有 → availability blocked，明确提示用户去开启 / 启动。
 *
 * `invoke` 走 cua 的 MCP（hostpc = hostMcpCommand，computer = cuaMcpCommand），动作仍受 cua 自身权限与保护。
 *
 * **未验证声明**：当前开发环境未开启 hostpc、也未跑助理电脑 VM，本文件的真实运行**未在真实桌面上验证**。
 * 拿不到独立受控窗口证明的平台一律 `capable:false` → availability blocked（不假装 ready）。
 */
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
import { config } from "../config.ts";
import { cuaMcpCommand, runningDesktops } from "../desktop.ts";
import { hostMcpCommand, hostSettings, hostStatus } from "../host-control.ts";
import { createBenchmarkHost, type BenchmarkHost } from "./benchmark-host.ts";
import { BenchmarkFixtureStateStore } from "./benchmark-fixture.ts";
import { createInvokeBenchmarkDriver, type ComputerInvoke, type InvokeResult } from "./benchmark-driver.ts";

export interface RuntimeBenchmarkOptions {
	/** 助理 id（computer 目标 / hostpc 授权都要它来决定连哪个后端）。 */
	agentId: () => string | null;
	/** fixture 页面在目标电脑里的可达基址（默认本机 http://127.0.0.1:PORT）。 */
	fixtureBaseUrl?: () => string;
	/** 打开 fixture 页面用的工具名；默认 `browser_navigate`。平台没有该能力时 driver.capable() 会 false。 */
	openTool?: string;
	/** 目标探测刷新间隔（ms）。 */
	refreshMs?: number;
}

interface TargetCache {
	computer: boolean;
	hostpc: boolean;
}

/** 构造真实运行时宿主。 */
export function createRuntimeBenchmarkHost(opts: RuntimeBenchmarkOptions): { host: BenchmarkHost; store: BenchmarkFixtureStateStore; refresh: () => Promise<TargetCache> } {
	const store = new BenchmarkFixtureStateStore();
	const cache: TargetCache = { computer: false, hostpc: false };
	const base = opts.fixtureBaseUrl ?? (() => `http://127.0.0.1:${config.port}`);

	const targetOf = (requested?: "hostpc" | "computer") => {
		if (requested === "hostpc") return cache.hostpc ? { prefix: "hostpc" as const } : null;
		if (requested === "computer") return cache.computer ? { prefix: "computer" as const } : null;
		if (cache.computer) return { prefix: "computer" as const };
		if (cache.hostpc) return { prefix: "hostpc" as const };
		return null;
	};

	const invoke = createMcpInvoke(opts.agentId);

	const driver = createInvokeBenchmarkDriver({
		target: targetOf,
		invoke,
		fixtureUrl: (path) => `${base()}${path}`,
		openTool: opts.openTool,
		capable: () => ({ ok: true }),
	});

	const host = createBenchmarkHost({
		driver,
		store,
		notReadyReason: "真实操控基准需要先在设置 › 电脑里开启「操作这台电脑」或启动助理电脑；当前都没就绪。",
	});

	const refresh = async (): Promise<TargetCache> => {
		cache.hostpc = hostSettings().enabled && hostStatus().daemon.state === "running";
		try {
			cache.computer = (await runningDesktops()).length > 0;
		} catch {
			cache.computer = false;
		}
		return { ...cache };
	};
	void refresh();
	if (opts.refreshMs !== 0) {
		const timer = setInterval(() => void refresh(), opts.refreshMs ?? 3000);
		timer.unref?.();
	}
	return { host, store, refresh };
}

/** 用 cua 的 MCP 构造统一 backend 调用（每个目标一个 lazy 连接）。 */
export function createMcpInvoke(agentId: () => string | null): ComputerInvoke {
	const clients = new Map<string, McpClient>();
	const connect = async (prefix: "hostpc" | "computer"): Promise<McpClient> => {
		const existing = clients.get(prefix);
		if (existing) return existing;
		const id = agentId();
		if (!id) throw new Error("没有可用的助理实例，无法连接电脑后端");
		const cmd = prefix === "hostpc" ? hostMcpCommand(id) : cuaMcpCommand(id);
		const client = new McpClient({ name: "pi-assistant-benchmark", version: "1.0.0", requestTimeoutMs: 20_000 });
		await client.connect(new StdioTransport({ command: cmd.command, args: cmd.args, stderr: "pipe", onStderr: () => {} }));
		clients.set(prefix, client);
		return client;
	};
	return async (prefix, tool, args): Promise<InvokeResult> => {
		try {
			const client = await connect(prefix);
			const r = await client.callTool(tool, args);
			return { isError: !!r.isError, structuredContent: r.structuredContent, contentText: textOf(r.content) };
		} catch (e) {
			return { isError: true, contentText: e instanceof Error ? e.message : String(e) };
		}
	};
}

const textOf = (content: unknown): string =>
	(Array.isArray(content) ? content : [])
		.filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
		.map((c) => String((c as { text?: string }).text ?? ""))
		.join("\n");
