/**
 * 长驻进程渠道（antigravity / ACP）共用的小工具：每个 Pi 会话一个进程的池，和「Pi 执行完工具回来」时的回填（含插话）。
 * 骨架 `channel-core.ts` 管流程，这里只管这两件在 agy 和 ACP 渠道里一模一样的事，不要在各家再抄一份。
 */
import type { CallToolResult } from "../../cli-agents/tool-bridge.ts";

import { blocksToPlainText, toolResultToMcp, userMessagesToClaude, type Continuation } from "./convert.ts";

/** 池里的进程要有的最小接口 */
export interface PooledProc {
	dead: boolean;
	busy: boolean;
	done: Promise<unknown>;
	/** 正常收摊 */
	shutdown(): void;
	/** 中止 */
	abort(): void;
}

/** 每个 Pi 会话键一个长驻进程（空闲 / 一轮刚结束时在这里等下一轮）；`composite` = 起进程时「模型 + 工具集 + 系统提示」的指纹 */
export class ProcessPool<P extends PooledProc> {
	private readonly map = new Map<string, { proc: P; composite: string }>();

	/**
	 * 取这个会话键的旧进程：`reusable` 为真就沿用；否则弃用并等它退出（同一个会话不能被两个进程同时用），返回 undefined。
	 * 指纹不一样一律不沿用。
	 */
	async take(key: string | undefined, composite: string, reusable: (p: P) => boolean): Promise<P | undefined> {
		const old = key ? this.map.get(key) : undefined;
		if (!old) return undefined;
		if (!old.proc.dead && !old.proc.busy && old.composite === composite && reusable(old.proc)) return old.proc;
		this.map.delete(key!);
		old.proc.shutdown();
		await old.proc.done;
		return undefined;
	}

	/** 新进程入池（没有会话键的单次请求不入池）；进程结束自动出池 */
	add(key: string | undefined, proc: P, composite: string): void {
		if (!key) return;
		const entry = { proc, composite };
		this.map.set(key, entry);
		void proc.done.then(() => this.map.get(key) === entry && this.map.delete(key));
	}

	/** 服务关闭：中止全部 */
	disposeAll(): void {
		for (const p of this.map.values()) p.proc.abort();
		this.map.clear();
	}
}

/** 一轮结束时的进程收尾：没正常结束就中止；总结等单次请求用完就关 */
export function releaseProc(proc: PooledProc, cleanEnd: boolean, oneShot: boolean): void {
	if (!cleanEnd) proc.abort();
	else if (oneShot) proc.shutdown();
}

/**
 * Pi 执行完工具回来：把结果按配对键回给挂着的那几个调用。命令行不能把消息并进当前轮，
 * 所以插话附在最后一个工具结果文字后面（「[用户插话] …」），模型下一次请求就看得到。
 */
export function resolveToolResults(keyOf: ReadonlyMap<string, string>, cont: Continuation, ids: readonly string[], resolve: (key: string, result: CallToolResult) => void): void {
	const extra = cont.extras.length ? blocksToPlainText(userMessagesToClaude(cont.extras)).trim() : "";
	ids.forEach((id, i) => {
		const key = keyOf.get(id);
		const msg = cont.results.get(id);
		if (!key || !msg) return;
		const result = toolResultToMcp(msg);
		if (extra && i === ids.length - 1) result.content.push({ type: "text", text: `\n\n[用户插话] ${extra}` });
		resolve(key, result);
	});
}
