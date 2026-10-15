/**
 * 快速操作模型 · 基准测试的运行时接线：把「当前环境到底哪台电脑可用 + 怎么调统一 computer backend」接成 BenchmarkDriver。
 *
 * 目标选择（用户显式选择，绝不偷偷开 VM）：
 *  - `hostpc`：用户在设置 › 电脑里开启了「操作这台电脑」且 cua 守护进程在跑；
 *  - `computer`：助理电脑正在运行；
 *  - 都没有 → availability blocked，明确提示用户去开启 / 启动。
 *
 * 能力探测（2026-10-22 复核后的方向）：`capable` **不再硬编码 true**。刷新时对默认目标做一次**无副作用**探测：
 *  1. 目标是否就绪（hostpc 已开且守护进程在跑 / 助理电脑正在运行）；
 *  2. 目标 cua MCP 是否暴露基准所需工具（`launch_app` / `list_windows` / `get_window_state` / `click` / `scroll`）——
 *     连接后 `tools/list`，不打开任何窗口；
 *  3. 是否有一个与日常环境隔离的测试窗口：助理电脑（VM）天然隔离；用户电脑需要「隔离的驱动自有窗口」，
 *     **不能拿用户日常 Chrome 当 sandbox**；
 *  4. 助理电脑还需要宿主可达的受控网关地址来加载 fixture 与接收回调；未提供 → 明确 blocked，不回退 127.0.0.1。
 * 任一步拿不到证据一律 fail-closed，也**不写死永远 blocked**（条件满足即 ready）。
 *
 * `invoke` 走 cua 的 MCP（hostpc = hostMcpCommand，computer = cuaMcpCommand），动作仍受 cua 自身权限与保护。
 *
 * **未验证声明**：当前开发环境未开启 hostpc、也未跑助理电脑 VM，本文件的真实运行**未在真实桌面上验证**。
 */
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
import { config } from "../config.ts";
import { cuaMcpCommand, runningDesktops } from "../desktop.ts";
import { hostMcpCommand, hostSettings, hostStatus } from "../host-control.ts";
import { createBenchmarkHost, type BenchmarkHost } from "./benchmark-host.ts";
import { BenchmarkFixtureStateStore } from "./benchmark-fixture.ts";
import { createInvokeBenchmarkDriver, defaultOpenTool, type ComputerInvoke, type InvokeResult } from "./benchmark-driver.ts";
import { evaluateBenchmarkCapability, type BenchmarkCapabilityResult } from "./benchmark-capability.ts";

export interface RuntimeBenchmarkOptions {
	/** 助理 id（computer 目标 / hostpc 授权都要它来决定连哪个后端）。 */
	agentId: () => string | null;
	/** hostpc 目标里 fixture 页面的可达基址（默认本机 http://127.0.0.1:PORT）。 */
	hostFixtureBaseUrl?: () => string;
	/**
	 * 助理电脑（VM）可达的宿主 fixture 网关基址（受控 loopback 映射 / 反向代理），例如 `http://host.docker.internal:PORT`。
	 * 未配置 → 助理电脑目标 unsupported（fail-closed），绝不回退成 VM 里的 127.0.0.1。
	 */
	computerFixtureBaseUrl?: () => string | null;
	/** 用户电脑是否提供隔离的、驱动自有测试窗口（不使用用户的日常浏览器 profile）。默认 false。 */
	hostIsolatedWindow?: () => { ok: boolean; reason?: string };
	/** 打开 fixture 页面用的工具名；默认 cua 原生 `launch_app`。平台没有该能力时 capability 会 false。 */
	openTool?: string;
	/** 目标探测刷新间隔（ms）。 */
	refreshMs?: number;
}

interface TargetCache {
	computer: boolean;
	hostpc: boolean;
	capability: { computer: BenchmarkCapabilityResult; hostpc: BenchmarkCapabilityResult };
}

