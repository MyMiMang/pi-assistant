/**
 * 主题设计请求的「在飞轮次」管理（纯逻辑，便于单测；组件只用它管 abort 与迟到响应）。
 *
 * 语义：
 *  - `begin()` 开始新一轮：先取消上一轮（真 abort 模型请求，不只是隐藏结果），返回新的 turnId 与 signal；
 *  - `isCurrent(turnId)` / `finish(turnId)`：晚到的响应不再是最新一轮时必须丢弃，不能覆盖当前预览；
 *  - `cancel()`：关面板 / 取消时调用，abort 在飞请求。
 */
export interface DraftTurn {
	turnId: string;
	signal: AbortSignal;
}

export class DraftTurns {
	private current: { turnId: string; controller: AbortController } | null = null;
	private seq = 0;

	begin(): DraftTurn {
		this.cancel();
		const turnId = `t${++this.seq}`;
		const controller = new AbortController();
		this.current = { turnId, controller };
		return { turnId, signal: controller.signal };
	}

	/** 这个 turnId 是否仍是最新一轮（否则说明用户已经取消 / 又发了新一轮，响应应丢弃）。 */
	isCurrent(turnId: string): boolean {
		return this.current?.turnId === turnId;
	}

	/** 一轮结束；只有它仍是最新一轮时才清空并返回 true。 */
	finish(turnId: string): boolean {
		if (this.current?.turnId !== turnId) return false;
		this.current = null;
		return true;
	}

	/** 取消在飞请求（真 abort）。 */
	cancel(): void {
		this.current?.controller.abort();
		this.current = null;
	}
}
