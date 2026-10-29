/**
 * 一个长驻的 ACP 命令行进程（OpenCode 等；每个 Pi 会话一个，方案 docs/design/acp-cli-models.md）。
 *
 * 流程：起进程 → `initialize` → `session/new`（或 `session/resume` 续接）带 http 类型 `mcpServers` 指向工具桥（随机令牌放 Authorization 头）
 * → `session/set_config_option` 设模型 / 思考强度 → `session/prompt`（回包才算一轮结束）。JSON-RPC 读写复用 `jsonrpc-stdio.ts`。
 * 命令行自己的 `session/request_permission` 一律回「允许一次」：审批已经在 Pi 那边做过（它的权限规则也只放行我们的工具）。
 * 停止 = `session/cancel`（实测约 0.3 秒），再过一会儿关进程；空闲 10 分钟退出；运行目录（里面是带系统提示的配置文件，0700 / 0600）结束一定删，令牌和系统提示都不进命令行。
 *
 * **工具调用只认工具桥收到的 MCP `tools/call`**（工具名 + 参数）：ACP 的 `tool_call` 通知没有能和 MCP 请求配对的 id，并行时两边顺序也不一致（实测）。
 * 桥的配对键 = MCP 请求 id（`rpc-<id>`）。并行收齐：收到第一个 `tools/call` 后，等到「桥收到的数量 ≥ ACP 报告的我们的工具数」且安静了 `settleMs`，
 * 最多等 `collectMs`（300 毫秒，没有依据，要调就调这里）再发一个 `tools_ready`。
 * 本类不碰 Pi；Pi 渠道（`pi-adapter/cli-models/acp.ts`）拿它的条目去拼 Pi 的流。
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acpUsageOf, configValues, convertAcpUpdate, pickAllowOption, pickEffort, type AcpEvent } from "./acp-events.ts";
import type { TokenUsage } from "./events.ts";
import { RpcClient, type RpcExit } from "./jsonrpc-stdio.ts";
import { toolBridge, type BridgeCall, type BridgeRun, type CallToolResult, type Tool, type ToolBridge } from "./tool-bridge.ts";

/** 收到第一个 `tools/call` 后最多等多久收齐并行调用 */
export const ACP_PARALLEL_WAIT_MS = 300;
/** 桥收到的数量已经不少于 ACP 报告的数量后，再安静多久才算收齐（ACP 报告第二个工具比第一个的 MCP 请求还晚几十毫秒，实测） */
export const ACP_SETTLE_MS = 50;
/** 空闲多久退出 */
export const ACP_IDLE_MS = 10 * 60_000;
/** 取消后等多久再关进程（让它体面收尾） */
const ABORT_GRACE_MS = 1500;
/** 握手阶段每个请求的超时 */
const HANDSHAKE_TIMEOUT_MS = 60_000;

export interface AcpRunFile {
	/** 相对运行目录的路径 */
	path: string;
	content: string;
	/** 文件权限；含系统提示的都是 0600 */
	mode: number;
}

/** 每家命令行的启动方式（纯数据 / 纯函数，实例见 `opencode-launch.ts`） */
export interface AcpProfile {
	/** 报错里的名字，如 `OpenCode` */
	label: string;
	/** 我们的工具在 ACP `tool_call` 标题里的前缀，如 `pia_` */
	toolPrefix: string;
	/** 命令行参数（`workDir` = 固定工作目录） */
	args(workDir: string): string[];
	/** 白名单环境；`runDir` = 运行目录（配置文件在里面） */
	env(input: { baseEnv?: NodeJS.ProcessEnv; command: string; dataDir: string; runDir: string; extra?: Record<string, string> }): NodeJS.ProcessEnv;
	/** 要写进运行目录的文件（系统提示等；进程级配置） */
	runFiles(input: { systemPrompt: string | undefined }): AcpRunFile[];
	/** `session/new` 的 `mcpServers`（工具桥） */
	mcpServers(url: string, token: string): unknown[];
}

/** 交给上层的条目：文字 / 思考增量、工具桥收到的调用、「调用收齐了」、一轮的结果 */
export type AcpItem =
	| Extract<AcpEvent, { type: "text_delta" | "thinking_delta" }>
	/** `id` 是交给 Pi 的 toolCall id（带进程随机前缀，跨进程不重复）；`key` 是工具桥配对键 */
	| { type: "tool_call"; id: string; key: string; name: string; args: Record<string, unknown> }
	| { type: "tools_ready" }
	/** 一轮结束：`session/prompt` 的回包（或握手 / 提示出错）。`usage` 只是**最后一次模型调用**的 */
	| { type: "result"; stopReason: string; isError: boolean; text: string; usage: TokenUsage; sessionId: string };

