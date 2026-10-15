/**
 * 快速操作模型（fast-computer-model）—— 编排核心。
 *
 * 这一层是纯逻辑：设置读取、capture 登记、候选校验、超时、熔断、结果校验、用量回调。
 * 它**从不执行任何动作**；执行由调用方（工具层）拿 `selected.candidate` 后经既有电脑工具钩子完成。
 */
import { getSetting, setSetting } from "../db.ts";
import { INPUT_TOOLS } from "@pi-assistant/ext-computer";
import { MAX_FAST_CANDIDATES } from "./choosers.ts";
import type { FastActionCandidate, FastActionChooser, FastChoiceResult, FastSemanticTarget, FastUsage } from "./types.ts";

export type { FastActionCandidate, FastActionChooser, FastChoiceRequest, FastChoiceResult, FastSemanticTarget, FastUsage } from "./types.ts";
export { MAX_FAST_CANDIDATES, createChatChooser, createClassifierChooser, createMockChooser, parseChatChoice, parseClassifierChoice } from "./choosers.ts";

// ---------------------------------------------------------------- 设置

export interface FastComputerSettings {
	/** 默认关闭：关闭时完全沿用主模型、零额外调用 */
	enabled: boolean;
	/** `systemone` = 原生 Jev 分类器；`chat` = OpenAI 兼容替代（非 Jev） */
	kind: "chat" | "systemone";
	/** 所选模型：chat = 普通模型；systemone = classifier 目录里的 provider */
	provider: string;
	/** 所选模型 id：chat = 普通模型 id；systemone = classifier 模型 id */
	id: string;
	/** 旧版 systemone 直连字段（保留兼容，已不再使用；原生 Jev 现在从 classifier 目录选） */
	baseUrl: string;
	model: string;
	/** 原生校准概率的阈值（只作用于 systemone；chat 替代没有概率，不适用） */
	threshold: number;
	timeoutMs: number;
}

export const FAST_COMPUTER_DEFAULT: FastComputerSettings = {
	enabled: false,
	kind: "chat",
	provider: "",
	id: "",
	baseUrl: "https://api.typesafe.ai",
	model: "jev-latest",
	threshold: 0.6,
	timeoutMs: 4000,
};

export function fastComputerSettings(): FastComputerSettings {
	const raw = getSetting<Partial<FastComputerSettings>>("fastComputer", {});
	const s: FastComputerSettings = { ...FAST_COMPUTER_DEFAULT, ...raw };
	if (s.kind !== "systemone" && s.kind !== "chat") s.kind = "chat";
	s.threshold = clamp(s.threshold, 0, 1, FAST_COMPUTER_DEFAULT.threshold);
	s.timeoutMs = clamp(s.timeoutMs, 500, 30_000, FAST_COMPUTER_DEFAULT.timeoutMs);
	return s;
}

const clamp = (v: unknown, min: number, max: number, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt);

/** 保存设置（只接受已知字段，做边界收敛）。默认关闭，不写就沿用默认。 */
export function saveFastComputerSettings(patch: Partial<FastComputerSettings>): FastComputerSettings {
	const cur = fastComputerSettings();
	const next: FastComputerSettings = { ...cur, ...patch };
	setSetting("fastComputer", next);
	return fastComputerSettings();
}

// ---------------------------------------------------------------- 候选校验 + capture 登记

/** 候选是否合法：1..32、id 唯一且非空、tool 属电脑输入工具白名单（不允许 shell / 任意 API / 任意脚本）。 */
export function validateCandidates(candidates: FastActionCandidate[]): string | null {
	if (!Array.isArray(candidates) || candidates.length === 0) return "没有候选动作";
	if (candidates.length > MAX_FAST_CANDIDATES) return `候选超过上限 ${MAX_FAST_CANDIDATES}`;
	const ids = new Set<string>();
	for (const c of candidates) {
		if (!c || typeof c.id !== "string" || !c.id) return "候选缺少 id";
		if (ids.has(c.id)) return `候选 id 重复：${c.id}`;
		ids.add(c.id);
		if (typeof c.tool !== "string" || !INPUT_TOOLS.includes(bareComputerTool(c.tool))) return `候选动作不在允许的电脑工具白名单：${c.tool}`;
	}
	return null;
}

/** `mcp__hostpc__click` / `mcp__computer__click` → `click`（白名单按裸工具名判断，执行仍用完整 MCP 名）。 */
const bareComputerTool = (tool: string) => tool.replace(/^mcp__(hostpc|computer)__/, "");

interface Capture {
	key: string;
	candidates: Map<string, FastActionCandidate>;
}
const captures = new Map<string, Capture>();
let captureSeq = 0;

/** 登记一次 capture；同一 key 的新 capture 作废旧 capture（模拟“快照更新后旧 capture 失效”）。返回 captureId。 */
export function registerCapture(key: string, candidates: FastActionCandidate[]): string {
	for (const [id, c] of captures) if (c.key === key) captures.delete(id);
	const id = `cap-${++captureSeq}-${Date.now().toString(36)}`;
	captures.set(id, { key, candidates: new Map(candidates.map((c) => [c.id, c])) });
	return id;
}

