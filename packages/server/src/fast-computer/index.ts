/**
 * 快速操作模型（fast-computer-model）—— 编排核心。
 *
 * 这一层是纯逻辑：设置读取、capture 登记、候选校验、超时、熔断、结果校验、用量回调。
 * 它**从不执行任何动作**；执行由调用方（工具层）拿 `selected.candidate` 后经既有电脑工具钩子完成。
 */
import { getSetting, setSetting } from "../db.ts";
import { INPUT_TOOLS } from "@pi-assistant/ext-computer";
import { MAX_FAST_CANDIDATES } from "./choosers.ts";
import type { FastActionCandidate, FastActionChooser, FastChoiceResult, FastUsage } from "./types.ts";

export type { FastActionCandidate, FastActionChooser, FastChoiceRequest, FastChoiceResult, FastUsage } from "./types.ts";
export { MAX_FAST_CANDIDATES, createChatChooser, createMockChooser, createSystemOneChooser, parseChatChoice, parseSystemOneChoice } from "./choosers.ts";

// ---------------------------------------------------------------- 设置

export interface FastComputerSettings {
	/** 默认关闭：关闭时完全沿用主模型、零额外调用 */
	enabled: boolean;
	/** `systemone` = 原生 Jev；`chat` = OpenAI 兼容替代（非 Jev） */
	kind: "chat" | "systemone";
	/** chat：provider id */
	provider: string;
	/** chat：模型 id */
	id: string;
	/** systemone：baseURL（官方 / OpenRouter / 自建原生中转） */
	baseUrl: string;
	/** systemone：模型名，如 `jev-latest` / `typesafe/jev-1.13` */
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

const usageProvider = (s: FastComputerSettings) => (s.kind === "systemone" ? "jev" : s.provider || "fast");
const usageModel = (s: FastComputerSettings, r: { model?: string }) => (s.kind === "systemone" ? r.model ?? (s.model || "jev") : s.id || "fast");

/** 校验通过但还没执行的候选，供工具层把 id 映射回预构建动作（复用 capture 校验）。 */
export function resolveCandidate(captureId: string, candidateId: string): FastActionCandidate | undefined {
	return captures.get(captureId)?.candidates.get(candidateId);
}
