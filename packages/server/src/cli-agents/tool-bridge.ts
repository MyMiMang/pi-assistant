/**
 * 工具桥：给 `claude` 用的最小 MCP 服务（JSON-RPC，streamable HTTP 的 POST 方式），方案 §4.3。
 *
 * 每次 claude 运行登记一份（`BridgeRun`：随机令牌 + 工具清单）。claude 想用工具时发 `tools/call`：
 * 桥把它按 `params._meta["claudecode/toolUseId"]`（等于 `tool_use` 块的 id）登记成「挂起的调用」，
 * 返回一个迟迟不回的 Promise，等外部 `resolveTool(id, 结果)` 回填（工具由 Pi 执行，先过审批）。
 * `tools/call` 和 `tool_use` 事件几乎同时到、先后不固定，结果也可能比 `tools/call` 先到：两边谁先登记都能配对。
 *
 * 取消：claude 自己超时 / 中止时发 `notifications/cancelled`，对应调用标成已取消，之后的回填忽略；
 * 运行结束或 abort 时（`close()`）所有挂起的调用都返回「已取消」。
 *
 * 只收 JSON-RPC 的 `initialize`、`notifications/initialized`、`tools/list`、`tools/call`、`notifications/cancelled`、`ping`。
 * 协议类型和常量复用 `@earendil-works/pi-mcp`（经 `pi-adapter/mcp-protocol.ts` 转出）。HTTP 入口见 `routes/tool-bridge.ts`。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
	JSON_RPC_ERROR_CODES,
	LATEST_PROTOCOL_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
	type CallToolResult,
	type JsonRpcId,
	type JsonRpcResponse,
	type Tool,
} from "../pi-adapter/mcp-protocol.ts";

export type { CallToolResult, Tool };

const TOOL_USE_ID_META = "claudecode/toolUseId";

export const cancelledResult = (): CallToolResult => ({ content: [{ type: "text", text: "已取消" }], isError: true });
export const textResult = (text: string, isError = false): CallToolResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

export interface BridgeCall {
	toolUseId: string;
	name: string;
	args: Record<string, unknown>;
}

export interface BridgeRunOptions {
	tools: Tool[];
	/** claude 发来 `tools/call`（已登记为挂起）时调用 */
	onCall?: (call: BridgeCall) => void;
	/** claude 取消了某个调用（自己超时 / 中止）时调用 */
	onCancelled?: (toolUseId: string) => void;
}

/** waiting = 调用已到、等回填；early = 结果先到、等调用；done = 已回过；cancelled = 已取消 */
interface Entry {
	state: "waiting" | "early" | "done" | "cancelled";
	resolve?: (r: CallToolResult) => void;
	result?: CallToolResult;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const rpcOk = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

export class BridgeRun {
	readonly id: string;
	readonly token: string;
	readonly tools: Tool[];
	private readonly entries = new Map<string, Entry>();
	/** JSON-RPC 请求 id → toolUseId，给 `notifications/cancelled` 找对应的调用 */
	private readonly rpcToUse = new Map<string, string>();
	private closed = false;

	constructor(
		private readonly opts: BridgeRunOptions,
		private readonly onClose: (run: BridgeRun) => void,
	) {
		this.id = randomBytes(8).toString("hex");
		this.token = randomBytes(32).toString("base64url");
		this.tools = opts.tools;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	/** 还在等回填的 toolUseId */
	pendingIds(): string[] {
		return [...this.entries].filter(([, e]) => e.state === "waiting").map(([id]) => id);
	}

	/**
	 * 回填工具结果。调用已到就立刻放行；调用还没到就先存着，等它到了直接返回。
	 * 返回 false = 这个调用已取消 / 已回过 / 运行已结束，结果被忽略。
	 */
	resolveTool(toolUseId: string, result: CallToolResult): boolean {
		if (this.closed) return false;
		const e = this.entries.get(toolUseId) ?? { state: "early" as const };
		if (e.state === "cancelled" || e.state === "done") return false;
		if (e.state === "early" && e.result) return false; // 同一个 id 回填两次：第一次为准
		if (e.state === "waiting") {
			e.state = "done";
			e.resolve?.(result);
			e.resolve = undefined;
		} else {
			e.result = result;
		}
		this.entries.set(toolUseId, e);
		return true;
	}

	/** 取消所有还没回的调用（挂起的返回「已取消」，没配上对的先到结果也作废） */
	cancelAll(): void {
		for (const e of this.entries.values()) {
			if (e.state === "waiting") e.resolve?.(cancelledResult());
			if (e.state === "waiting" || e.state === "early") e.state = "cancelled";
			e.resolve = undefined;
			e.result = undefined;
		}
	}

	/** 运行结束 / 中止：取消所有挂起的调用并注销。 */
	close(): void {
		if (this.closed) return;
		this.cancelAll();
		this.closed = true;
		this.onClose(this);
	}

	/** 处理一条 JSON-RPC 消息；请求返回响应，通知返回 null（HTTP 层回 202）。 */
	async handleMessage(msg: unknown): Promise<JsonRpcResponse | null> {
		if (!isObj(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
			const id = isObj(msg) && (typeof msg.id === "string" || typeof msg.id === "number") ? msg.id : 0;
			return isObj(msg) && "id" in msg && !("method" in msg) ? null : rpcErr(id, JSON_RPC_ERROR_CODES.invalidRequest, "无效的 JSON-RPC 请求");
		}
		const params = isObj(msg.params) ? msg.params : {};
		const hasId = typeof msg.id === "string" || typeof msg.id === "number";
		if (!hasId) {
			if (msg.method === "notifications/cancelled") this.cancelRpc(params.requestId);
			return null; // notifications/initialized 等通知：无需回应
		}
		const id = msg.id as JsonRpcId;
		switch (msg.method) {
			case "initialize": {
				const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
				const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : LATEST_PROTOCOL_VERSION;
				return rpcOk(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "pia-tool-bridge", version: "1" } });
			}
			case "ping":
				return rpcOk(id, {});
			case "tools/list":
				return rpcOk(id, { tools: this.tools });
			case "tools/call":
				return this.callTool(id, params);
			default:
				return rpcErr(id, JSON_RPC_ERROR_CODES.methodNotFound, `不支持的方法：${msg.method}`);
		}
	}

