/**
 * 快速操作模型的选择器适配器实现。
 *
 * - `systemone`：原生 TypeSafe Jev System One 协议（`POST {baseURL}/v1/systemone`）。
 *   baseURL 可自定义：官方 `https://api.typesafe.ai`、OpenRouter `https://openrouter.ai/api`、
 *   或用户自建原生中转（按 System One JSON 原样转发）。这是**真 Jev**，有原生校准概率。
 * - `chat`：OpenAI 兼容快模型（复用现有 `models.complete`）。这是**替代，不是 Jev**：
 *   拿不到原生校准概率，**绝不合成 / 编造 confidence**，一律要求独立结果验证、边界保守。
 * - `mock`：测试用，确定性、无网络、无费用、无 Key。
 */
import type { FastActionChooser, FastChoiceRequest, FastChoiceResult } from "./types.ts";

/** 候选上限：Jev 32（S1 26）；我们统一取 32，保持有界。 */
export const MAX_FAST_CANDIDATES = 32;

const trimSlash = (s: string) => s.replace(/\/+$/, "");

// ---------------------------------------------------------------- SystemOne（原生 Jev）

export interface SystemOneChooserConfig {
	baseUrl: string;
	model: string;
	apiKey: string;
	/** 测试注入；默认用全局 fetch */
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

interface SystemOneAnswer {
	type?: string;
	choice?: unknown;
	confidence?: unknown;
	probabilities?: unknown;
}

/**
 * 解析 System One 响应里的 `choice` 问题。只接受有限、0–1 的概率；
 * 并列最高分视为不可执行（返回 tie，让调用方回主模型）。
 */
export function parseSystemOneChoice(raw: unknown, candidateIds: string[]): FastChoiceResult {
	const body = raw as { answers?: Record<string, SystemOneAnswer>; usage?: { input_tokens?: number; output_tokens?: number }; model?: string } | null;
	const ans = body?.answers?.pick;
	const usage = { input: Number(body?.usage?.input_tokens ?? 0) || 0, output: Number(body?.usage?.output_tokens ?? 0) || 0 };
	const model = typeof body?.model === "string" ? body.model : undefined;
	if (!ans || ans.type !== "choice") return { kind: "error", error: "SystemOne 响应缺少 choice 答案", usage, model };
	const choice = typeof ans.choice === "string" ? ans.choice : "";
	if (!choice) return { kind: "abstain", reason: "SystemOne 未给出 choice", usage, model };
	if (!candidateIds.includes(choice)) return { kind: "error", error: `SystemOne 选出的 id 不在候选集合：${choice}`, usage, model };
	const probs = normalizeProbabilities(ans.probabilities, candidateIds);
	const confidence = finite01(ans.confidence);
	// 并列最高分不可执行（照 cua decision-models.md）
	if (probs) {
		const top = Math.max(...Object.values(probs));
		const tied = Object.entries(probs).filter(([, v]) => Math.abs(v - top) < 1e-9);
		if (tied.length > 1) return { kind: "abstain", reason: "候选概率并列最高，不可执行", usage, model };
	}
	return { kind: "selected", candidateId: choice, confidence, probabilities: probs, usage, model };
}

/** 只保留候选集合内、有限且 0–1 的概率；有任何非法值就整体丢弃（不部分信任）。 */
function normalizeProbabilities(raw: unknown, candidateIds: string[]): Record<string, number> | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const out: Record<string, number> = {};
	for (const id of candidateIds) {
		const v = (raw as Record<string, unknown>)[id];
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) return undefined;
		out[id] = v;
	}
	return Object.keys(out).length ? out : undefined;
}

const finite01 = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined);

