import type { TokenUsage } from "./events.ts";

type UsageField = "input" | "output" | "cacheRead";
const fields = ["input", "output", "cacheRead"] as const;
export type AgyUsage = Partial<Pick<TokenUsage, UsageField>>;

/** 终段已经明确报告的列优先；仅用可信余额补未报告的列。 */
export function missingAgyUsage(remainder: TokenUsage | undefined, reported: AgyUsage): TokenUsage | undefined {
	if (!remainder) return;
	const result = { ...remainder };
	for (const key of fields) if (reported[key] !== undefined) result[key] = 0;
	return result.input || result.output || result.cacheRead ? result : undefined;
}

/** 一进程、一会话。跨工具续接不重置，只在送新的用户输入时开启下一轮。 */
export class AgyUsageLedger {
	private baseline: AgyUsage;
	private active = false;
	private steps: AgyUsage = {};
	private receiptTurn = 0;
	private readonly completedSteps = new Set<number>();

	constructor(private sessionId: string | undefined) {
		this.baseline = sessionId ? {} : { input: 0, output: 0, cacheRead: 0 };
	}

	observeSession(sessionId: string): void {
		if (!sessionId) return;
		if (this.sessionId && this.sessionId !== sessionId) {
			this.baseline = {};
			this.receiptTurn = 0;
			this.completedSteps.clear();
		}
		this.sessionId = sessionId;
	}

	startTurn(): void {
		if (this.active) this.baseline = {}; // 上一轮没收到回执，不能补算跨轮缺口
		this.active = true;
		this.steps = {};
		this.completedSteps.clear();
	}

	/** 缺会话或显式步骤身份时不猜；仅对当前进程的当前轮去重。 */
	acceptDone(identity: { sessionId: string; index: number } | undefined): boolean {
		if (!this.active || !identity || identity.sessionId !== this.sessionId) return true;
		if (this.completedSteps.has(identity.index)) return false;
		this.completedSteps.add(identity.index);
		return true;
	}

	observeStep(usage: TokenUsage): void {
		if (this.active) for (const key of fields) this.steps[key] = (this.steps[key] ?? 0) + usage[key];
	}

	/** 同会话相邻累计快照做差后再扣本轮已有单步；余额补入尾段，包含单步未报告的列。 */
	finish(sessionId: string, turn: number, usage: AgyUsage): TokenUsage | undefined {
		if (!this.active || (sessionId && this.sessionId && sessionId !== this.sessionId)) return;
		this.active = false;
		this.observeSession(sessionId);
		if (turn && turn <= this.receiptTurn) {
			this.baseline = {}; // 重复或倒序，当前轮未获得可用基线
			return;
		}
		if (turn) this.receiptTurn = turn;
		const prev = this.baseline;
		this.baseline = { ...usage };
		const delta = (key: UsageField) => {
			const start = prev[key], end = usage[key];
			if (start === undefined || end === undefined) return 0;
			const residual = end - start - (this.steps[key] ?? 0);
			if (residual >= 0) return residual;
			delete this.baseline[key]; // 与已知单步矛盾，不用它为下轮做差
			return 0;
		};
		const result = { input: delta("input"), output: delta("output"), cacheRead: delta("cacheRead"), cacheWrite: 0 };
		return result.input || result.output || result.cacheRead ? result : undefined;
	}
}
