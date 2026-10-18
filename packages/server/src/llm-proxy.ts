/**
 * 本机 OpenAI 兼容模型网关（只给我们自己拉起的附属进程用，例如 Hindsight）。
 *  - 只监听 127.0.0.1，端口随机；令牌每次启动随机生成，不落盘（附属进程每次随服务重启拿新令牌）
 *  - 背后走 Pi 的模型接口：用户在向导/设置里配置的任何渠道（含自定义中转站、订阅登录）都能用，密钥不出我们的进程
 *  - 支持 /v1/models、/v1/chat/completions（非流式 + 流式 SSE、tools/tool_calls、response_format=json_object/json_schema）
 *  - model 字段：`<provider>/<modelId>`，或别名（如 "memory"），别名由调用方注册
 * 不挂在主 HTTP 服务上：远程隧道只转发主端口，这个网关永远到不了外网。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ChatMessage, ChatRequest, ChatResult } from "./pi-adapter/index.ts";

export interface ProxyBackend {
	complete(provider: string, model: string, req: ChatRequest): Promise<ChatResult>;
	listModels(): { provider: string; id: string }[];
}

type OAContent = string | { type: string; text?: string }[] | null | undefined;
interface OAMessage {
	role: "system" | "developer" | "user" | "assistant" | "tool";
	content?: OAContent;
	tool_calls?: { id: string; type?: string; function: { name: string; arguments: string } }[];
	tool_call_id?: string;
	name?: string;
}
interface OARequest {
	model: string;
	messages: OAMessage[];
	tools?: { type: string; function: { name: string; description?: string; parameters?: Record<string, unknown> } }[];
	tool_choice?: unknown;
	response_format?: { type: "text" | "json_object" | "json_schema"; json_schema?: { name?: string; schema?: unknown } };
	max_tokens?: number;
	max_completion_tokens?: number;
	temperature?: number;
	stream?: boolean;
}

const textOf = (c: OAContent) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : "");

/** 从模型输出里取出 JSON：去掉 ```json 围栏、前后说明文字 */
export function extractJson(text: string): string {
	const t = text.trim();
	try {
		JSON.parse(t);
		return t;
	} catch {
		/* 继续尝试 */
	}
	const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) {
		try {
			JSON.parse(fence[1].trim());
			return fence[1].trim();
		} catch {
			/* 继续 */
		}
	}
	for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
		const a = t.indexOf(open);
		const b = t.lastIndexOf(close);
		if (a >= 0 && b > a) {
			const s = t.slice(a, b + 1);
			try {
				JSON.parse(s);
				return s;
			} catch {
				/* 下一个 */
			}
		}
	}
	return t;
}

/** OpenAI 请求 → 中性 ChatRequest */
export function toChatRequest(body: OARequest): ChatRequest {
	const sys: string[] = [];
	const messages: ChatMessage[] = [];
	const names = new Map<string, string>();
	for (const m of body.messages ?? []) {
		if (m.role === "system" || m.role === "developer") sys.push(textOf(m.content));
		else if (m.role === "user") messages.push({ role: "user", text: textOf(m.content) });
		else if (m.role === "assistant") {
			const calls = (m.tool_calls ?? []).map((c) => {
				names.set(c.id, c.function.name);
				let args: Record<string, unknown> = {};
				try {
					args = JSON.parse(c.function.arguments || "{}");
				} catch {
					args = { _raw: c.function.arguments };
				}
				return { id: c.id, name: c.function.name, arguments: args };
			});
			messages.push({ role: "assistant", text: textOf(m.content), toolCalls: calls.length ? calls : undefined });
		} else if (m.role === "tool") messages.push({ role: "tool", toolCallId: m.tool_call_id ?? "", name: m.name ?? names.get(m.tool_call_id ?? "") ?? "tool", text: textOf(m.content) });
	}
	const rf = body.response_format;
	if (rf?.type === "json_object") sys.push("只输出一个合法的 JSON 对象，不要任何解释、不要 Markdown 代码块。");
	if (rf?.type === "json_schema") sys.push(`只输出一个符合下面 JSON Schema 的 JSON 对象，不要任何解释、不要 Markdown 代码块：\n${JSON.stringify(rf.json_schema?.schema ?? {})}`);
	// Pi 只支持 auto/none：强制调用某个工具时用提示词约束
	const tc = body.tool_choice as { type?: string; function?: { name?: string } } | string | undefined;
	let tools = body.tools?.filter((t) => t.type === "function").map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters }));
	if (tc === "none") tools = undefined;
	else if (tc === "required") sys.push("你必须调用一个工具。");
	else if (typeof tc === "object" && tc?.function?.name) {
		// 强制调用指定工具：只把这个工具给模型，并在提示词里要求（Pi 的 toolChoice 只有 auto/none）
		const forced = tc.function.name;
		tools = tools?.filter((t) => t.name === forced);
		sys.push(`你必须调用工具 ${forced}。`);
	}
	return {
		systemPrompt: sys.filter(Boolean).join("\n\n") || undefined,
		messages,
		tools: tools?.length ? tools : undefined,
		maxTokens: body.max_completion_tokens ?? body.max_tokens,
		temperature: body.temperature,
	};
}

