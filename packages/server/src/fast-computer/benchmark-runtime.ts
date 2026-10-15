/**
 * 快速操作模型 · 基准测试的运行时接线：把「当前环境到底哪台电脑可用 + 怎么调统一 computer backend」接成 BenchmarkDriver。
 *
 * 目标选择（用户显式选择，绝不偷偷开 VM）：
 *  - `hostpc`：用户在设置 › 电脑里开启了「操作这台电脑」且 cua 守护进程在跑、未暂停；
 *  - `computer`：助理电脑正在运行；
 *  - 都没有 → availability blocked，明确提示用户去开启 / 启动。
 *
 * 能力探测（2026-10-22 用户要求「一键真实测试，不手填开关 / 网关」）：
 *  - 隔离窗口来源**不再**由用户手填 `hostIsolatedWindow` 决定，而是 `planFixtureWindow` 只凭目标 cua 的 `tools/list`
 *    推断「可准备」（hostpc 要有驱动自有隔离浏览器 `browser_prepare`/`browser_navigate`/`get_browser_state`；
 *    助理电脑要有 `launch_app` + 窗口工具 + 一个**已证实**的 guest 可达宿主别名）；
 *  - **GET availability 只报可准备，绝不开窗口**；真正的窗口生命周期在用户点「开始实际操作测试」后的 POST bootstrap 里执行；
 *  - 助理电脑的宿主别名由 `resolveComputerFixtureBaseUrl` 按桌面运行时类型推断（Docker Desktop / Lima），
 *    拿不到就 fail-closed，**绝不回退 127.0.0.1，也不把控制 API 绑到 0.0.0.0**。
 * 任一步拿不到证据一律 fail-closed，也**不写死永远 blocked**（条件满足即 ready）。
 *
 * 受限权限桥：所有 backend 调用都过 `benchmarkToolGuard`（暂停 / 只看档位），不借「没有 Pi ctx」绕过 ext-computer 的规则。
 *
 * **未验证声明**：当前开发环境未开启 hostpc、也未跑助理电脑 VM，本文件的真实运行**未在真实桌面上验证**。
 */
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
import { config } from "../config.ts";
import { cuaMcpCommand, desktopPause, runningDesktops } from "../desktop.ts";
import { hostMcpCommand, hostAllowedFor, hostPaused, hostSettings, hostStatus, tierOf } from "../host-control.ts";
import { createBenchmarkHost, type BenchmarkHost } from "./benchmark-host.ts";
import { BenchmarkFixtureStateStore } from "./benchmark-fixture.ts";
import { createInvokeBenchmarkDriver, defaultOpenTool, type ComputerInvoke, type InvokeResult } from "./benchmark-driver.ts";
import { evaluateBenchmarkCapability, type BenchmarkCapabilityResult } from "./benchmark-capability.ts";
import { benchmarkToolGuard } from "./benchmark-guard.ts";
import { planFixtureWindow, type FixtureWindowKind } from "./benchmark-window.ts";
import { resolveComputerFixtureBaseUrl, type DesktopRuntimeKind } from "./benchmark-gateway.ts";

export interface RuntimeBenchmarkOptions {
	/** 助理 id（computer 目标 / hostpc 授权都要它来决定连哪个后端）。 */
	agentId: () => string | null;
	/** hostpc 目标里 fixture 页面的可达基址（默认本机 http://127.0.0.1:PORT）。 */
	hostFixtureBaseUrl?: () => string;
	/**
	 * 助理电脑（VM）可达的宿主 fixture 网关基址（受控别名 / 反向代理），例如 `http://host.docker.internal:PORT`。
	 * 不传则按桌面运行时类型自动推断；推断不出 → 助理电脑目标明确不可准备（fail-closed）。
	 */
	computerFixtureBaseUrl?: () => string | null;
	/** 桌面运行时类型（docker / lima / wsl）；不传时从 `runningDesktops()` 推断，拿不到按 unknown（fail-closed）。 */
	desktopKind?: () => DesktopRuntimeKind;
	/** 打开 fixture 页面用的工具名；默认 cua 原生 `launch_app`（沙箱路径）。 */
	openTool?: string;
	/** 目标探测刷新间隔（ms）。 */
	refreshMs?: number;
}

interface TargetCache {
	computer: boolean;
	hostpc: boolean;
	computerKind: FixtureWindowKind | null;
	hostpcKind: FixtureWindowKind | null;
	capability: { computer: BenchmarkCapabilityResult; hostpc: BenchmarkCapabilityResult };
}

