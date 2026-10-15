/**
 * 快速操作模型（fast-computer-model）—— 类型与接口边界。
 *
 * 产品分工（用户已批准）：主模型仍负责规划 / 授权 / 异常决策；快速模型只做**受限局部候选选择**
 * （从程序预构建的动作 ID 里选一个），不自由访问工具、不接管主会话。
 *
 * 安全不变量（照 cua `decision-models.md`）：
 *  - 快速模型只看到 goal + capture_id + 候选的 id/label；看不到工具名 / 参数 / 坐标 / 截图 / 凭据；
 *  - `selected` 不是授权；程序必须回候选表查回 ID、重校验、只派发预构建且已授权的动作、独立核验结果；
 *  - abstain / reobserve / error / 超时 / 低可信 不派发任何动作；高分不等于授权。
 */

/** 一个预构建动作：由程序（或主模型作为规划者）给出，快速模型只看 id + label。 */
export interface FastActionCandidate {
	id: string;
	label: string;
	/** 真正执行用的电脑工具名 + 参数；快速模型看不到（只在程序侧） */
	tool: string;
	args: Record<string, unknown>;
}

/** 快速模型收到的请求（有界、无副作用） */
export interface FastChoiceRequest {
	goal: string;
	captureId: string;
	candidates: { id: string; label: string }[];
}

/** 快速模型返回的用量（有就记，没有记 0，不估） */
export interface FastUsage {
	input: number;
	output: number;
}

export type FastChoiceResult =
	| { kind: "selected"; candidateId: string; confidence?: number; probabilities?: Record<string, number>; reason?: string; model?: string; usage?: FastUsage }
	| { kind: "reobserve"; reason?: string; model?: string; usage?: FastUsage }
	| { kind: "abstain"; reason?: string; model?: string; usage?: FastUsage }
	| { kind: "error"; error: string; model?: string; usage?: FastUsage };

/**
 * 选择器适配器接口。三种实现：
 *  - `systemone`：原生 TypeSafe Jev System One（真 Jev，有原生校准概率）；
 *  - `chat`：OpenAI 兼容快模型（**替代，不是 Jev**，无原生校准概率，绝不合成）；
 *  - `mock`：测试用，确定性、无网络。
 */
export interface FastActionChooser {
	readonly id: string;
	readonly label: string;
	/** 是否有原生校准概率。SystemOne=true；chat 替代=false。 */
	readonly nativeProbability: boolean;
	choose(req: FastChoiceRequest, signal?: AbortSignal): Promise<FastChoiceResult>;
}