/** 构造真实运行时宿主。 */
export function createRuntimeBenchmarkHost(opts: RuntimeBenchmarkOptions): { host: BenchmarkHost; store: BenchmarkFixtureStateStore; refresh: () => Promise<TargetCache> } {
	const store = new BenchmarkFixtureStateStore();
	const cache: TargetCache = { computer: false, hostpc: false, capability: { computer: { ok: false }, hostpc: { ok: false } } };
	const hostBase = opts.hostFixtureBaseUrl ?? (() => `http://127.0.0.1:${config.port}`);
	const openTool = opts.openTool ?? defaultOpenTool;

	const targetOf = (requested?: "hostpc" | "computer") => {
		if (requested === "hostpc") return cache.hostpc ? { prefix: "hostpc" as const } : null;
		if (requested === "computer") return cache.computer ? { prefix: "computer" as const } : null;
		if (cache.computer) return { prefix: "computer" as const };
		if (cache.hostpc) return { prefix: "hostpc" as const };
		return null;
	};

	const { invoke, listTools } = createMcpInvoke(opts.agentId);

	// 单一目标的无副作用能力探测（只 tools/list，不开窗）。
	const probe = async (prefix: "hostpc" | "computer"): Promise<BenchmarkCapabilityResult> => {
		const ready = prefix === "computer" ? cache.computer : cache.hostpc;
		if (!ready) return { ok: false, reason: "目标电脑未就绪（「操作这台电脑」未开启 / 助理电脑未运行）" };
		const tools = await listTools(prefix);
		if (prefix === "computer") {
			const base = opts.computerFixtureBaseUrl?.() ?? null;
			return evaluateBenchmarkCapability({ ready, tools, openTool, sandbox: true, gateway: { ok: !!base, reason: "助理电脑没有安全可达的宿主 fixture 网关（不把 Pi 控制 API 暴露到 0.0.0.0）" } });
		}
		const isolated = opts.hostIsolatedWindow?.() ?? { ok: false, reason: "用户电脑没有隔离的基准测试窗口（不使用你的日常浏览器 profile）" };
		return evaluateBenchmarkCapability({ ready, tools, openTool, sandbox: isolated.ok, sandboxReason: isolated.reason });
	};

	const driver = createInvokeBenchmarkDriver({
		target: targetOf,
		invoke,
		fixtureUrl: (path, prefix) => {
			if (prefix === "hostpc") return `${hostBase()}${path}`;
			const base = opts.computerFixtureBaseUrl?.() ?? null;
			return base ? `${base.replace(/\/$/, "")}${path}` : null;
		},
		capable: () => {
			const sel = targetOf();
			if (sel?.prefix === "computer") return cache.capability.computer;
			if (sel?.prefix === "hostpc") return cache.capability.hostpc;
			return { ok: false, reason: "没有可用的真实电脑通道：请先在设置 › 电脑里开启「操作这台电脑」，或启动助理电脑。" };
		},
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
		cache.capability = { computer: await probe("computer"), hostpc: await probe("hostpc") };
		return { ...cache };
	};
	void refresh();
	if (opts.refreshMs !== 0) {
		const timer = setInterval(() => void refresh(), opts.refreshMs ?? 3000);
		timer.unref?.();
	}
	return { host, store, refresh };
}

/** 用 cua 的 MCP 构造统一 backend 调用（每个目标一个 lazy 连接）+ 无副作用的能力清单读取。 */
export function createMcpInvoke(agentId: () => string | null): { invoke: ComputerInvoke; listTools: (prefix: "hostpc" | "computer") => Promise<string[] | null> } {
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
	const invoke: ComputerInvoke = async (prefix, tool, args): Promise<InvokeResult> => {
		try {
			const client = await connect(prefix);
			const r = await client.callTool(tool, args);
			return { isError: !!r.isError, structuredContent: r.structuredContent, contentText: textOf(r.content) };
		} catch (e) {
			return { isError: true, contentText: e instanceof Error ? e.message : String(e) };
		}
	};
	// 只读 tools/list：证明目标暴露了基准所需能力，无任何副作用。
	const listTools = async (prefix: "hostpc" | "computer"): Promise<string[] | null> => {
		try {
			const client = await connect(prefix);
			const tools = await client.listTools();
			return tools.map((t) => t.name);
		} catch {
			return null;
		}
	};
	return { invoke, listTools };
}

const textOf = (content: unknown): string =>
	(Array.isArray(content) ? content : [])
		.filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
		.map((c) => String((c as { text?: string }).text ?? ""))
		.join("\n");
