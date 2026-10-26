/**
 * 一个长驻的 `agy` 进程（每个 Pi 会话一个，方案 docs/design/cli-models.md §5b.2）。
 *
 * agy 启动要约 35 秒，所以进程不按轮起：起一次，之后每轮往 stdin 写一行用户消息、读 NDJSON，直到一轮的 `result`；
 * 空闲 10 分钟退出（stdin 关闭，agy 自己退出）。系统提示 / 工具集 / 模型变了由上层（pi-adapter/cli-models/antigravity.ts）弃用旧进程重开。
 *
 * 运行目录放在 `<runsRoot>/<随机>`（目录 0700、文件 0600）当 agy 的工作目录：里面是代理文件、插件、带令牌的 MCP 配置（`agy-launch.ts`），
 * 结束（正常、abort、空闲、没起来）一定删。令牌和系统提示都不进命令行。
 * 一个进程 = 一个 `BridgeRun`（工具桥登记，随机令牌，进程活着就一直有效）+ 一个子进程。
 *
 * 并行工具调用：agy 一个回复里发几个调用时几乎同时到（相隔约 10 毫秒），一条消息里有几个事先不知道，
 * 所以收到第一个 `tools/call` 后等 `collectMs`（默认 300 毫秒，没有依据，要调就调这里）收齐，再发一个 `tools_ready`。
 * 本类不碰 Pi；Pi 渠道拿它的事件去拼 Pi 的流。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { convertAgyLine, type AgyEvent } from "./agy-events.ts";
import { agyCallKey, agyRunFiles, buildAgyArgs, buildAgyEnv } from "./agy-launch.ts";
import { toolBridge, type BridgeCall, type BridgeRun, type CallToolResult, type Tool, type ToolBridge } from "./tool-bridge.ts";

/** 收到第一个 `tools/call` 后等多久收齐并行调用 */
export const AGY_PARALLEL_WAIT_MS = 300;
/** 空闲多久退出 */
export const AGY_IDLE_MS = 10 * 60_000;

/** 交给上层的条目：agy 的事件，加上工具桥收到的调用和「调用收齐了」 */
export type AgyItem =
	| AgyEvent
	/** `id` 是交给 Pi 的 toolCall id（带会话 id，跨进程不重复）；`key` 是配对键（step_index） */
	| { type: "tool_call"; id: string; key: string; name: string; args: Record<string, unknown> }
	| { type: "tools_ready" };

export interface AgyExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	/** 是我们主动中止的（abort） */
	aborted: boolean;
	/** 是空闲到时自己退的 */
	idle: boolean;
	/** stderr 末尾（最多 8KB），出错时放进错误信息 */
	stderr: string;
	/** 进程根本没起来 */
	spawnError?: string;
}

export interface AgyProcessOptions {
	/** `agy` 可执行文件（`detect.ts` 的 `findAgyCommand`） */
	command: string;
	/** 运行目录的父目录（`<dataDir>/cli-models/agy-runs`），不存在会建 */
	runsRoot: string;
	/** 工具桥地址的前缀，如 `http://127.0.0.1:8787` */
	bridgeBaseUrl: string;
	tools: Tool[];
	/** agy 里的完整模型 id */
	model: string;
	systemPrompt?: string;
	/** 续用的会话 id（`--conversation`） */
	conversationId?: string;
	collectMs?: number;
	idleMs?: number;
	baseEnv?: NodeJS.ProcessEnv;
	extraEnv?: Record<string, string>;
	/** 测试可换成独立的工具桥登记表 */
	bridge?: ToolBridge;
}

/** 当前这一轮的接收方：每个条目 + 进程退出 */
export interface AgySink {
	onItem(item: AgyItem): void;
	onExit(exit: AgyExit): void;
}

const STDERR_LIMIT = 8 * 1024;
const KILL_GRACE_MS = 3000;