export interface AcpExit extends RpcExit {
	/** 是我们主动中止的（abort） */
	aborted: boolean;
	/** 是空闲到时自己退的 */
	idle: boolean;
}

export interface AcpProcessOptions {
	profile: AcpProfile;
	command: string;
	/** 运行目录的父目录，不存在会建 */
	runsRoot: string;
	/** 固定的工作目录（会话续接要在同一个目录里），不存在会建 */
	workDir: string;
	/** 数据目录（隔离的配置目录在它下面） */
	dataDir: string;
	/** 工具桥地址前缀，如 `http://127.0.0.1:8787` */
	bridgeBaseUrl: string;
	tools: Tool[];
	systemPrompt?: string;
	/** 续用的会话 id（`session/resume`） */
	sessionId?: string;
	collectMs?: number;
	settleMs?: number;
	idleMs?: number;
	baseEnv?: NodeJS.ProcessEnv;
	extraEnv?: Record<string, string>;
	/** 测试可换成独立的工具桥登记表 */
	bridge?: ToolBridge;
}

/** 当前这一轮的接收方：每个条目 + 进程退出 */
export interface AcpSink {
	onItem(item: AcpItem): void;
	onExit(exit: AcpExit): void;
}

const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class AcpProcess {
	readonly bridgeRun: BridgeRun;
	/** 进程结束（运行目录已删）后 resolve；不会 reject */
	readonly done: Promise<AcpExit>;
	/** 会话 id：续用时一开始就有，新开的从 `session/new` 得到 */
	sessionId: string | undefined;
	private client: RpcClient | undefined;
	private dir: string | undefined;
	private sink: AcpSink | undefined;
	private ready: Promise<void> = Promise.resolve();
	private aborted = false;
	private idleExit = false;
	private exited = false;
	/** 握手失败（已经报过错），不再发提示 */
	private startFailed = false;
	private promptRunning = false;
	private maxTimer: NodeJS.Timeout | undefined;
	private settleTimer: NodeJS.Timeout | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	private resolveDone!: (e: AcpExit) => void;
	/** 命令行当前的模型 / 思考强度，以及这个模型能选的思考强度 */
	private cur: { model?: string; effort?: string; efforts: string[] } = { efforts: [] };
	/** 这一轮：模型报告的我们的工具数 / 桥收到的调用数；这一批并行调用是否正在收齐 */
	private turn = { acpIds: new Set<string>(), acp: 0, bridge: 0, collecting: false };

	constructor(private readonly opts: AcpProcessOptions) {
		this.sessionId = opts.sessionId;
		this.bridgeRun = (opts.bridge ?? toolBridge).register({ tools: opts.tools, callKey: () => undefined, onCall: (c) => this.onBridgeCall(c) });
		this.done = new Promise((resolve) => {
			this.resolveDone = resolve;
		});
	}

	/** 运行目录（运行期间存在，结束后删除）；测试用 */
	get runDir(): string | undefined {
		return this.dir;
	}

	get pid(): number | undefined {
		return this.client?.pid;
	}

	/** 进程已经结束（或正在被中止），不能再用 */
	get dead(): boolean {
		return this.exited || this.aborted || (!!this.client && !this.client.alive);
	}

	/** 这一轮有接收方（还没 `detach`） */
	get busy(): boolean {
		return !!this.sink;
	}

	private cleanup(): void {
		if (this.dir) rmSync(this.dir, { recursive: true, force: true });
		this.dir = undefined;
	}

	/** 启动进程并在后台握手。只能调一次。 */
	start(): void {
		if (this.client) throw new Error("AcpProcess 已经启动过");
		const o = this.opts;
		try {
			mkdirSync(o.runsRoot, { recursive: true, mode: 0o700 });
			mkdirSync(o.workDir, { recursive: true, mode: 0o700 });
			const dir = mkdtempSync(join(o.runsRoot, "run-"));
			this.dir = dir;
			chmodSync(dir, 0o700);
			for (const f of o.profile.runFiles({ systemPrompt: o.systemPrompt })) {
				const full = join(dir, f.path);
				mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
				writeFileSync(full, f.content, { mode: f.mode });
			}
			this.client = new RpcClient({
				label: o.profile.label,
				command: o.command,
				args: o.profile.args(o.workDir),
				cwd: o.workDir,
				env: o.profile.env({ baseEnv: o.baseEnv, command: o.command, dataDir: o.dataDir, runDir: dir, extra: o.extraEnv }),
				onNotification: (method, params) => this.onNotification(method, params),
				onRequest: (id, method, params) => this.onServerRequest(id, method, params),
				onExit: (exit) => this.onExit(exit),
			});
			this.client.start();
		} catch (e) {
			this.cleanup();
			this.bridgeRun.close();
			throw e;
		}
		this.ready = this.handshake().catch((e) => {
			this.startFailed = true;
			this.deliverResult(true, e instanceof Error ? e.message : String(e), "error");
		});
	}

	private async handshake(): Promise<void> {
		const c = this.client!;
		await c.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, HANDSHAKE_TIMEOUT_MS);
		const mcpServers = this.opts.profile.mcpServers(`${this.opts.bridgeBaseUrl.replace(/\/+$/, "")}/internal/tool-bridge/${this.bridgeRun.id}`, this.bridgeRun.token);
		const params = { cwd: this.opts.workDir, mcpServers };
		const res = this.sessionId ? await c.request<unknown>("session/resume", { sessionId: this.sessionId, ...params }, HANDSHAKE_TIMEOUT_MS) : await c.request<unknown>("session/new", params, HANDSHAKE_TIMEOUT_MS);
		if (!this.sessionId) this.sessionId = isObj(res) && typeof res.sessionId === "string" ? res.sessionId : undefined;
		if (!this.sessionId) throw new Error("session/new 没有返回会话 id");
		this.learnOptions(isObj(res) ? res.configOptions : undefined);
	}

	/** 记下命令行当前的模型和这个模型能选的思考强度 */
	private learnOptions(configOptions: unknown): void {
		const model = configValues(configOptions, "model");
		if (model) this.cur.model = model.current;
		const effort = configValues(configOptions, "effort");
		if (effort) this.cur = { ...this.cur, effort: effort.current, efforts: effort.values };
	}

	/** 把模型 / 思考强度切到想要的（和当前一样就不发）；模型切不过去是错误，思考强度切不过去不影响对话 */
	private async configure(model: string, effort: string | undefined): Promise<void> {
		const c = this.client!;
		const set = (configId: string, value: string) => c.request<unknown>("session/set_config_option", { sessionId: this.sessionId, configId, value }, HANDSHAKE_TIMEOUT_MS);
		if (this.cur.model !== model) {
			const res = await set("model", model);
			this.cur.model = model;
			this.learnOptions(isObj(res) ? res.configOptions : undefined);
		}
		const want = pickEffort(this.cur.efforts, effort);
		if (want && want !== this.cur.effort) {
			try {
				const res = await set("effort", want);
				this.cur.effort = want;
				this.learnOptions(isObj(res) ? res.configOptions : undefined);
			} catch {
				// 这个模型不支持这一档：用它当前的
			}
		}
	}

	private deliver(item: AcpItem): void {
		try {
			this.sink?.onItem(item);
		} catch {
			// 回调出错不能打断读进程输出
		}
	}

	private deliverResult(isError: boolean, text: string, stopReason: string, usage: TokenUsage = emptyUsage()): void {
		this.promptRunning = false;
		this.clearCollect();
		this.deliver({ type: "result", stopReason, isError, text, usage, sessionId: this.sessionId ?? "" });
		if (this.aborted) this.client?.close();
		else this.armIdle();
	}

	/** 往命令行发一轮用户输入（ACP 内容块）。进程已结束返回 false。 */
	sendPrompt(prompt: unknown[], model: string, effort: string | undefined): boolean {
		if (this.dead || !this.client) return false;
		clearTimeout(this.idleTimer);
		this.turn = { acpIds: new Set(), acp: 0, bridge: 0, collecting: false };
		this.promptRunning = true;
		const c = this.client;
		this.ready = this.ready
			.then(async () => {
				if (this.startFailed || this.aborted || !this.sessionId) return;
				await this.configure(model, effort);
				const res = await c.request<unknown>("session/prompt", { sessionId: this.sessionId, prompt }, 0);
				const r = isObj(res) ? res : {};
				this.deliverResult(false, "", typeof r.stopReason === "string" ? r.stopReason : "end_turn", acpUsageOf(r.usage));
			})
			.catch((e) => {
				// 进程没了由退出条目报告；提示出错（模型报错、切模型失败等）在这里报
				if (!this.exited) this.deliverResult(true, e instanceof Error ? e.message : String(e), "error");
			});
		return true;
	}

	private onNotification(method: string, params: unknown): void {
		if (method !== "session/update" || (isObj(params) && this.sessionId && params.sessionId !== this.sessionId)) return;
		for (const ev of convertAcpUpdate(params, this.opts.profile.toolPrefix)) {
			if (ev.type === "our_tool_call") {
				if (!this.turn.acpIds.has(ev.id)) {
					this.turn.acpIds.add(ev.id);
					this.turn.acp++;
					this.recheckCollect();
				}
			} else if (ev.type !== "context") this.deliver(ev); // 上下文占用只是最后一次调用的，不用
		}
	}

	/** 命令行向我们发的请求：权限一律「允许一次」，别的（读写文件等，我们没声明能力）回「不支持」 */
	private onServerRequest(id: number | string, method: string, params: unknown): void {
		const c = this.client;
		if (!c) return;
		if (method === "session/request_permission") {
			const optionId = pickAllowOption(isObj(params) ? params.options : undefined);
			c.respond(id, { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } });
		} else c.respondError(id, { code: -32601, message: `不支持的方法：${method}` });
	}

	/** 工具桥收到 `tools/call`：交给上层，并开始（或沿用）收齐窗口 */
	private onBridgeCall(c: BridgeCall): void {
		this.turn.bridge++;
		this.deliver({ type: "tool_call", id: `acp-${this.bridgeRun.id.slice(0, 6)}-${c.toolUseId}`, key: c.toolUseId, name: c.name, args: c.args });
		if (!this.turn.collecting) {
			this.turn.collecting = true;
			this.maxTimer = setTimeout(() => this.fireReady(), this.opts.collectMs ?? ACP_PARALLEL_WAIT_MS);
		}
		this.recheckCollect();
	}

	/** 桥收到的数量不少于 ACP 报告的数量时，安静一会儿就算收齐；还差的话继续等（最多到 `collectMs`） */
	private recheckCollect(): void {
		if (!this.turn.collecting) return;
		clearTimeout(this.settleTimer);
		this.settleTimer = this.turn.bridge >= this.turn.acp ? setTimeout(() => this.fireReady(), this.opts.settleMs ?? ACP_SETTLE_MS) : undefined;
	}

	private clearCollect(): void {
		clearTimeout(this.maxTimer);
		clearTimeout(this.settleTimer);
		this.maxTimer = this.settleTimer = undefined;
		this.turn.collecting = false;
	}

	private fireReady(): void {
		if (!this.turn.collecting) return;
		this.clearCollect();
		this.deliver({ type: "tools_ready" });
	}

	private armIdle(): void {
		clearTimeout(this.idleTimer);
		if (this.sink) return; // 这一轮还没人收尾，等 detach 再计时
		this.idleTimer = setTimeout(() => {
			this.idleExit = true;
			this.shutdown();
		}, this.opts.idleMs ?? ACP_IDLE_MS);
		this.idleTimer.unref();
	}

	/** 这一轮开始：接收方就位，取消空闲计时。返回 `detach`（一轮结束 / 被丢弃时调；进程还活着就重新计空闲）。 */
	attach(sink: AcpSink): () => void {
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		this.sink = sink;
		return () => {
			if (this.sink !== sink) return;
			this.sink = undefined;
			if (!this.dead) this.armIdle();
		};
	}

	/** Pi 执行完工具后回填结果（`key` = 配对键）；false = 这个调用已取消 / 已回过。 */
	resolveTool(key: string, result: CallToolResult): boolean {
		return this.bridgeRun.resolveTool(key, result);
	}

	/** 正常收摊：关 stdin 让命令行做完手上的就退出（`RpcClient.close` 3 秒不退就强杀）。 */
	shutdown(): void {
		this.client?.close();
	}

	/** 中止：先让挂起的工具调用返回「已取消」，再发 `session/cancel`，过一会儿（或它回包后）关进程。 */
	abort(): void {
		if (this.aborted) return;
		this.aborted = true;
		this.clearCollect();
		clearTimeout(this.idleTimer);
		this.bridgeRun.cancelAll();
		const c = this.client;
		if (!c) {
			this.bridgeRun.close();
			this.cleanup();
			this.resolveDone({ code: null, signal: null, stderr: "", closedByUs: true, aborted: true, idle: false });
			return;
		}
		if (this.promptRunning && this.sessionId) c.notify("session/cancel", { sessionId: this.sessionId });
		else c.close();
		const t = setTimeout(() => c.close(), ABORT_GRACE_MS);
		t.unref();
		void this.done.then(() => clearTimeout(t));
	}

	private onExit(exit: RpcExit): void {
		this.exited = true;
		this.clearCollect();
		clearTimeout(this.idleTimer);
		this.bridgeRun.close(); // 还挂着的工具调用统统返回「已取消」
		this.cleanup();
		const full: AcpExit = { ...exit, aborted: this.aborted, idle: this.idleExit };
		const sink = this.sink;
		this.sink = undefined;
		try {
			sink?.onExit(full);
		} catch {
			// 回调出错不能卡住收尾
		}
		this.resolveDone(full);
	}
}