	private async callTool(rpcId: JsonRpcId, params: Record<string, unknown>): Promise<JsonRpcResponse> {
		const name = typeof params.name === "string" ? params.name : "";
		if (!this.tools.some((t) => t.name === name)) return rpcErr(rpcId, JSON_RPC_ERROR_CODES.invalidParams, `未知工具：${name}`);
		if (this.closed) return rpcOk(rpcId, cancelledResult());
		const meta = isObj(params._meta) ? params._meta : {};
		const toolUseId = typeof meta[TOOL_USE_ID_META] === "string" && meta[TOOL_USE_ID_META] ? (meta[TOOL_USE_ID_META] as string) : `rpc-${rpcId}`;
		const args = isObj(params.arguments) ? params.arguments : {};
		const e = this.entries.get(toolUseId);
		if (e?.state === "cancelled") return rpcOk(rpcId, cancelledResult());
		if (e?.state === "early" && e.result) {
			const result = e.result;
			e.state = "done";
			e.result = undefined;
			return rpcOk(rpcId, result);
		}
		if (e?.state === "done") return rpcOk(rpcId, cancelledResult()); // 重复调用同一个 id：不再执行第二次
		if (e?.state === "waiting") e.resolve?.(cancelledResult()); // 同 id 重发：旧请求作废
		const entry: Entry = { state: "waiting" };
		const pending = new Promise<CallToolResult>((resolve) => {
			entry.resolve = resolve;
		});
		this.entries.set(toolUseId, entry);
		this.rpcToUse.set(String(rpcId), toolUseId);
		this.opts.onCall?.({ toolUseId, name, args });
		return rpcOk(rpcId, await pending);
	}

	private cancelRpc(requestId: unknown): void {
		if (typeof requestId !== "string" && typeof requestId !== "number") return;
		const toolUseId = this.rpcToUse.get(String(requestId));
		const e = toolUseId ? this.entries.get(toolUseId) : undefined;
		if (!toolUseId || !e || e.state !== "waiting") return;
		e.state = "cancelled";
		e.resolve?.(cancelledResult());
		e.resolve = undefined;
		this.opts.onCancelled?.(toolUseId);
	}
}

/** 所有进行中的运行。 */
export class ToolBridge {
	private readonly runs = new Map<string, BridgeRun>();

	register(opts: BridgeRunOptions): BridgeRun {
		const run = new BridgeRun(opts, (r) => this.runs.delete(r.id));
		this.runs.set(run.id, run);
		return run;
	}

	/** 按运行 id + 令牌找运行；令牌错 / 运行不存在 / 已结束都返回 undefined（定长比较，不泄露差异）。 */
	authorize(runId: string, token: string | undefined): BridgeRun | undefined {
		const run = this.runs.get(runId);
		const a = Buffer.from(token ?? "");
		const b = Buffer.from(run?.token ?? "");
		const okLen = a.length === b.length && a.length > 0;
		const same = timingSafeEqual(okLen ? a : Buffer.alloc(1), okLen ? b : Buffer.alloc(1));
		return run && okLen && same && !run.isClosed ? run : undefined;
	}

	get size(): number {
		return this.runs.size;
	}
}

export const toolBridge = new ToolBridge();
