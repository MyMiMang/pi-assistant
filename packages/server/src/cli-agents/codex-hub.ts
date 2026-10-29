/**
 * 全局唯一的 `codex app-server` 进程（方案 docs/design/cli-models.md §5.2「审查定稿」）：
 * 按需启动、所有线程空闲 10 分钟后退出、崩溃后下次请求重启（线程由调用方 `thread/resume`）。
 *
 * 启动时先起一个探测进程 `config/read` 取用户配置里的 MCP 名字（不调模型），有名字就带上逐个 `enabled=false` 重启再用；
 * 名字取一次就记住，之后重启直接带上。通知 / 服务端请求按 `threadId` 分发给各线程登记的 `ThreadSink`；
 * 不认识的服务端请求（审批、提问等）统一拒绝，不让 Codex 卡住。
 */
import { RpcClient, type RpcExit } from "./jsonrpc-stdio.ts";
import { answerServerRequest } from "./codex-events.ts";
import { buildCodexArgs, buildCodexEnv } from "./codex-launch.ts";
import { findCodexCommand } from "./detect.ts";

/** 某个线程的接收方：只会收到属于自己 threadId 的消息 */
export interface ThreadSink {
	notification(method: string, params: unknown): void;
	/** `item/tool/call` 等需要我们回包的请求；用 `hub.respond(id, …)` 回 */
	request(id: number | string, method: string, params: unknown): void;
	/** app-server 进程没了（崩溃 / 被关）；这个线程里进行中的一轮就此中断 */
	exit(exit: RpcExit): void;
}

export interface CodexModelInfo {
	id: string;
	name: string;
	isDefault: boolean;
	/** 这个模型支持的思考强度（Codex 的原值：low / medium / high / xhigh / max / ultra …） */
	efforts: string[];
	image: boolean;
}

export interface CodexHubOptions {
	/** codex 可执行文件；不给就自己找。测试用它换成假 codex */
	command?: () => string | null;
	/** 进程工作目录（动态工具的纯大脑用不到，给个固定的空目录） */
	cwd: () => string;
	baseEnv?: NodeJS.ProcessEnv;
	/** 额外环境变量（测试选假 codex 场景用） */
	extraEnv?: () => Record<string, string>;
	/** 空闲多久退出（毫秒），默认 10 分钟 */
	idleMs?: number;
}

