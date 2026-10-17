/**
 * 快速操作模型（fast-computer-model）—— 类型与接口边界。
 *
 * 产品分工（用户已批准）：主模型仍负责规划 / 授权 / 异常决策；快速模型只做**受限局部候选选择**
 * （从程序预构建的动作 ID 里选一个），不自由访问工具、不接管主会话。
 *
 * 安全不变量（照 cua `decision-models.md`）：
 *  - 快速模型只看到 goal + capture_id + 候选的 id/label/动作描述；看不到工具名 / 参数 / 坐标 / 截图 / 凭据；
 *  - `selected` 不是授权；程序必须回候选表查回 ID、重校验、只派发预构建且已授权的动作、独立核验结果；
 *  - abstain / reobserve / error / 超时 / 低可信 不派发任何动作；高分不等于授权。
 */

/**
 * 候选目标在窗口状态里的语义身份：用于执行前「独立重读同窗口」校验
 * （同 session 同窗口重取，要求语义目标唯一且 role / value / actions 不变，再用新 element_token 重构动作）。
 */
export interface FastSemanticTarget {
	role?: string;
	label?: string;
	value?: string;
	actions?: string[];
}

/** 一个预构建动作：由程序（或主模型作为规划者）给出，快速模型只看 id + label（+ 可选动作描述）。 */
export interface FastActionCandidate {
	id: string;
	/** 控件的语义 / UI 身份（如 `button：登录`）；执行前重校验也用这一对 role/label。 */
	label: string;
	/**
	 * **动作语义描述**：由程序从**已观察到的** role/label 生成（不是模型猜、不是测试答案），明确这是「点击 / 聚焦
	 * 当前这个控件」。只描述**本步动作**，不承诺点击后会展开 / 提交 / 切换成功等未知后置结果。
	 * 不承载 tool / args / element_token / 控件 raw value，也不含任何测试期望。缺省时模型侧退回 label（旧调用方兼容）。
	 */
	description?: string;
	/** 真正执行用的电脑工具名 + 参数；快速模型看不到（只在程序侧） */
	tool: string;
	args: Record<string, unknown>;
	/** 收集候选时的语义身份；执行前据此重读窗口状态校验目标未变（见 resolveFreshCandidate） */
	semantic?: FastSemanticTarget;
}

/**
 * 快速模型收到的请求（有界、无副作用）。`captureId` 只是程序内部的新鲜度/授权 pin，**不进模型输入**。
 *
 * `goal` 是**本次一步动作的局部目标**（如「点开城市下拉」），不是整条多步任务：多步由主模型每步重新收集候选、
 * 重新决策。候选 `description` 可选（旧调用方只有 label）；两者都不含工具名 / 参数 / token / raw value。
 */
export interface FastChoiceRequest {
	goal: string;
	captureId: string;
	candidates: { id: string; label: string; description?: string }[];
}

/** 快速模型返回的用量（有就记，没有记 0，不估） */
export interface FastUsage {
	input: number;
	output: number;
}

export type FastChoiceResult =
	| {
			kind: "selected";
			candidateId: string;
			/**
			 * 协议**原样**返回的置信度。同一个字段名在不同服务上不是一个量：Jev 的是 Jev 公式，
			 * Laya 的是归一化 Shannon 熵（`laya/common.py:confidence_from_probs`，Laya 文档明确
			 * 「不可与 max(p) 用同一个阈值比较」、且随选项数变化）。只作诊断，不用来比阈值。
			 */
			confidence?: number;
			/**
			 * 阈值实际比较的置信度：由 `probabilities` 按 **Jev 的 choice 公式**换算
			 * `(max(p) - 1/n) / (1 - 1/n)`（`laya/confidence.py:jev_confidence`、issue #302 的公开换算）。
			 * 对 Jev 等价于它自己的 `confidence`；对 Laya 把熵换到阈值本来所在的标度。
			 * 概率缺失 / 非法时为 undefined（此时退回 `confidence`，不合成）。
			 *
			 * 语义边界：这只修正「比较的标度」，**不等于已校准准确率**；Laya 的
			 * `answer_confidence=max(p)` 未拟合温度（偏 over-confident），阈值不能读成概率正确率。
			 */
			decisionConfidence?: number;
			probabilities?: Record<string, number>;
			reason?: string;
			model?: string;
			usage?: FastUsage;
		}
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