type ModelRef = { provider: string; id: string };
/** 请求的用途（按请求形状判断，Hindsight 不告诉我们）：带工具 = 反思；要 JSON = 抽取/整理；其他 = 文本 */
export type ProxyScope = "reflect" | "extract" | "text";
export const scopeOf = (b: Pick<OARequest, "tools" | "response_format">): ProxyScope => (b.tools?.length ? "reflect" : b.response_format?.type === "json_object" || b.response_format?.type === "json_schema" ? "extract" : "text");
/** 一次上游调用的结果（给健康状态用） */
export interface ProxyResult {
	alias: string | null;
	scope: ProxyScope;
	model: string;
	ok: boolean;
	ms: number;
	error?: string;
	/** 这次是因为前面的模型失败才轮到它 */
	fallback: boolean;
}
const FAIL_STREAK = 3;
const COOLDOWN_MS = 10 * 60_000;
const THINKING_CACHE = 500;

export class LlmProxy {
	private server: Server | null = null;
	readonly token = randomBytes(24).toString("base64url");
	private aliases = new Map<string, () => ModelRef | ModelRef[] | null>();
	port = 0;
	/** 统计（设置页展示用量；errors 按用途分开，带最近一次错误） */
	stats = { requests: 0, errors: 0, input: 0, output: 0, scopes: {} as Partial<Record<ProxyScope, { requests: number; errors: number; lastError?: string; lastErrorAt?: number }>> };
	/** 每次上游调用后回调（健康状态订阅） */
	onResult: ((r: ProxyResult) => void) | null = null;
	/** 模型连续失败次数 / 冷却到期时间：主模型连续失败就先用备用模型，冷却过后再试主模型 */
	private fails = new Map<string, { streak: number; until: number }>();
	/** 思考块按工具调用 id 存着：上游思考模式要求下一轮把思考原样带回，Hindsight 不会回传，由网关补上（只补给同一个模型） */
	private thinking = new Map<string, { model: string; blocks: unknown[] }>();

	constructor(private backend: ProxyBackend) {}

	get baseUrl() {
		return `http://127.0.0.1:${this.port}/v1`;
	}
	/** 注册别名，例如 "memory" → 设置里选的记忆模型 + 备用模型（每次请求时解析，换模型不用重启附属进程） */
	alias(name: string, resolve: () => ModelRef | ModelRef[] | null) {
		this.aliases.set(name, resolve);
	}
	/** 按顺序要尝试的模型（别名可带备用模型） */
	chain(model: string): ModelRef[] {
		const a = this.aliases.get(model);
		if (a) {
			const r = a();
			return (Array.isArray(r) ? r : r ? [r] : []).filter((m, i, l) => l.findIndex((x) => x.provider === m.provider && x.id === m.id) === i);
		}
		const i = model.indexOf("/");
		return i > 0 ? [{ provider: model.slice(0, i), id: model.slice(i + 1) }] : [];
	}
	resolve(model: string) {
		return this.chain(model)[0] ?? null;
	}
	/** 冷却中的模型排到后面（全都在冷却就按原顺序） */
	private order(list: ModelRef[]) {
		const now = Date.now();
		const cool = (m: ModelRef) => (this.fails.get(`${m.provider}/${m.id}`)?.until ?? 0) > now;
		return [...list.filter((m) => !cool(m)), ...list.filter(cool)];
	}
	private mark(model: string, ok: boolean) {
		if (ok) return void this.fails.delete(model);
		const f = this.fails.get(model) ?? { streak: 0, until: 0 };
		f.streak++;
		if (f.streak >= FAIL_STREAK) f.until = Date.now() + COOLDOWN_MS;
		this.fails.set(model, f);
	}
	private rememberThinking(model: string, toolCallIds: string[], blocks: unknown[] | undefined) {
		if (!blocks?.length) return;
		for (const id of toolCallIds) this.thinking.set(id, { model, blocks });
		while (this.thinking.size > THINKING_CACHE) this.thinking.delete(this.thinking.keys().next().value!);
	}
	private withThinking(chat: ChatRequest, model: string): ChatRequest {
		const messages = chat.messages.map((m) => {
			if (m.role !== "assistant" || !m.toolCalls?.length) return m;
			const t = this.thinking.get(m.toolCalls[0].id);
			return t && t.model === model ? { ...m, thinking: t.blocks } : m;
		});
		return { ...chat, messages };
	}

	async start(port = 0) {
		if (this.server) return this;
		this.server = createServer((req, res) => void this.handle(req, res).catch((e) => this.fail(res, 500, e instanceof Error ? e.message : String(e))));
		await new Promise<void>((ok, bad) => {
			this.server!.once("error", bad);
			this.server!.listen(port, "127.0.0.1", () => ok());
		});
		this.port = (this.server.address() as { port: number }).port;
		return this;
	}
	async stop() {
		const s = this.server;
		this.server = null;
		if (s) await new Promise<void>((ok) => s.close(() => ok()));
	}

