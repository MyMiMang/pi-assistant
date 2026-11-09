/** 扩展工具统一停止 / 卡死保护；仅代理公开 registerTool，不改 Pi 本体。 */
import type { ExtensionFactory, ToolDefinition } from "./index.ts";

export const TOOL_STALL_MS = 10 * 60_000;
const TOOL_TICK_MS = 15_000;
export interface ToolGuardOptions {
	waitingForUser?: () => boolean;
	stallMs?: number;
	tickMs?: number;
}

const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

function guardedExecute(tool: ToolDefinition, opts: ToolGuardOptions): ToolDefinition["execute"] {
	return function (...args) {
		const signal = args[2];
		if (signal?.aborted) return Promise.resolve(result("已停止：用户中止了这一步"));
		return new Promise((resolve, reject) => {
			let settled = false;
			let elapsed = 0;
			let lastTick = performance.now();
			let timer: ReturnType<typeof setInterval> | undefined;
			const cleanup = () => {
				clearInterval(timer);
				signal?.removeEventListener("abort", abort);
			};
			const finish = (value: Awaited<ReturnType<ToolDefinition["execute"]>>) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			};
			const fail = (error: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const abort = () => finish(result("已停止：用户中止了这一步"));
			signal?.addEventListener("abort", abort, { once: true });
			timer = setInterval(() => {
				const current = performance.now();
				try {
					if (!opts.waitingForUser?.()) elapsed += current - lastTick;
					lastTick = current;
					if (elapsed >= (opts.stallMs ?? TOOL_STALL_MS)) {
						finish(result("这一步超过 10 分钟没有返回，已放弃（工具可能卡住了）。可以换个做法或重试"));
					}
				} catch (error) { fail(error); }
			}, opts.tickMs ?? TOOL_TICK_MS);
			// 两条分支都接住：退出等待后原工具仍可结束，不会产生未处理的 rejection。
			try { Promise.resolve(tool.execute.apply(tool, args)).then(finish, fail); }
			catch (error) { fail(error); }
		});
	};
}

export function guardTools(factory: ExtensionFactory, opts: ToolGuardOptions = {}): ExtensionFactory {
	return (pi) => factory(new Proxy(pi, {
		get(target, key) {
			if (key === "registerTool") return (tool: ToolDefinition) => target.registerTool({ ...tool, execute: guardedExecute(tool, opts) });
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}));
}
