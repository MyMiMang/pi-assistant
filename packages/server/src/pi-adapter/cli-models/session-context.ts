/** 原生 ACP 会话的宿主上下文与展示事件；不参与 Pi 工具执行。 */
export interface NativeToolEvent {
	type: "native_tool";
	id: string;
	title: string;
	status: "pending" | "in_progress" | "completed" | "failed";
	kind?: string;
	content?: unknown[];
	rawInput?: unknown;
	rawOutput?: unknown;
	locations?: unknown[];
}

export interface NativeSessionContext {
	workspace: string;
	requestPermission(params: unknown): Promise<string | undefined>;
	isPaused(): boolean;
	isWaitingForApproval?(): boolean;
	cancelPending?(): void;
	onPause(callback: () => void): () => void;
}

const contexts = new Map<string, NativeSessionContext>();
const cleanups = new Map<string, Set<() => void>>();

export function addNativeSessionCleanup(key: string, cleanup: () => void): () => void {
	let set = cleanups.get(key);
	if (!set) cleanups.set(key, set = new Set());
	set.add(cleanup);
	return () => { set.delete(cleanup); };
}

export function releaseNativeSessionContext(key: string): void {
	for (const cleanup of cleanups.get(key) ?? []) cleanup();
	cleanups.delete(key);
	contexts.delete(key);
	listeners.delete(key);
}
const listeners = new Map<string, Set<(event: NativeToolEvent) => void>>();

export function registerNativeSessionContext(key: string, context: NativeSessionContext): () => void {
	contexts.set(key, context);
	return () => {
		if (contexts.get(key) === context) contexts.delete(key);
	};
}

export const getNativeSessionContext = (key: string | undefined) => key ? contexts.get(key) : undefined;

export function subscribeNativeTools(key: string, callback: (event: NativeToolEvent) => void): () => void {
	let set = listeners.get(key);
	if (!set) listeners.set(key, set = new Set());
	set.add(callback);
	return () => {
		set.delete(callback);
		if (!set.size) listeners.delete(key);
	};
}

export function emitNativeTool(key: string, event: NativeToolEvent): void {
	for (const callback of listeners.get(key) ?? []) callback(event);
}

/** 使用公开 provider hook；native 标题附在真实 assistant 消息上，由 Pi 原样持久化。 */
export function attachNativeTools(session: {
	sessionId: string;
	agent: { onProviderStreamEvent?: (data: unknown, model: any) => void | Promise<void> };
	subscribe(callback: (event: any) => void): () => void;
}): () => void {
	const previous = session.agent.onProviderStreamEvent;
	const titles = new Map<string, string>();
	const calls = new Map<string, NativeToolEvent>();
	const hook = async (data: unknown, model: any) => {
		await previous?.(data, model);
		const patch = data as (Partial<NativeToolEvent> & { runId?: string }) | null;
		if (patch?.type !== "native_tool" || typeof patch.id !== "string") return;
		const id = patch.runId ? `${patch.runId}:${patch.id}` : patch.id;
		const previousCall = calls.get(id);
		const event: NativeToolEvent = { title: "工具操作", status: "pending", ...previousCall, ...patch, id, type: "native_tool" };
		if (previousCall?.status === "completed" || previousCall?.status === "failed") event.status = previousCall.status;
		calls.set(id, event);
		if (event.status === "completed" || event.status === "failed") titles.set(id, `${event.status === "completed" ? "成功" : "失败"}：${event.title}`);
		emitNativeTool(session.sessionId, event);
	};
	session.agent.onProviderStreamEvent = hook;
	const off = session.subscribe((event) => {
		if (event.type === "message_end" && event.message?.role === "assistant" && titles.size) {
			event.message.nativeToolTitles = [...titles.values()];
			titles.clear();
		}
		if (event.type === "agent_settled") {
			titles.clear();
			calls.clear();
		}
	});
	return () => {
		off();
		titles.clear();
		calls.clear();
		if (session.agent.onProviderStreamEvent === hook) session.agent.onProviderStreamEvent = previous;
	};
}