	private authorized(req: IncomingMessage) {
		const h = req.headers.authorization ?? "";
		const got = Buffer.from(h.replace(/^Bearer\s+/i, ""));
		const want = Buffer.from(this.token);
		return got.length === want.length && timingSafeEqual(got, want);
	}
	private fail(res: ServerResponse, status: number, message: string) {
		if (res.headersSent) return res.end();
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message, type: status === 401 ? "invalid_api_key" : "server_error" } }));
	}

	private async handle(req: IncomingMessage, res: ServerResponse) {
		// 只接受本机回环连接（双保险：已经只监听 127.0.0.1）
		const ra = req.socket.remoteAddress ?? "";
		if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ra)) return this.fail(res, 403, "forbidden");
		if (!this.authorized(req)) return this.fail(res, 401, "Invalid API key");
		const url = (req.url ?? "").split("?")[0].replace(/\/+$/, "");
		if (req.method === "GET" && url === "/v1/models") {
			const data = [...[...this.aliases.keys()].map((id) => ({ id, object: "model", owned_by: "pi-assistant" })), ...this.backend.listModels().map((m) => ({ id: `${m.provider}/${m.id}`, object: "model", owned_by: m.provider }))];
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ object: "list", data }));
		}
		if (req.method !== "POST" || url !== "/v1/chat/completions") return this.fail(res, 404, "not found");
		let raw = "";
		for await (const c of req) {
			raw += c;
			if (raw.length > 16 * 1024 * 1024) return this.fail(res, 413, "request too large");
		}
		let body: OARequest;
		try {
			body = JSON.parse(raw);
		} catch {
			return this.fail(res, 400, "invalid json");
		}
		if (process.env.PIA_PROXY_LOG) (await import("node:fs")).appendFileSync(process.env.PIA_PROXY_LOG, `${JSON.stringify(body)}\n`);
		const targets = this.order(this.chain(body.model ?? ""));
		if (!targets.length) return this.fail(res, 400, `未配置模型：${body.model}（请在设置里选择记忆用模型）`);
		const alias = this.aliases.has(body.model) ? body.model : null;
		const ac = new AbortController();
		res.on("close", () => ac.abort());
		const chat = toChatRequest(body);
		const scope = scopeOf(body);
		const sc = (this.stats.scopes[scope] ??= { requests: 0, errors: 0 });
		this.stats.requests++;
		sc.requests++;
		let r: ChatResult | null = null;
		let used = "";
		// 别名上的内部调用（记忆）：思考能关就关；失败就按顺序换下一个模型（同一个请求内）
		for (const [i, t] of targets.entries()) {
			used = `${t.provider}/${t.id}`;
			const t0 = Date.now();
			r = await this.backend.complete(t.provider, t.id, { ...this.withThinking(chat, used), ...(alias ? { reasoning: "lowest" as const } : {}), signal: ac.signal });
			this.stats.input += r.usage.input;
			this.stats.output += r.usage.output;
			const ok = r.stopReason !== "error";
			if (ac.signal.aborted) return;
			this.mark(used, ok);
			this.onResult?.({ alias, scope, model: used, ok, ms: Date.now() - t0, error: ok ? undefined : r.error, fallback: i > 0 });
			if (ok) break;
		}
		if (!r || r.stopReason === "error") {
			this.stats.errors++;
			sc.errors++;
			sc.lastError = (r?.error ?? "upstream error").slice(0, 300);
			sc.lastErrorAt = Date.now();
			return this.fail(res, 502, r?.error ?? "upstream error");
		}
		this.rememberThinking(used, r.toolCalls.map((c) => c.id), r.thinking);
		const wantsJson = body.response_format?.type === "json_object" || body.response_format?.type === "json_schema";
		const content = wantsJson && !r.toolCalls.length ? extractJson(r.text) : r.text;
		const finish = r.toolCalls.length ? "tool_calls" : r.stopReason === "length" ? "length" : "stop";
		const tool_calls = r.toolCalls.length ? r.toolCalls.map((c, i) => ({ index: i, id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) : undefined;
		const id = `chatcmpl-${randomBytes(8).toString("hex")}`;
		const created = Math.floor(Date.now() / 1000);
		const usage = { prompt_tokens: r.usage.input, completion_tokens: r.usage.output, total_tokens: r.usage.input + r.usage.output };
		if (body.stream) {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
			send({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: content || (tool_calls ? null : "") , ...(tool_calls ? { tool_calls } : {}) }, finish_reason: null }] });
			send({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage });
			res.write("data: [DONE]\n\n");
			return res.end();
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ id, object: "chat.completion", created, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: tool_calls && !content ? null : content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: finish }], usage }));
	}
}

let instance: LlmProxy | null = null;
/** 服务内单例：首次使用时启动 */
export async function llmProxy(): Promise<LlmProxy> {
	if (instance) return instance;
	const { models } = await import("./models.ts");
	instance = new LlmProxy({ complete: (p, m, r) => models.complete(p, m, r), listModels: () => models.listModels().map((m) => ({ provider: m.provider, id: m.id })) });
	await instance.start();
	return instance;
}
export async function stopLlmProxy() {
	await instance?.stop();
	instance = null;
}
