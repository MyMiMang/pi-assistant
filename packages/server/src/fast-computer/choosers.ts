/**
 * 快速操作模型的选择器适配器实现。
 *
 * - `systemone`：原生 TypeSafe Jev System One **分类器**（真 Jev，有原生校准概率）。
 *   经 Pi 的 provider 目录选模型（`PiModels.classify`，按所选 provider 绑定 baseURL/headers/key），
 *   不自建 key resolver、不读全局 env key、不直接发 HTTP。候选走离散 choice 问题，答案必须是候选 id。
 * - `chat`：OpenAI 兼容快模型（复用现有 `models.complete`）。这是**替代，不是 Jev**：
 *   拿不到原生校准概率，**绝不合成 / 编造 confidence**，一律要求独立结果验证、边界保守。
 * - `mock`：测试用，确定性、无网络、无费用、无 Key。
 */
import type { ClassifierContext, ClassifierOutcome } from "../pi-adapter/index.ts";
import type { FastActionChooser, FastChoiceRequest, FastChoiceResult } from "./types.ts";

/** 候选上限：Jev 32（S1 26）；我们统一取 32，保持有界。 */
export const MAX_FAST_CANDIDATES = 32;

// ---------------------------------------------------------------- SystemOne（原生 Jev 分类器）

export interface ClassifierChooserConfig {
	/** 用户所选的 classifier provider（来自 Pi 的 classifier 目录） */
	provider: string;
	/** 该 provider 下的 classifier 模型 id（如 `jev-latest`、`typesafe/jev-1.13`） */
	model: string;
	/** 注入 `PiModels.classify`（provider-bound 鉴权，key 不经过这里） */
	classify: (provider: string, model: string, context: ClassifierContext, opts?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<ClassifierOutcome>;
	timeoutMs?: number;
	/** 展示名（默认带「原生」字样） */
	label?: string;
}

/**
 * 解析分类器返回的 choice 答案。
 *
 * 安全不变量：
 *  - 只接受候选集合内的 id；越界一律 error，不派发；
 *  - confidence 必须是有限 0–1，缺失 / 非法一律 abstain（unknown），**绝不合成**；
 *  - probabilities 缺失 / 非法只丢概率（不做并列判断），也**绝不合成**；
 *  - 并列最高分不可执行（照 cua decision-models.md）。
 */
export function parseClassifierChoice(outcome: ClassifierOutcome, candidateIds: string[]): FastChoiceResult {
	const usage = outcome.usage ? { input: outcome.usage.input, output: outcome.usage.output } : undefined;
	const model = outcome.model ? `${outcome.provider}/${outcome.model}` : outcome.provider;
	if (outcome.stopReason !== "stop") {
		const aborted = outcome.stopReason === "aborted";
		return { kind: "error", error: outcome.errorMessage || (aborted ? "timeout" : "分类器请求失败"), usage, model };
	}
	const ans = outcome.answers?.pick;
	if (!ans || ans.type !== "choice") return { kind: "error", error: "分类器没有返回 choice 答案", usage, model };
	const choice = typeof ans.choice === "string" ? ans.choice : "";
	if (!choice) return { kind: "abstain", reason: "分类器未给出 choice", usage, model };
	if (!candidateIds.includes(choice)) return { kind: "error", error: `分类器选出的 id 不在候选集合：${choice}`, usage, model };
	// 严格置信度：必须是有限 0–1；缺失 / 非法 → unknown，交给主模型，不合成。
	const confidence = finite01(ans.confidence);
	if (confidence === undefined) return { kind: "abstain", reason: "分类器未给出可用的置信度（unknown），不合成", usage, model };
	const probs = normalizeProbabilities(ans.probabilities, candidateIds);
	// 并列最高分不可执行（照 cua decision-models.md）；概率缺失时无法判断并列，只按 confidence 走。
	if (probs) {
		const top = Math.max(...Object.values(probs));
		const tied = Object.entries(probs).filter(([, v]) => Math.abs(v - top) < 1e-9);
		if (tied.length > 1) return { kind: "abstain", reason: "候选概率并列最高，不可执行", usage, model };
		// choice 必须**唯一**最高：否则阈值会拿另一个候选的概率给这个答案放行（例如 wire 选了低概率的 b，
		// 却用 a 的 max(p) 过门）。答案和概率不一致 = 不可执行，不猜哪个才是模型本意。
		if (Math.abs(probs[choice] - top) >= 1e-9) return { kind: "abstain", reason: `选出的 id 不是概率最高（${choice}），不可执行`, usage, model };
	}
	// 阈值比较用 Jev 标度的换算值（概率缺失时 undefined → 调用方退回协议 confidence）。
	const decisionConfidence = probs ? jevChoiceConfidence(probs, candidateIds) : undefined;
	return { kind: "selected", candidateId: choice, confidence, decisionConfidence, probabilities: probs, usage, model };
}

/**
 * 把候选概率换算到阈值所在的标度（Jev 的 choice confidence，Laya 公开的 `jev_confidence` / #302）：
 * `(max(p) - 1/n) / (1 - 1/n)`，先按总和归一；总和为 0 视为均匀；只有一个候选时返回 undefined（不合成 1.0）。
 * 返回**原始精度**：展示层再取整，阈值比较不取整（否则 0.59996 会被四舍五入成 0.6 越过门槛）。
 *
 * 为什么需要这层换算：产品阈值（默认 0.6）是 Jev 标度上的数字，而 Laya 在自己的 wire `confidence`
 * 里放的是**归一化 Shannon 熵**（`laya/common.py:confidence_from_probs`，自己的文档写「与 max(p)
 * 不是一个量、不能套同一个阈值」，且随选项数变化：32 个候选时 `max(p)=0.6` 的熵只有约 0.41）。
 * 直接拿熵比 0.6 会把「概率约 0.66 的正确选项」误判成低可信；熵随候选数变化，候选越多越容易
 * 落到阈值以下（具体取决于剩余概率分布，不是「必然」）。
 *
 * 概率必须覆盖全部候选且有限、0–1，否则返回 undefined（不部分信任、不合成）。
 * 候选集合本身也要可信：至少 2 个、id 非空且不重复（重复会让 n 与 max(p) 同时失真）。
 */
export function jevChoiceConfidence(probabilities: Record<string, number> | undefined, candidateIds: string[]): number | undefined {
	if (!Array.isArray(candidateIds) || candidateIds.length < 2) return undefined;
	if (candidateIds.some((id) => typeof id !== "string" || !id)) return undefined;
	if (new Set(candidateIds).size !== candidateIds.length) return undefined;
	if (!probabilities || typeof probabilities !== "object") return undefined;
	const values: number[] = [];
	for (const id of candidateIds) {
		const v = probabilities[id];
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) return undefined;
		values.push(v);
	}
	const n = values.length;
	// 只有一个候选时「概率」不携带任何选择信息（Jev / Laya 在这种形状上都报 1.0）——这里不合成 1.0，
	// 返回 undefined 让调用方退回协议自己的 confidence：真实服务会报 1.0，伪造出来的低分也不会被放过。
	if (n === 1) return undefined;
	const total = values.reduce((a, b) => a + b, 0);
	const p = total > 0 ? values.map((v) => v / total) : values.map(() => 1 / n);
	const raw = (Math.max(...p) - 1 / n) / (1 - 1 / n);
	// 只 clamp 到 0..1，不取整：取整会让 0.59996 变成 0.6 越过阈值（展示层单独取整）。
	return Math.min(1, Math.max(0, raw));
}