const INIT_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_MS = 10 * 60 * 1000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class CodexHub {
	private client: RpcClient | undefined;
	private starting: Promise<RpcClient> | undefined;
	private mcp: string[] | undefined;
	private readonly sinks = new Map<string, ThreadSink>();
	private readonly active = new Set<string>();
	private readonly loaded = new Set<string>();
	private idleTimer: NodeJS.Timeout | undefined;
	private disposed = false;

	constructor(private readonly opts: CodexHubOptions) {}

	/** 被我们关掉的用户 MCP 名字（探测之后才有）；测试看 */
	get disabledMcpNames(): string[] {
		return [...(this.mcp ?? [])];
	}

	get running(): boolean {
		return !!this.client?.alive;
	}

	get pid(): number | undefined {
		return this.client?.pid;
	}

	private spawnClient(mcpNames: string[]): RpcClient {
		const command = (this.opts.command ?? (() => findCodexCommand()))();
		if (!command) throw new Error("没有找到 codex 命令。请先按 Codex 官方说明安装，再在终端运行 codex login 登录。");
		const holder: { c?: RpcClient } = {};
		const c = new RpcClient({
			label: "codex",
			command,
			args: buildCodexArgs(mcpNames),
			cwd: this.opts.cwd(),
			env: buildCodexEnv({ baseEnv: this.opts.baseEnv, command, extra: this.opts.extraEnv?.() }),
			onNotification: (method, params) => {
				if (holder.c !== this.client) return;
				const id = isObj(params) && typeof params.threadId === "string" ? params.threadId : "";
				this.sinks.get(id)?.notification(method, params);
			},
			onRequest: (id, method, params) => {
				const tid = isObj(params) && typeof params.threadId === "string" ? params.threadId : "";
				const sink = this.sinks.get(tid);
				if (method === "item/tool/call" && sink && holder.c === this.client) return sink.request(id, method, params);
				if (method === "item/tool/call") return void holder.c?.respond(id, { success: false, contentItems: [{ type: "inputText", text: "这次工具调用已经不在了" }] });
				const a = answerServerRequest(method);
				if ("error" in a) holder.c?.respondError(id, a.error);
				else holder.c?.respond(id, a.result);
			},
			onExit: (exit) => {
				if (holder.c !== this.client) return; // 探测进程是我们自己换掉的，不算崩溃
				this.client = undefined;
				this.loaded.clear();
				this.clearIdle();
				for (const sink of [...this.sinks.values()]) sink.exit(exit);
			},
		});
		holder.c = c;
		this.client = c;
		c.start();
		return c;
	}

	private async handshake(c: RpcClient): Promise<void> {
		await c.request("initialize", { clientInfo: { name: "pi-assistant", title: "Pi Assistant", version: "0" }, capabilities: { experimentalApi: true } }, INIT_TIMEOUT_MS);
		c.notify("initialized", {});
	}

	/** 用户配置里的 MCP 名字：`config/read` 的 `config.mcp_servers` 的键；读不到再退而问 `mcpServerStatus/list`。 */
	private async readMcpNames(c: RpcClient): Promise<string[]> {
		try {
			const r = await c.request<{ config?: { mcp_servers?: unknown } }>("config/read", { includeLayers: false }, INIT_TIMEOUT_MS);
			const m = r?.config?.mcp_servers;
			return isObj(m) ? Object.keys(m) : [];
		} catch {
			const r = await c.request<{ data?: Array<{ name?: unknown }> }>("mcpServerStatus/list", { detail: "toolsAndAuthOnly" }, INIT_TIMEOUT_MS);
			return (r?.data ?? []).map((x) => (typeof x.name === "string" ? x.name : "")).filter(Boolean);
		}
	}

	private async startProcess(): Promise<RpcClient> {
		this.loaded.clear(); // 新进程里没有加载过任何线程
		if (this.mcp) {
			const c = this.spawnClient(this.mcp);
			await this.handshake(c);
			return c;
		}
		let c = this.spawnClient([]);
		try {
			await this.handshake(c);
			const names = await this.readMcpNames(c);
			if (names.length) {
				// 有用户 MCP：换成逐个关掉它们的进程（`-c mcp_servers={}` 清不掉，只能按名字关）
				const old = c;
				this.client = undefined; // 先摘掉：探测进程是我们自己关的，它的退出不能当成崩溃通知各线程
				old.close();
				await old.exitedPromise;
				c = this.spawnClient(names);
				await this.handshake(c);
			}
			this.mcp = names;
			return c;
		} catch (e) {
			c.close();
			if (this.client === c) this.client = undefined;
			throw e;
		}
	}

	/** 确保进程在跑（单飞）。 */
	async ensure(): Promise<RpcClient> {
		if (this.disposed) throw new Error("Codex 渠道已关闭");
		if (this.client?.alive && !this.starting) return this.client;
		this.starting ??= this.startProcess().then(
			(c) => {
				this.starting = undefined;
				this.scheduleIdle();
				return c;
			},
			(e) => {
				this.starting = undefined;
				throw e;
			},
		);
		return this.starting;
	}

	async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
		const c = await this.ensure();
		return c.request<T>(method, params, timeoutMs);
	}

	respond(id: number | string, result: unknown): void {
		this.client?.respond(id, result);
	}

	/** 登记 / 取消登记一个线程的接收方（线程进行中一轮时登记，结束后取消） */
	subscribe(threadId: string, sink: ThreadSink): () => void {
		this.sinks.set(threadId, sink);
		return () => {
			if (this.sinks.get(threadId) === sink) this.sinks.delete(threadId);
		};
	}

	/** 线程有一轮在进行（含挂着等工具结果）就不能空闲退出 */
	setActive(threadId: string, active: boolean): void {
		if (active) {
			this.active.add(threadId);
			this.clearIdle();
		} else {
			this.active.delete(threadId);
			this.scheduleIdle();
		}
	}

	/** 这个线程在当前进程里已加载（不必再 `thread/resume`）；进程重启后自动清空 */
	isLoaded(threadId: string): boolean {
		return this.loaded.has(threadId);
	}

	markLoaded(threadId: string): void {
		this.loaded.add(threadId);
	}

	private clearIdle(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	private scheduleIdle(): void {
		this.clearIdle();
		if (this.active.size || !this.client?.alive) return;
		this.idleTimer = setTimeout(() => {
			if (!this.active.size) this.client?.close();
		}, this.opts.idleMs ?? DEFAULT_IDLE_MS);
		this.idleTimer.unref();
	}

	/** 模型列表（`model/list`，隐藏的不要）。只问列表，不发模型请求。 */
	async listModels(): Promise<CodexModelInfo[]> {
		const out: CodexModelInfo[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < 10; page++) {
			const r: { data?: unknown[]; nextCursor?: string | null } = await this.request("model/list", cursor ? { cursor } : {});
			for (const m of r.data ?? []) {
				if (!isObj(m) || m.hidden === true || typeof m.id !== "string") continue;
				const efforts = (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : []).map((e) => (isObj(e) ? e.reasoningEffort : e)).filter((e): e is string => typeof e === "string");
				const modalities = Array.isArray(m.inputModalities) ? m.inputModalities : [];
				out.push({ id: m.id, name: typeof m.displayName === "string" && m.displayName ? m.displayName : m.id, isDefault: m.isDefault === true, efforts, image: modalities.includes("image") });
			}
			cursor = r.nextCursor ?? null;
			if (!cursor) break;
		}
		return out;
	}

	/** 服务关闭 / 测试收尾：关进程，之后不再启动。 */
	dispose(): void {
		this.disposed = true;
		this.clearIdle();
		this.sinks.clear();
		this.client?.close();
	}

	/** 没有进行中的一轮就关进程（只为问模型列表起的进程用完即关） */
	stopIfIdle(): void {
		if (!this.active.size && !this.starting) this.stop();
	}

	/** 重新检测时调：忘掉记住的 MCP 名字（用户可能新加了 MCP），空闲就关进程，下次启动重新探测 */
	reprobe(): void {
		this.mcp = undefined;
		this.stopIfIdle();
	}

	/** 只关进程不禁用（重新检测后要换配置时用）；下次请求会重启 */
	stop(): void {
		this.loaded.clear();
		this.clearIdle();
		this.client?.close();
	}
}