export class AgyProcess {
	readonly bridgeRun: BridgeRun;
	readonly model: string;
	/** 进程结束（运行目录已删）后 resolve；不会 reject */
	readonly done: Promise<AgyExit>;
	/** 会话 id：续用时一开始就有，新开的从 `init` / `result` 得到 */
	conversationId: string | undefined;
	private child: ChildProcess | undefined;
	private dir: string | undefined;
	private stderr = "";
	private aborted = false;
	private idleExit = false;
	private sink: AgySink | undefined;
	private collectTimer: NodeJS.Timeout | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	private exited = false;
	private resolveDone!: (e: AgyExit) => void;

	constructor(private readonly opts: AgyProcessOptions) {
		this.model = opts.model;
		this.conversationId = opts.conversationId;
		this.bridgeRun = (opts.bridge ?? toolBridge).register({ tools: opts.tools, callKey: agyCallKey, onCall: (c) => this.onBridgeCall(c) });
		this.done = new Promise((resolve) => {
			this.resolveDone = resolve;
		});
	}

	/** 运行目录（运行期间存在，结束后删除）；测试用 */
	get runDir(): string | undefined {
		return this.dir;
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	/** 进程已经结束（或正在被中止），不能再用 */
	get dead(): boolean {
		return this.exited || this.aborted;
	}

	/** 这一轮有接收方（还没 `detach`） */
	get busy(): boolean {
		return !!this.sink;
	}

	private cleanup(): void {
		if (this.dir) rmSync(this.dir, { recursive: true, force: true });
		this.dir = undefined;
	}

	/** 启动进程。只能调一次。 */
	start(): void {
		if (this.child) throw new Error("AgyProcess 已经启动过");
		const o = this.opts;
		const url = `${o.bridgeBaseUrl.replace(/\/+$/, "")}/internal/tool-bridge/${this.bridgeRun.id}`;
		let child: ChildProcess;
		try {
			mkdirSync(o.runsRoot, { recursive: true, mode: 0o700 });
			const dir = mkdtempSync(join(o.runsRoot, "run-"));
			this.dir = dir;
			chmodSync(dir, 0o700);
			for (const f of agyRunFiles({ systemPrompt: o.systemPrompt, bridgeUrl: url, token: this.bridgeRun.token })) {
				const full = join(dir, f.path);
				mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
				writeFileSync(full, f.content, { mode: f.mode });
			}
			child = spawn(o.command, buildAgyArgs({ model: o.model, conversationId: o.conversationId }), { cwd: dir, env: buildAgyEnv({ baseEnv: o.baseEnv, extra: o.extraEnv }), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		} catch (e) {
			this.cleanup();
			this.bridgeRun.close();
			throw e;
		}
		this.child = child;
		let spawnError: string | undefined;
		let rlClosed: Promise<void> = Promise.resolve();

		child.stdin!.on("error", () => {}); // 进程先退出时写 stdin 会 EPIPE，不当成崩溃
		child.stderr!.on("data", (b: Buffer) => {
			this.stderr = (this.stderr + b.toString("utf8")).slice(-STDERR_LIMIT);
		});
		if (child.stdout) {
			const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
			rlClosed = new Promise((resolve) => rl.once("close", () => resolve()));
			rl.on("line", (line) => {
				for (const ev of convertAgyLine(line)) this.onEvent(ev);
			});
		}
		let finished = false;
		const finish = (code: number | null, signal: NodeJS.Signals | null, waitReader = true) => {
			if (finished) return;
			finished = true;
			void (waitReader ? rlClosed : Promise.resolve()).then(() => {
				this.exited = true;
				this.clearTimers();
				this.bridgeRun.close(); // 还挂着的工具调用统统返回「已取消」
				this.cleanup();
				const exit: AgyExit = { code, signal, aborted: this.aborted, idle: this.idleExit, stderr: this.stderr.trim(), spawnError };
				const sink = this.sink;
				this.sink = undefined;
				try {
					sink?.onExit(exit);
				} catch {
					// 回调出错不能卡住收尾
				}
				this.resolveDone(exit);
			});
		};
		child.once("error", (e) => {
			spawnError = e.message;
			if (child.pid === undefined) finish(null, null, false); // 进程没起来，不会再有 close
		});
		child.once("close", (code, signal) => finish(code, signal));
	}

	private clearTimers(): void {
		clearTimeout(this.collectTimer);
		clearTimeout(this.idleTimer);
		this.collectTimer = this.idleTimer = undefined;
	}

	private deliver(item: AgyItem): void {
		try {
			this.sink?.onItem(item);
		} catch {
			// 回调出错不能打断读进程输出
		}
	}

	private onEvent(ev: AgyEvent): void {
		if (ev.type === "init" && ev.sessionId) this.conversationId = ev.sessionId;
		this.deliver(ev);
		if (ev.type === "result") {
			if (ev.sessionId) this.conversationId = ev.sessionId;
			this.armIdle();
		}
	}

	/** 工具桥收到 `tools/call`：交给上层，并开始（或沿用）收齐窗口 */
	private onBridgeCall(c: BridgeCall): void {
		const conv = (this.conversationId ?? "new").slice(0, 8);
		this.deliver({ type: "tool_call", id: `agy-${conv}-${c.toolUseId}`, key: c.toolUseId, name: c.name, args: c.args });
		if (this.collectTimer) return;
		this.collectTimer = setTimeout(() => {
			this.collectTimer = undefined;
			this.deliver({ type: "tools_ready" });
		}, this.opts.collectMs ?? AGY_PARALLEL_WAIT_MS);
	}

	private armIdle(): void {
		clearTimeout(this.idleTimer);
		if (this.sink) return; // 这一轮还没人收尾，等 detach 再计时
		this.idleTimer = setTimeout(() => {
			this.idleExit = true;
			this.shutdown();
		}, this.opts.idleMs ?? AGY_IDLE_MS);
		this.idleTimer.unref();
	}

	/** 这一轮开始：接收方就位，取消空闲计时。返回 `detach`（一轮结束 / 被丢弃时调；进程还活着就重新计空闲）。 */
	attach(sink: AgySink): () => void {
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		this.sink = sink;
		return () => {
			if (this.sink !== sink) return;
			this.sink = undefined;
			if (!this.dead) this.armIdle();
		};
	}

	/** 往 stdin 写一条用户消息。进程已结束 / stdin 已关返回 false。 */
	sendUserMessage(text: string): boolean {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
		stdin.write(`${JSON.stringify({ event: "user", message: { content: text } })}\n`);
		return true;
	}

	/** Pi 执行完工具后回填结果（`key` = 配对键）；false = 这个调用已取消 / 已回过。 */
	resolveTool(key: string, result: CallToolResult): boolean {
		return this.bridgeRun.resolveTool(key, result);
	}

	/** 正常收摊：关 stdin 让 agy 做完手上的就退出，3 秒不退就强杀。 */
	shutdown(): void {
		const child = this.child;
		if (!child || this.dead) return;
		child.stdin?.end();
		const t = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
		t.unref();
		void this.done.then(() => clearTimeout(t));
	}

	/** 中止：先让挂起的工具调用返回「已取消」，再发 SIGINT（agy 立刻以「interrupted」结束并退出），3 秒不退就强杀。 */
	abort(): void {
		if (this.aborted) return;
		this.aborted = true;
		this.clearTimers();
		this.bridgeRun.cancelAll();
		const child = this.child;
		if (!child) {
			this.bridgeRun.close();
			this.cleanup();
			this.resolveDone({ code: null, signal: null, aborted: true, idle: false, stderr: "" });
			return;
		}
		if (child.exitCode !== null || child.signalCode !== null) return;
		child.kill("SIGINT");
		const t = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
		t.unref();
		void this.done.then(() => clearTimeout(t));
	}
}
