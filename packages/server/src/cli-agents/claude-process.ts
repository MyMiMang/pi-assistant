/**
 * 一次 `claude` 运行（每轮用户消息起一个进程，方案 §4.2）：启动进程、逐行读 stdout 转成事件、
 * 往 stdin 写用户消息（首条消息和插话）、把 Pi 执行完的工具结果回填给工具桥、abort。
 *
 * 令牌（MCP 配置）和系统提示都不放命令行（`ps` 看得到、Windows 命令行有长度上限）：每次运行建一个私有临时目录
 * （目录 0700、文件 0600）放这两个文件，运行结束（正常、abort、进程没起来）一定删掉。
 * 一个运行 = 一个 `BridgeRun`（工具桥登记，随机令牌）+ 一个子进程。进程退出或 abort 时，工具桥里还挂着的调用都返回「已取消」。
 * 本类不碰 Pi；Pi 渠道（pi-adapter/cli-models/claude-code.ts）拿它的事件去拼 Pi 的流。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createEventConverter, type ClaudeEvent } from "./events.ts";
import { bridgeMcpConfig, buildClaudeArgs, buildClaudeEnv, type ClaudeArgsInput } from "./launch.ts";
import { toolBridge, type BridgeCall, type BridgeRun, type CallToolResult, type Tool, type ToolBridge } from "./tool-bridge.ts";

/** 用户消息内容：纯文字，或 Anthropic 内容块（文字 / 图片等） */
export type UserContent = string | Array<Record<string, unknown>>;

export interface ClaudeExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	aborted: boolean;
	/** stderr 末尾（最多 8KB），出错时放进错误信息 */
	stderr: string;
	/** 进程根本没起来（找不到可执行文件等） */
	spawnError?: string;
}

export interface ClaudeRunOptions {
	/** `claude` 可执行文件（`detect.ts` 的 `findClaudeCommand`） */
	command: string;
	/** 工作目录（助理工作区） */
	cwd: string;
	/** 工具桥地址的前缀，如 `http://127.0.0.1:8787`（本机服务的端口） */
	bridgeBaseUrl: string;
	/** 这轮能用的工具（Pi 里的工具清单），claude 通过 MCP `tools/list` 看到 */
	tools: Tool[];
	/** 其余参数（模型、思考强度、续用会话 id 等）；系统提示文字写进私有临时文件再用文件参数传，不放命令行 */
	args?: Omit<ClaudeArgsInput, "mcpConfigPath" | "systemPromptFile"> & { systemPrompt?: string };
	onEvent: (event: ClaudeEvent) => void;
	/** claude 发起了工具调用（已挂起，等 `resolveTool`） */
	onToolCall?: (call: BridgeCall) => void;
	/** claude 自己取消了某个工具调用（超时 / 中止） */
	onToolCancelled?: (toolUseId: string) => void;
	/** 收到 `result` 后自动关 stdin 让进程退出（默认 true；每轮一个进程） */
	closeOnResult?: boolean;
	baseEnv?: NodeJS.ProcessEnv;
	extraEnv?: Record<string, string>;
	/** 测试可换成独立的工具桥登记表 */
	bridge?: ToolBridge;
}

const STDERR_LIMIT = 8 * 1024;
const KILL_GRACE_MS = 3000;

export class ClaudeRun {
	readonly bridgeRun: BridgeRun;
	/** 进程结束（事件都已发完）后 resolve；不会 reject */
	readonly done: Promise<ClaudeExit>;
	private child: ChildProcess | undefined;
	private dir: string | undefined;
	private stderr = "";
	private aborted = false;
	private resolveDone!: (e: ClaudeExit) => void;

	constructor(private readonly opts: ClaudeRunOptions) {
		this.bridgeRun = (opts.bridge ?? toolBridge).register({ tools: opts.tools, onCall: opts.onToolCall, onCancelled: opts.onToolCancelled });
		this.done = new Promise((resolve) => {
			this.resolveDone = resolve;
		});
	}

