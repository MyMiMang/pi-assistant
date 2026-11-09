/** 原生 ACP 的旁路步骤只写 App 消息，不创建 Pi 工具或执行工具。 */
import { insertMessage, updateMessage } from "../messages.ts";
import type { NativeToolEvent } from "../pi-adapter/index.ts";

type Status = "running" | "done" | "error" | "interrupted";
const statusOf = (status: NativeToolEvent["status"]): Status => status === "completed" ? "done" : status === "failed" ? "error" : "running";
const displayText = (value: unknown): string => {
	try { return (typeof value === "string" ? value : JSON.stringify(value) ?? "").slice(0, 4000); }
	catch { return ""; }
};

/** 每个 bindSession 一份，重复 start / 早到 update 共用同一条消息，迟到 running 不复活终态。 */
export function nativeAcpMessages(insert: (m: Omit<Parameters<typeof insertMessage>[0], "agentId">) => ReturnType<typeof insertMessage>) {
	const calls = new Map<string, { mid: string; status: Status }>();
	return {
		has: (id: string) => calls.has(id),
		update(event: NativeToolEvent) {
			const old = calls.get(event.id);
			const status = old && old.status !== "running" ? old.status : statusOf(event.status);
			const meta: Record<string, unknown> = { executionSource: "native-acp", toolCallId: event.id, title: event.title.slice(0, 500) };
			if (event.kind !== undefined) meta.kind = event.kind;
			if (event.rawInput !== undefined) meta.args = { input: displayText(event.rawInput) };
			if (event.rawOutput !== undefined) meta.result = displayText(event.rawOutput);
			if (event.content !== undefined) meta.nativeContent = displayText(event.content);
			if (event.locations !== undefined) meta.locations = displayText(event.locations);
			if (old) updateMessage(old.mid, { status, meta });
			else {
				const m = insert({ role: "tool", content: "", status, meta: { toolName: "原生工具", title: "原生工具", ...meta } });
				calls.set(event.id, { mid: m.id, status });
			}
			if (old) old.status = status;
		},
		finish(aborted: boolean) {
			for (const call of calls.values()) {
				if (call.status !== "running") continue;
				call.status = aborted ? "interrupted" : "error";
				updateMessage(call.mid, { status: call.status, meta: { result: aborted ? "已停止，操作结果未确认" : "执行已结束，工具未报告最终结果" } });
			}
			calls.clear();
		},
	};
}