export function createSystemOneChooser(cfg: SystemOneChooserConfig): FastActionChooser {
	const doFetch = cfg.fetchImpl ?? fetch;
	return {
		id: "systemone",
		label: "Jev（原生 SystemOne）",
		nativeProbability: true,
		async choose(req: FastChoiceRequest, signal?: AbortSignal): Promise<FastChoiceResult> {
			const criteria: Record<string, string> = {};
			for (const c of req.candidates) criteria[c.id] = c.label;
			const body = {
				state: req.goal,
				model: cfg.model,
				questions: {
					pick: {
						type: "choice",
						instructions: `从候选里选出最符合目标的一个 id，只能选候选集合里的 id（capture ${req.captureId}）。`,
						criteria,
					},
				},
			};
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), cfg.timeoutMs ?? 4000);
			signal?.addEventListener("abort", () => ac.abort(), { once: true });
			try {
				const res = await doFetch(`${trimSlash(cfg.baseUrl)}/v1/systemone`, {
					method: "POST",
					headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
					body: JSON.stringify(body),
					signal: ac.signal,
				});
				if (!res.ok) return { kind: "error", error: `SystemOne HTTP ${res.status}` };
				return parseSystemOneChoice(await res.json(), req.candidates.map((c) => c.id));
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return { kind: "error", error: /abort/i.test(msg) ? "timeout" : msg };
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

// ---------------------------------------------------------------- chat（OpenAI 兼容替代，不是 Jev）

export interface ChatChooserConfig {
	provider: string;
	id: string;
	/** 注入 `models.complete`（避免核心模块直接依赖单例，便于测试） */
	complete: (provider: string, model: string, req: { messages: { role: "user"; text: string }[]; maxTokens?: number; temperature?: number; signal?: AbortSignal }) => Promise<{ text: string; error?: string; usage?: { input: number; output: number } }>;
	timeoutMs?: number;
	/** 展示名（默认带「替代」字样，绝不假称 Jev） */
	label?: string;
}

/**
 * 从 chat 返回的文本里抽出候选 id。**不接受任何 confidence / probabilities**：
 * 通用 chat 无法给校准概率，合成一个数字当过阈值是禁止的。
 */
export function parseChatChoice(text: string, candidateIds: string[]): FastChoiceResult {
	let obj: unknown;
	try {
		const m = text.match(/\{[\s\S]*\}/);
		obj = JSON.parse(m ? m[0] : text);
	} catch {
		return { kind: "error", error: "快速模型返回不是合法 JSON" };
	}
	const o = obj as { id?: unknown; abstain?: unknown; reason?: unknown };
	if (o?.abstain === true) return { kind: "abstain", reason: typeof o.reason === "string" ? o.reason : "快速模型选择放弃" };
	const id = typeof o?.id === "string" ? o.id : "";
	if (!id) return { kind: "error", error: "快速模型没有给出 id" };
	if (!candidateIds.includes(id)) return { kind: "error", error: `快速模型选出的 id 不在候选集合：${id}` };
	// 注意：这里刻意不带 confidence —— chat 替代没有原生校准概率。
	return { kind: "selected", candidateId: id, reason: typeof o.reason === "string" ? o.reason : undefined };
}

export function createChatChooser(cfg: ChatChooserConfig): FastActionChooser {
	return {
		id: "chat",
		label: cfg.label ?? "快速模型（OpenAI 兼容替代，非 Jev）",
		nativeProbability: false,
		async choose(req: FastChoiceRequest, signal?: AbortSignal): Promise<FastChoiceResult> {
			const list = req.candidates.map((c) => `- ${c.id}: ${c.label}`).join("\n");
			const prompt = `目标：${req.goal}\n\n候选（只能选其中一个 id）：\n${list}\n\n只输出 JSON：{"id":"<候选id>"}；拿不准就输出 {"abstain":true,"reason":"..."}。不要输出任何概率或 confidence。`;
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), cfg.timeoutMs ?? 4000);
			signal?.addEventListener("abort", () => ac.abort(), { once: true });
			try {
				const r = await cfg.complete(cfg.provider, cfg.id, { messages: [{ role: "user", text: prompt }], maxTokens: 128, temperature: 0, signal: ac.signal });
				if (r.error) return { kind: "error", error: r.error, usage: r.usage };
				const parsed = parseChatChoice(r.text, req.candidates.map((c) => c.id));
				return { ...parsed, usage: r.usage, model: `${cfg.provider}/${cfg.id}` };
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return { kind: "error", error: /abort/i.test(msg) ? "timeout" : msg };
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

// ---------------------------------------------------------------- mock（测试）

export function createMockChooser(respond: (req: FastChoiceRequest) => FastChoiceResult, opts: { nativeProbability?: boolean; id?: string } = {}): FastActionChooser {
	return {
		id: opts.id ?? "mock",
		label: "Mock 快速模型",
		nativeProbability: opts.nativeProbability ?? true,
		async choose(req) {
			return respond(req);
		},
	};
}