	/** 私有临时目录（运行期间存在，结束后删除）；测试用 */
	get privateDir(): string | undefined {
		return this.dir;
	}

	private cleanup(): void {
		if (this.dir) rmSync(this.dir, { recursive: true, force: true });
		this.dir = undefined;
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	/** 启动进程。只能调一次。 */
	start(): void {
		if (this.child) throw new Error("ClaudeRun 已经启动过");
		const o = this.opts;
		const url = `${o.bridgeBaseUrl.replace(/\/+$/, "")}/internal/tool-bridge/${this.bridgeRun.id}`;
		let child: ChildProcess;
		try {
			const dir = mkdtempSync(join(tmpdir(), "pia-claude-"));
			this.dir = dir;
			chmodSync(dir, 0o700);
			const mcpConfigPath = join(dir, "mcp.json");
			writeFileSync(mcpConfigPath, bridgeMcpConfig(url, this.bridgeRun.token), { mode: 0o600 });
			let systemPromptFile: string | undefined;
			if (o.args?.systemPrompt !== undefined) {
				systemPromptFile = join(dir, "system-prompt.txt");
				writeFileSync(systemPromptFile, o.args.systemPrompt, { mode: 0o600 });
			}
			const { systemPrompt: _text, ...rest } = o.args ?? {};
			const args = buildClaudeArgs({ ...rest, mcpConfigPath, systemPromptFile });
			const env = buildClaudeEnv({ baseEnv: o.baseEnv, extra: o.extraEnv });
			child = spawn(o.command, args, { cwd: o.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		} catch (e) {
			this.cleanup();
			this.bridgeRun.close();
			throw e;
		}
		this.child = child;
		const converter = createEventConverter();
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
				for (const ev of converter.convert(line)) {
					if (ev.type === "result") {
						if (o.closeOnResult !== false) child.stdin?.end();
					}
					try {
						o.onEvent(ev);
					} catch {
						// 回调出错不能打断读进程输出
					}
				}
			});
		}
		let finished = false;
		const finish = (code: number | null, signal: NodeJS.Signals | null, waitReader = true) => {
			if (finished) return;
			finished = true;
			void (waitReader ? rlClosed : Promise.resolve()).then(() => {
				this.bridgeRun.close(); // 还挂着的工具调用统统返回「已取消」
				this.cleanup();
				this.resolveDone({ code, signal, aborted: this.aborted, stderr: this.stderr.trim(), spawnError });
			});
		};
		child.once("error", (e) => {
			spawnError = e.message;
			if (child.pid === undefined) finish(null, null, false); // 进程没起来，不会再有 close
		});
		child.once("close", (code, signal) => finish(code, signal));
	}

	/** 往 stdin 写一条用户消息（首条消息，或工具执行期间的插话）。进程已结束 / stdin 已关返回 false。 */
	sendUserMessage(content: UserContent): boolean {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
		stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
		return true;
	}

	/** 关 stdin（不再有新消息，claude 做完手上的就退出）。 */
	endInput(): void {
		this.child?.stdin?.end();
	}

	/** Pi 执行完工具后回填结果；false = 这个调用已取消 / 已回过。 */
	resolveTool(toolUseId: string, result: CallToolResult): boolean {
		return this.bridgeRun.resolveTool(toolUseId, result);
	}

	/** 中止：先让所有挂起的工具调用返回「已取消」，再结束进程（3 秒不退就强杀）。 */
	abort(): void {
		if (this.aborted) return;
		this.aborted = true;
		this.bridgeRun.cancelAll();
		const child = this.child;
		if (!child) {
			this.bridgeRun.close();
			this.cleanup();
			this.resolveDone({ code: null, signal: null, aborted: true, stderr: "" });
			return;
		}
		if (child.exitCode !== null || child.signalCode !== null) {
			this.bridgeRun.close();
			this.cleanup();
			return;
		}
		child.kill("SIGTERM");
		const t = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
		t.unref();
		void this.done.then(() => clearTimeout(t));
	}
}
