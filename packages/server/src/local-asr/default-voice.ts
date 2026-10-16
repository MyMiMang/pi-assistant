/**
 * 「默认本地语音」的**纯语义**（不依赖具体选哪个模型、不碰 IO）。
 *
 * 用户要求（原话大意）：装好应用就能用语音；设置里可切其他；**已有「云 / 本地」选择不得被默认覆盖或删除**。
 *
 * 所以这里只做三件纯函数的事，且**默认是哪个模型完全由 catalog 数据决定**（本文件不出现任何 modelId 字面量）：
 *  1. `resolveDefaultVoiceId()`：从目录里挑出**唯一**标记为默认的本地流式模型；不唯一 / 不流式 / 未放行 → fail closed；
 *  2. `shouldAdoptDefault()`：只有「从未配置」（`voiceSource === null`）才允许采用默认，已选过一律不动；
 *  3. `defaultVoiceView()`：给界面用的归一化状态（显示**实际**模型与实际状态，不编造可用性）。
 *
 * 设计见 `docs/design/default-local-voice.md` §4；选型见 `progress-snapshots/default-local-voice-decision.md`。
 */

/** 目录项里本模块需要的**最小结构**（结构化传入，避免与 catalog 实现耦合）。 */
export interface DefaultVoiceCandidate {
	/** 稳定 modelId */
	id: string;
	/** 是否原生流式（catalog 的 `streaming`） */
	streaming?: boolean;
	/** 是否是「默认本地语音」候选（catalog 的 `defaultVoice`；全目录最多一个为 true） */
	defaultVoice?: boolean;
	/** 本地按需下载是否放行（catalog 的 `license.selfServe`） */
	selfServe?: boolean;
}

export type ResolveDefaultVoiceResult = { ok: true; id: string } | { ok: false; reason: string };

/**
 * 从目录里解析「默认本地语音」的 modelId。
 *
 * fail closed：没有标记、标记多于一个、标记的项不是原生流式、或未放行本地下载，都返回 `ok: false`
 * ——绝不猜、绝不回落到「第一个本地模型」。
 */
export function resolveDefaultVoiceId(specs: readonly DefaultVoiceCandidate[]): ResolveDefaultVoiceResult {
	const marked = specs.filter((s) => s.defaultVoice === true);
	if (marked.length === 0) return { ok: false, reason: "目录里没有标记为「默认本地语音」的模型（不猜、不回落）" };
	if (marked.length > 1) return { ok: false, reason: `目录里有多个「默认本地语音」标记：${marked.map((s) => s.id).join("、")}` };
	const only = marked[0];
	if (!only.streaming) return { ok: false, reason: `默认本地语音必须是原生流式模型，但 ${only.id} 未标记 streaming` };
	if (!only.selfServe) return { ok: false, reason: `默认本地语音的本地下载未放行（selfServe=false）：${only.id}` };
	return { ok: true, id: only.id };
}

/** 是否允许把来源切换成默认：**只有从未配置（null）**。已显式选过（本地或云端）一律不覆盖。 */
export function shouldAdoptDefault(current: unknown): boolean {
	return current === null || current === undefined;
}

/** 界面视图：当前用的是「用户自己选的」还是「默认」，以及默认模型的实际状态。 */
export interface DefaultVoiceView {
	/** user-chosen = 用户已显式选择（默认绝不覆盖）；default = 正在用默认；unconfigured = 还没选 */
	kind: "user-chosen" | "default" | "unconfigured";
	/** 可直接显示的中文一句话 */
	label: string;
	/** 默认模型的 modelId（目录没标记默认时为 null） */
	defaultModelId: string | null;
	/** 是否可以「换成默认」的显式入口（用户已选过时仍给按钮，但绝不自动改） */
	canAdopt: boolean;
}

export interface DefaultVoiceInput {
	/** 当前持久化来源（`settings.voiceSource`），`null` = 未配置 */
	current: { location: string; provider: string; model: string } | null;
	/** 目录解析结果（`resolveDefaultVoiceId`） */
	resolved: ResolveDefaultVoiceResult;
}

/**
 * 归一化视图。**不判断「能不能用」**（那是 catalog `selected` / `install` 状态的事），只判断「谁在用」。
 */
export function defaultVoiceView(input: DefaultVoiceInput): DefaultVoiceView {
	const defaultModelId = input.resolved.ok ? input.resolved.id : null;
	const isDefault = input.current !== null && input.resolved.ok && input.current.location === "local" && input.current.model === input.resolved.id;
	if (input.current === null || input.current === undefined) {
		return {
			kind: "unconfigured",
			label: defaultModelId ? "还没选语音识别来源；默认提供本地流式听写" : "还没选语音识别来源",
			defaultModelId,
			canAdopt: defaultModelId !== null,
		};
	}
	if (isDefault) return { kind: "default", label: "正在使用默认本地流式听写", defaultModelId, canAdopt: false };
	return {
		kind: "user-chosen",
		label: input.current.location === "cloud" ? `正在使用云端识别（${input.current.provider} / ${input.current.model}）` : `正在使用本地模型（${input.current.model}）`,
		defaultModelId,
		canAdopt: defaultModelId !== null,
	};
}