export const getCapture = (id: string): Capture | undefined => captures.get(id);
/** 仅供测试：清空 capture 与熔断状态 */
export function _resetFastComputerState() {
	captures.clear();
	failures.clear();
	captureSeq = 0;
}

// ---------------------------------------------------------------- 熔断

const CIRCUIT_LIMIT = 3;
const failures = new Map<string, number>();
export const resetFastCircuit = (key?: string) => (key ? failures.delete(key) : failures.clear());

// ---------------------------------------------------------------- 编排

export type FastFallbackReason =
	| "disabled"
	| "no_chooser"
	| "invalid_candidates"
	| "capture_invalid"
	| "timeout"
	| "model_error"
	| "unknown_candidate"
	| "low_confidence"
	| "abstain"
	| "reobserve"
	| "circuit_open";

export type FastSelectResult =
	| { kind: "disabled" }
	| { kind: "fallback"; reason: FastFallbackReason; detail?: string }
	| { kind: "selected"; candidate: FastActionCandidate; captureId: string; uncalibrated: boolean; confidence?: number; model?: string };

export interface SelectFastActionInput {
	/** capture / 熔断作用域键（如 `${session}:${pid}:${window_id}`） */
	key: string;
	goal: string;
	candidates: FastActionCandidate[];
	chooser: FastActionChooser;
	settings?: FastComputerSettings;
	signal?: AbortSignal;
	/** 快速模型有真实 usage 时回调（按真正返回记账，不估费用） */
	onUsage?: (u: { provider: string; model: string } & FastUsage) => void;
}

/**
 * 核心编排。顺序：关闭→零调用；候选校验；capture 登记；熔断；调 chooser；校验返回；返回 selected / fallback。
 * **不执行任何动作**。
 */
export async function selectFastAction(input: SelectFastActionInput): Promise<FastSelectResult> {
	const s = input.settings ?? fastComputerSettings();
	if (!s.enabled) return { kind: "disabled" };
	const bad = validateCandidates(input.candidates);
	if (bad) return { kind: "fallback", reason: "invalid_candidates", detail: bad };
	if (!input.chooser) return { kind: "fallback", reason: "no_chooser" };
	if ((failures.get(input.key) ?? 0) >= CIRCUIT_LIMIT) return { kind: "fallback", reason: "circuit_open", detail: `同一目标连续 ${CIRCUIT_LIMIT} 次回退，本轮改用主模型` };

	const captureId = registerCapture(input.key, input.candidates);
	const offered = input.candidates.map((c) => ({ id: c.id, label: c.label }));
	let result: FastChoiceResult;
	try {
		result = await input.chooser.choose({ goal: input.goal, captureId, candidates: offered }, input.signal);
	} catch (e) {
		result = { kind: "error", error: e instanceof Error ? e.message : String(e) };
	}

	const record = () => {
		if (result.kind === "error" || !result.usage) return;
		input.onUsage?.({ provider: usageProvider(s), model: usageModel(s, result), input: result.usage.input, output: result.usage.output });
	};

	const fallback = (reason: FastFallbackReason, detail?: string): FastSelectResult => {
		failures.set(input.key, (failures.get(input.key) ?? 0) + 1);
		record();
		return { kind: "fallback", reason, detail };
	};

	if (result.kind === "error") {
		const isTimeout = /timeout|abort/i.test(result.error);
		return fallback(isTimeout ? "timeout" : "model_error", result.error);
	}
	if (result.kind === "abstain") return fallback("abstain", result.reason);
	if (result.kind === "reobserve") return fallback("reobserve", result.reason);

	// selected：必须回候选表查回 id（校验 capture + 候选）
	const cap = captures.get(captureId);
	if (!cap) return fallback("capture_invalid", "capture 已失效或未登记");
	const candidate = cap.candidates.get(result.candidateId);
	if (!candidate) return fallback("unknown_candidate", result.candidateId);

	// 只有原生概率才应用阈值；chat 替代没有概率（uncalibrated），一律要求独立核验
	if (input.chooser.nativeProbability && typeof result.confidence === "number") {
		if (result.confidence < s.threshold) return fallback("low_confidence", `confidence ${result.confidence} < ${s.threshold}`);
	}
	failures.delete(input.key);
	record();
	return { kind: "selected", candidate, captureId, uncalibrated: !input.chooser.nativeProbability, confidence: result.confidence, model: result.model };
}

const usageProvider = (s: FastComputerSettings) => (s.kind === "systemone" ? s.provider || "jev" : s.provider || "fast");
const usageModel = (s: FastComputerSettings, r: { model?: string }) => r.model ?? (s.kind === "systemone" ? s.id || "jev" : s.id || "fast");

/** 校验通过但还没执行的候选，供工具层把 id 映射回预构建动作（复用 capture 校验）。 */
export function resolveCandidate(captureId: string, candidateId: string): FastActionCandidate | undefined {
	return captures.get(captureId)?.candidates.get(candidateId);
}