/** 构造真实运行时宿主。 */
export function createRuntimeBenchmarkHost(opts: RuntimeBenchmarkOptions): { host: BenchmarkHost; store: BenchmarkFixtureStateStore; refresh: () => Promise<TargetCache> } {
	const store = new BenchmarkFixtureStateStore();
	const cache: TargetCache = { computer: false, hostpc: false, computerKind: null, hostpcKind: null, capability: { computer: { ok: false }, hostpc: { ok: false } } };
	const hostBase = opts.hostFixtureBaseUrl ?? (() => `http://127.0.0.1:${config.port}`);
	const openTool = opts.openTool ?? defaultOpenTool;

	/** 助理电脑的宿主别名：外部显式给优先；否则按运行时类型推断（fail-closed）。 */
	const computerBase = (): string | null => {
		const explicit = opts.computerFixtureBaseUrl?.();
		if (explicit) return explicit;
		const kind = opts.desktopKind?.() ?? "unknown";
		return resolveComputerFixtureBaseUrl({ port: config.port, kind });
	};

	const targetOf = (requested?: "hostpc" | "computer") => {
		if (requested === "hostpc") return cache.hostpc ? { prefix: "hostpc" as const } : null;
		if (requested === "computer") return cache.computer ? { prefix: "computer" as const } : null;
		if (cache.computer) return { prefix: "computer" as const };
		if (cache.hostpc) return { prefix: "hostpc" as const };
		return null;
	};

	const { invoke, listTools } = createMcpInvoke(opts.agentId);

	// 受限权限桥：hostpc 看一键暂停 + 档位；助理电脑看桌面暂停。绝不 always-allow。
	const guard = (input: { prefix: "hostpc" | "computer"; tool: string }) =>
		benchmarkToolGuard({ ...input, paused: input.prefix === "hostpc" ? hostPaused() : desktopPause.isPaused(opts.agentId() ?? ""), ...(input.prefix === "hostpc" ? { tier: tierOf(opts.agentId() ?? "") } : {}) });

	// 单一目标的无副作用能力探测（只 tools/list，不开窗）。
	const probe = async (prefix: "hostpc" | "computer"): Promise<{ cap: BenchmarkCapabilityResult; plan: ReturnType<typeof planFixtureWindow> }> => {
		if (prefix === "hostpc" && hostPaused()) return { cap: { ok: false, reason: "「操作这台电脑」已暂停：先恢复再跑基准。" }, plan: { ok: false } };
		const ready = prefix === "computer" ? cache.computer : cache.hostpc;
		if (!ready) return { cap: { ok: false, reason: "目标电脑未就绪（「操作这台电脑」未开启 / 助理电脑未运行）" }, plan: { ok: false } };
		const tools = await listTools(prefix);
		if (prefix === "computer") {
			const base = computerBase();
			const plan = planFixtureWindow({ prefix, tools, openTool, gateway: { ok: !!base, reason: "助理电脑没有已证实的宿主 fixture 别名（不把 Pi 控制 API 暴露到 0.0.0.0）" } });
			return { cap: evaluateBenchmarkCapability({ ready, tools, openTool, window: plan }), plan };
		}
		const plan = planFixtureWindow({ prefix, tools, openTool });
		return { cap: evaluateBenchmarkCapability({ ready, tools, openTool, window: plan }), plan };
	};

	const driver = createInvokeBenchmarkDriver({
		target: targetOf,
		invoke,
		guard,
		windowKindOf: (prefix) => (prefix === "computer" ? cache.computerKind : cache.hostpcKind),
		fixtureUrl: (path, prefix) => {
			if (prefix === "hostpc") return `${hostBase()}${path}`;
			const base = computerBase();
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
		const id = opts.agentId();
		// 「操作这台电脑」：全局开启 + 允许这个助理 + 守护进程在跑（暂停时 probe 会给明确原因）。
		cache.hostpc = hostSettings().enabled && !!id && hostAllowedFor(id) && hostStatus().daemon.state === "running";
		try {
			cache.computer = (await runningDesktops()).length > 0;
		} catch {
			cache.computer = false;
		}
		const pComputer = await probe("computer");
		const pHostpc = await probe("hostpc");
		cache.capability = { computer: pComputer.cap, hostpc: pHostpc.cap };
		cache.computerKind = pComputer.plan.ok ? (pComputer.plan.kind ?? null) : null;
		cache.hostpcKind = pHostpc.plan.ok ? (pHostpc.plan.kind ?? null) : null;
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
