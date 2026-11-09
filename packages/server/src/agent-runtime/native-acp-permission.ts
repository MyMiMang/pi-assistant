/** 原生 ACP 的权限请求复用 Pi 审批入口；只返回工具提供的一次性选项。 */
import { credentialAccessDenied } from "@pi-assistant/ext-approval";
import { isAbsolute, resolve } from "node:path";
import { bus } from "../bus.ts";
import { db } from "../db.ts";
import { hostFileAccess, hostPaused } from "../host-control.ts";
import { requests } from "../requests.ts";
import type { NativeSessionContext } from "../pi-adapter/cli-models/session-context.ts";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function nativePermissionInput(params: unknown, workspace: string) {
	const request = object(params);
	const call = object(request.toolCall);
	const input = object(call.rawInput);
	const paths: string[] = [];
	for (const value of [input.path, input.file_path, input.filePath, ...(Array.isArray(call.locations) ? call.locations.map((location) => object(location).path) : [])]) {
		if (typeof value === "string") paths.push(isAbsolute(value) ? value : resolve(workspace, value));
	}
	return {
		call,
		paths,
		command: typeof input.command === "string" ? input.command : undefined,
		options: (Array.isArray(request.options) ? request.options : []).map(object),
	};
}

export function createNativePermissionContext(input: {
	agentId: string;
	conversationId: string | null;
	taskId: string | null;
	workspace: string;
}): { context: NativeSessionContext; dispose(): void } {
	const pending = new Set<AbortController>();
	const pauseListeners = new Set<() => void>();
	const off = bus.on((event) => {
		if (event.type !== "host.changed" || !hostPaused()) return;
		for (const controller of pending) controller.abort();
		for (const callback of pauseListeners) callback();
	});
	return {
		context: {
			workspace: input.workspace,
			isPaused: hostPaused,
			isWaitingForApproval: () => !!db.prepare("SELECT 1 FROM requests WHERE kind = 'approval' AND status = 'pending' AND conversation_id IS ? AND agent_id = ? LIMIT 1").get(input.conversationId, input.agentId),
			cancelPending() {
				for (const controller of pending) controller.abort();
			},
			onPause(callback) {
				pauseListeners.add(callback);
				return () => { pauseListeners.delete(callback); };
			},
			async requestPermission(params) {
				const { call, paths, command, options } = nativePermissionInput(params, input.workspace);
				const option = (kind: string) => options.find((entry) => entry.kind === kind && typeof entry.optionId === "string")?.optionId as string | undefined;
				const reject = option("reject_once");
				const allow = option("allow_once");
				if (hostPaused() || credentialAccessDenied({ paths, command }) || !allow || !reject) return reject;
				if (hostFileAccess(input.agentId)) return allow;
				const controller = new AbortController();
				pending.add(controller);
				try {
					const answer = await requests.approval(input.agentId, input.taskId, "native_acp", { paths, ...(command ? { command } : {}) }, String(call.title ?? "工具操作").slice(0, 400), "medium", input.conversationId, { signal: controller.signal });
					return answer.approved && !hostPaused() && !controller.signal.aborted ? allow : reject;
				} finally {
					pending.delete(controller);
				}
			},
		},
		dispose() {
			off();
			for (const controller of pending) controller.abort();
			pending.clear();
			pauseListeners.clear();
		},
	};
}
