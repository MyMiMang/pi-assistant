/**
 * 一个地址同时提供多种协议的中转（「接口格式：自动」）：按模型名识别每个模型走哪种协议，
 * 并从同一个 Base URL 推出各协议的路径；用户可以在模型设置里改协议、在高级里为某个协议单独填地址。
 * 只决定写进 Pi models.json 的每模型 `api` / `baseUrl`（Pi 原生支持按模型覆盖），不改 Pi。
 */
export const AUTO_API = "auto";
/** 自动模式下实际会用到的三种协议 */
export const RELAY_APIS = ["openai-completions", "anthropic-messages", "google-generative-ai"] as const;

/** 按模型名猜协议：claude-* → Anthropic Messages，gemini-* → Gemini，其他 → OpenAI 兼容 */
export function guessApi(modelId: string): string {
	const id = modelId.toLowerCase().replace(/^.*\//, "");
	if (id.startsWith("claude")) return "anthropic-messages";
	if (id.startsWith("gemini")) return "google-generative-ai";
	return "openai-completions";
}

/** 去掉常见的协议后缀，得到中转根地址：…/v1、…/v1beta、…/anthropic、…/openai 都回到根 */
export function relayRoot(baseUrl: string): string {
	let u = baseUrl.trim().replace(/\/+$/, "");
	for (;;) {
		const next = u.replace(/\/(v1beta|v1|anthropic|openai|gemini)$/i, "");
		if (next === u) return u;
		u = next;
	}
}

/** 某个协议在这个中转上的地址：先看用户单独填的，再按协议从根地址推（OpenAI → /v1，Anthropic → 根，Gemini → /v1beta） */
export function protocolBaseUrl(baseUrl: string, api: string, overrides?: Record<string, string>): string {
	const o = overrides?.[api]?.trim();
	if (o) return o.replace(/\/+$/, "");
	const root = relayRoot(baseUrl);
	if (api === "anthropic-messages") return root;
	if (api.startsWith("google")) return `${root}/v1beta`;
	return `${root}/v1`;
}

/** 模型实际走的协议：非自动模式就是服务的协议；自动模式下用户改过的优先，否则按名字猜 */
export function effectiveApi(meta: { api: string }, m: { id: string; api?: string }): string {
	if (meta.api !== AUTO_API) return meta.api;
	return m.api || guessApi(m.id);
}

/** 模型实际请求的地址 */
export function effectiveBaseUrl(meta: { api: string; baseUrl: string; protocolUrls?: Record<string, string> }, m: { id: string; api?: string }): string {
	if (meta.api !== AUTO_API) return meta.baseUrl;
	return protocolBaseUrl(meta.baseUrl, effectiveApi(meta, m), meta.protocolUrls);
}

/** 从地址猜接口格式和名称（新建时预填，用户可改） */
export function guessFromUrl(url: string): { api?: string; name?: string } {
	let u: URL;
	try {
		u = new URL(url.trim());
	} catch {
		return {};
	}
	const host = u.hostname.replace(/^(www|api)\./, "");
	const path = u.pathname.toLowerCase();
	const api = /anthropic/.test(host + path) ? "anthropic-messages" : /generativelanguage|gemini|\/v1beta/.test(host + path) ? "google-generative-ai" : "openai-completions";
	const label = host.split(".").slice(-2, -1)[0] || host;
	return { api, name: /^\d+$/.test(label) || host === "localhost" ? "本地服务" : label.charAt(0).toUpperCase() + label.slice(1) };
}