/** 只保留候选集合内、有限且 0–1 的概率；有任何非法 / 缺失值就整体丢弃（不部分信任、不合成）。 */
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

/**
 * 原生 Jev：只把 goal + 候选 id/动作描述作为离散 choice 问题交给 classifier，答案必须是候选 id。
 * 动作描述由程序从已观察的 role/label 生成（明确「点击当前控件」），旧调用方没有描述时退回 label。
 *
 * `captureId` 是**程序内部**的新鲜度 / 授权 pin（见 index.ts registerCapture），**不进模型输入**：
 * 同一 goal + 候选在不同 capture 下必须得到完全相同的 context，否则每次调用的随机 token 会污染模型输入。
 *
 * `state` 只放 goal：候选的 id/动作描述已完整写在 `questions.pick.criteria` 里，同一份表再塞进 state 是重复输入
 * （上游 fine-tune 说明建议候选只留在 criteria）。这是**通用的去重**，不额外注入 goal 提示 / 答案 / 价值字段，
 * 也不改阈值、概率与 temperature；去重后模型表现是否变化**未测**，不宣称质量提升。
 */
export function createClassifierChooser(cfg: ClassifierChooserConfig): FastActionChooser {
	return {
		id: "systemone",
		label: cfg.label ?? "原生 Jev（System One 分类器）",
		nativeProbability: true,
		async choose(req: FastChoiceRequest, signal?: AbortSignal): Promise<FastChoiceResult> {
			const criteria: Record<string, string> = {};
			// criteria 用**动作描述**（程序从已观察 role/label 生成，明确「点击当前控件」）；
			// 旧调用方只有 label 时退回 label，不因此改候选 ID / 个数。
			for (const c of req.candidates) criteria[c.id] = c.description ?? c.label;
			const context: ClassifierContext = {
				// 只留 goal（本次一步的局部目标）；候选不重复进 state（见上方注释：重复输入去重，不增删信息）。
				state: { goal: req.goal },
				questions: {
					pick: {
						type: "choice",
						// 通用措辞：不谎称所有候选都是 click（其他调用方的白名单里也可能有 type 等动作）。
						instructions: "从候选中选出符合当前一步目标、且现在可执行的一个 id，只能选候选集合里的 id。",
						criteria,
					},
				},
			};
			try {
				const out = await cfg.classify(cfg.provider, cfg.model, context, { signal, timeoutMs: cfg.timeoutMs });
				return parseClassifierChoice(out, req.candidates.map((c) => c.id));
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return { kind: "error", error: /abort/i.test(msg) ? "timeout" : msg };
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
			// 与 classifier 同一份受限输入：候选只给 id + 动作描述（缺描述退回 label），
			// 不给 tool / args / element_token / ref / raw value。
			const list = req.candidates.map((c) => `- ${c.id}: ${c.description ?? c.label}`).join("\n");
			const prompt = `目标（当前一步）：${req.goal}\n\n候选（只能选其中一个 id）：\n${list}\n\n只输出 JSON：{"id":"<候选id>"}；拿不准就输出 {"abstain":true,"reason":"..."}。不要输出任何概率或 confidence。`;
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
