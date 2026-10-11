/**
 * 把 Pi 的通用登录交互（AuthInteraction：prompt/notify）桥接到 Web UI。
 * 任何 provider 的 API Key / 订阅 OAuth / 设备码登录都走同一条通道，Pi 新增登录方式无需改这里。
 */
import { bus } from "./bus.ts";
import { uid } from "./db.ts";
import { models } from "./models.ts";
import type { LoginPrompt } from "./pi-adapter/index.ts";

interface Flow {
	id: string;
	providerId: string;
	controller: AbortController;
	waiting: { promptId: string; resolve: (v: string) => void; reject: (e: Error) => void } | null;
	log: unknown[];
}
const flows = new Map<string, Flow>();

export function startLogin(providerId: string, type: "api_key" | "oauth") {
	const flow: Flow = { id: uid("login"), providerId, controller: new AbortController(), waiting: null, log: [] };
	flows.set(flow.id, flow);
	const push = (ev: Record<string, unknown>) => {
		flow.log.push(ev);
		bus.emit({ type: "login.event", flowId: flow.id, providerId, event: ev });
	};
	models
		.login(providerId, type, {
			signal: flow.controller.signal,
			prompt: (p: LoginPrompt) =>
				new Promise<string>((resolve, reject) => {
					const promptId = uid("p");
					flow.waiting = { promptId, resolve, reject };
					// secret 类提示的回答不会写入日志/事件
					push({ kind: "prompt", promptId, prompt: p });
				}),
			notify: (e) => push({ kind: "notify", event: e }),
		})
		.then(() => push({ kind: "done", ok: true }))
		.catch((e: unknown) => push({ kind: "done", ok: false, error: e instanceof Error ? e.message : String(e) }))
		.finally(() => setTimeout(() => flows.delete(flow.id), 60_000));
	return flow.id;
}

export function answerLogin(flowId: string, promptId: string, value: string) {
	const f = flows.get(flowId);
	if (!f?.waiting || f.waiting.promptId !== promptId) return false;
	const w = f.waiting;
	f.waiting = null;
	w.resolve(value);
	return true;
}
export function cancelLogin(flowId: string) {
	const f = flows.get(flowId);
	if (!f) return false;
	f.controller.abort();
	f.waiting?.reject(new Error("已取消"));
	return true;
}
export const loginLog = (flowId: string) => flows.get(flowId)?.log ?? [];
