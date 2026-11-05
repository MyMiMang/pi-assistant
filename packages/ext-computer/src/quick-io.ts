/**
 * 快速执行 / 快速打开共用的 I/O：读工具结果里的文本、读一次页面结构、页面内容摘要。
 * 从 quick-steps-tool.ts 挪过来，两个循环共用一份；纯逻辑（解析）在 quick-steps.ts。
 */
import { parseObservation, type Observation, type QuickTarget } from "./quick-steps.ts";
import { unwrapStructured } from "./structured.ts";

/** `ctx.executeTool` 的结果（只取这里用得到的字段，不依赖 pi-agent-core 的类型） */
export type Outcome = {
	isError: boolean;
	result: { content: { type: string; text?: string; data?: string; mimeType?: string }[]; structuredContent?: unknown };
};
/** 只用到 executeTool 的上下文（执行循环 / 打开工具共用） */
export type ExecContext = { executeTool(name: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<Outcome> };

/** 等一会儿（读页面前给页面一点时间） */
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 读工具结果里给模型看的文本 */
export const textOf = (r: Outcome) => (r.result.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");

/** 读一次页面结构（shot = 带截图）；读失败返回原因字符串 */
export async function observe(ctx: ExecContext, target: QuickTarget, prefix: string, signal: AbortSignal | undefined, shot: boolean): Promise<Observation | string> {
	const call =
		target.kind === "browser"
			? { tool: "get_browser_state", args: { tab_id: target.tab_id, ...(target.target_id ? { target_id: target.target_id } : {}), ...(target.session ? { session: target.session } : {}), snapshot_format: "semantic_v2", include_screenshot: shot } }
			: { tool: "get_window_state", args: { pid: target.pid, window_id: target.window_id, tree_format: "both", include_screenshot: shot } };
	const out = await ctx.executeTool(`${prefix}${call.tool}`, call.args, { signal });
	const text = textOf(out);
	if (out.isError) return text.slice(0, 300) || "读取页面失败";
	return parseObservation(target, unwrapStructured(out.result.structuredContent), text, out.result.content);
}

/** 页面内容摘要（没有就退回可操作元素列表） */
export function pageSummary(obs: Observation): string {
	if (obs.summary) return obs.summary;
	return obs.candidates.map((c) => `${c.role}「${c.name}」`).join("\n");
}