// ---------------------------------------------------------------- 执行前新鲜度校验（G2）

/** 窗口状态里的一行元素（只取校验需要的字段）。 */
interface StateElement extends FastSemanticTarget {
	element_token?: string;
}

const norm = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const sameActions = (a: string[] | undefined, b: string[] | undefined) => [...(a ?? [])].sort().join("\u0000") === [...(b ?? [])].sort().join("\u0000");

export type FreshCandidateResult = { ok: true; candidate: FastActionCandidate } | { ok: false; reason: "no_semantic" | "not_found" | "ambiguous" | "changed" };

/**
 * 用「重新读取的同窗口状态」校验候选目标，并用新的 element_token 重构动作。
 *
 * 不变量：
 *  - 只按语义（role + label）匹配，且要求**唯一**命中；命中 0 个 → not_found，多个 → ambiguous；
 *  - 命中后要求 value / actions 与收集时一致，变了 → changed；
 *  - 命中元素必须有 element_token，否则无法派发；
 *  - 绝不使用旧的 element_token（每次都填新快照的 token）。
 */
export function resolveFreshCandidate(candidate: FastActionCandidate, structured: unknown): FreshCandidateResult {
	const sem = candidate.semantic;
	if (!sem || (!sem.role && !sem.label)) return { ok: false, reason: "no_semantic" };
	const elements = (structured as { elements?: StateElement[] } | null)?.elements;
	if (!Array.isArray(elements)) return { ok: false, reason: "not_found" };
	const matches = elements.filter((e) => norm(e.role) === norm(sem.role) && norm(e.label) === norm(sem.label));
	if (matches.length === 0) return { ok: false, reason: "not_found" };
	if (matches.length > 1) return { ok: false, reason: "ambiguous" };
	const hit = matches[0];
	if (!hit.element_token) return { ok: false, reason: "changed" };
	if (norm(hit.value) !== norm(sem.value) || !sameActions(hit.actions, sem.actions)) return { ok: false, reason: "changed" };
	return { ok: true, candidate: { ...candidate, args: { ...candidate.args, element_token: hit.element_token } } };
}

// ---------------------------------------------------------------- 执行后独立核验（G3）

/** 主模型给的可验证后置条件（只允许窗口状态里能读到的字段，不接受任意表达式）。 */
export interface FastExpectation {
	role?: string;
	label_contains?: string;
	value_equals?: string;
	action_contains?: string;
	/** false 表示要求「匹配到的元素不存在」；控件树不保证完整覆盖，absence 不可证，只会 unsatisfied / unknown，绝不 confirmed。 */
	exists?: boolean;
}

/** 执行后核验结论：满足 / 不满足 / 无法判定（无 expected 或缺状态一律 unknown，绝不把「执行返回成功」当任务成功）。 */
export type VerifyOutcome = "confirmed" | "unsatisfied" | "unknown";

/**
 * 用执行后**重新读取**的窗口状态核验 expected 后置条件。只会返回 confirmed / unsatisfied / unknown；
 * 没有 expected、读不到 elements、或没有可判定的匹配（例如多个匹配里没一个满足全部条件）都不臆断成功。
 *
 * 关键不变量：控件树搜索非穷尽 / 可能被截断或过滤（部分可见），**没匹配到 ≠ 不存在**。
 * 缺少「完整覆盖」的可信证明时一律 unknown，绝不据此 confirmed（与 host `verify_state` 的「absence 不可证」一致）。
 */
export function verifyExpectation(expected: FastExpectation | undefined, structured: unknown): VerifyOutcome {
	if (!expected) return "unknown";
	const elements = (structured as { elements?: StateElement[] } | null)?.elements;
	if (!Array.isArray(elements)) return "unknown";
	const matched = elements.filter((e) => {
		if (expected.role !== undefined && norm(e.role) !== expected.role) return false;
		if (expected.label_contains !== undefined && !norm(e.label).includes(expected.label_contains)) return false;
		return true;
	});
	// 没匹配到：可能真的不存在，也可能只是没覆盖到 → 无法判定，绝不 confirmed。
	if (matched.length === 0) return "unknown";
	// 确实匹配到元素 → 「不存在」后置条件被正向证据证伪。
	if (expected.exists === false) return "unsatisfied";
	let undecidable = false;
	for (const e of matched) {
		if (expected.value_equals !== undefined) {
			// 元素缺 value 字段时不能把 undefined 当空串（norm(undefined) === ""）；值断言无法判定 → unknown，不误判 confirmed。
			if (e.value === undefined || e.value === null) {
				undecidable = true;
				continue;
			}
			if (norm(e.value) !== expected.value_equals) continue;
		}
		if (expected.action_contains !== undefined && !(e.actions ?? []).includes(expected.action_contains)) continue;
		return "confirmed";
	}
	return undecidable ? "unknown" : "unsatisfied";
}
