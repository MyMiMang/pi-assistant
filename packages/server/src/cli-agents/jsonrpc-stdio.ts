/**
 * 本机命令行的 JSON-RPC over stdio 客户端（一行一条 JSON）：`codex app-server`（方案 docs/design/cli-models.md §5.2）和
 * ACP 命令行（OpenCode 等，docs/design/acp-cli-models.md）共用。
 * 只管读写协议：发请求等回包、发通知、收通知、收服务端请求（如 `item/tool/call`、`session/request_permission`）并按 id 回包。
 * 进程的生命周期：codex 在 `codex-hub.ts`，ACP 在 `acp-process.ts`；Pi 相关的在 `pi-adapter/cli-models/`。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export interface RpcExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	/** stderr 末尾（最多 8KB），出错时放进错误信息 */
	stderr: string;
	/** 进程根本没起来（找不到可执行文件等） */
	spawnError?: string;
	/** 我们主动关的（空闲退出 / 服务关闭） */
	closedByUs: boolean;
}

export interface RpcClientOptions {
	/** 界面报错里的名字，如 `codex`、`OpenCode` */
	label: string;
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	onNotification: (method: string, params: unknown) => void;
	/** 服务端发来的请求（有 id）；调用方稍后用 `respond` / `respondError` 回 */
	onRequest: (id: number | string, method: string, params: unknown) => void;
	onExit: (exit: RpcExit) => void;
}

const STDERR_LIMIT = 8 * 1024;
const KILL_GRACE_MS = 3000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	timer?: NodeJS.Timeout;
	method: string;
}

/** JSON-RPC 错误（保留 code，方便判断「线程不存在」之类） */
export class RpcError extends Error {
	constructor(
		message: string,
		readonly code?: number,
	) {
		super(message);
	}
}

export class RpcClient {
	private child: ChildProcess | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private stderr = "";
	private closedByUs = false;
	private exited = false;
	/** 进程结束（回调都发完）后 resolve */
	readonly exitedPromise: Promise<void>;
	private resolveExited!: () => void;

	constructor(private readonly opts: RpcClientOptions) {
		this.exitedPromise = new Promise((r) => (this.resolveExited = r));
	}

	/** 还能用：已启动、没退出、也没被我们关（关了就等它退，别再往里发请求） */
	get alive(): boolean {
		return !!this.child && !this.exited && !this.closedByUs;
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	/** 启动进程。只能调一次。 */
	start(): void {
		if (this.child) throw new Error("RpcClient 已经启动过");
		const o = this.opts;
		const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
			rl.on("line", (line) => this.onLine(line));
		}
		const finish = (code: number | null, signal: NodeJS.Signals | null, waitReader: boolean) => {
			if (this.exited) return;
			this.exited = true;
			void (waitReader ? rlClosed : Promise.resolve()).then(() => {
				const err = new Error(spawnError ? `无法启动 ${o.label}：${spawnError}` : `${o.label} 进程已退出（退出码 ${code ?? signal ?? "未知"}）${this.stderr.trim() ? `：${this.stderr.trim()}` : ""}`);
				for (const [id, p] of this.pending) {
					if (p.timer) clearTimeout(p.timer);
					this.pending.delete(id);
					p.reject(err);
				}
				try {
					o.onExit({ code, signal, stderr: this.stderr.trim(), spawnError, closedByUs: this.closedByUs });
				} catch {
					// 回调出错不影响收尾
				}
				this.resolveExited();
			});
		};
		child.once("error", (e) => {
			spawnError = e.message;
			if (child.pid === undefined) finish(null, null, false);
		});
		child.once("close", (code, signal) => finish(code, signal, true));
	}

	private onLine(line: string): void {
		const text = line.trim();
		if (!text) return;
		let m: unknown;
		try {
			m = JSON.parse(text);
		} catch {
			return; // 不是 JSON 的行（日志）
		}
		if (typeof m !== "object" || m === null) return;
		const msg = m as { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string; code?: number } };
		try {
			if (msg.id !== undefined && typeof msg.method === "string") this.opts.onRequest(msg.id, msg.method, msg.params);
			else if (msg.id !== undefined) {
				const p = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
				if (!p) return;
				this.pending.delete(msg.id as number);
				if (p.timer) clearTimeout(p.timer);
				if (msg.error) p.reject(new RpcError(`${p.method} 失败：${msg.error.message ?? "未知错误"}`, msg.error.code));
				else p.resolve(msg.result);
			} else if (typeof msg.method === "string") this.opts.onNotification(msg.method, msg.params);
		} catch {
			// 回调出错不能打断读进程输出
		}
	}

	private write(o: unknown): boolean {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
		stdin.write(`${JSON.stringify(o)}\n`);
		return true;
	}

	/** 发请求等回包；进程没了 / 超时都会 reject。 */
	request<T = unknown>(method: string, params?: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const id = this.nextId++;
			const p: Pending = { resolve: resolve as (v: unknown) => void, reject, method };
			if (timeoutMs > 0)
				p.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error(`${method} 超过 ${Math.round(timeoutMs / 1000)} 秒没有回应`));
				}, timeoutMs);
			this.pending.set(id, p);
			if (!this.write({ id, method, params })) {
				this.pending.delete(id);
				if (p.timer) clearTimeout(p.timer);
				reject(new Error(`${this.opts.label} 进程已经不在了`));
			}
		});
	}

	notify(method: string, params?: unknown): void {
		this.write({ method, params });
	}

	respond(id: number | string, result: unknown): boolean {
		return this.write({ id, result });
	}

	respondError(id: number | string, error: { code: number; message: string }): boolean {
		return this.write({ id, error });
	}

	/** 关掉进程：先关 stdin（命令行会自己退），3 秒不退就强杀。 */
	close(): void {
		if (!this.child || this.exited) return;
		this.closedByUs = true;
		this.child.stdin?.end();
		this.child.kill("SIGTERM");
		const child = this.child;
		const t = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
		t.unref();
		child.once("close", () => clearTimeout(t));
	}
}
