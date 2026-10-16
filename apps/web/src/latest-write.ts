/**
 * 「最后一次为准」的乐观写入守卫（纯逻辑，便于单测）。
 *
 * 为什么需要：设置项保存走「先改界面（乐观）→ PUT → 失败回滚」。用户很快 A→B 连点时，
 * A 的失败响应可能晚于 B 到达；不看代次就回滚，会把用户第二次的选择抹掉（保存失败重放旧值）。
 *
 * 语义：
 * - `begin()` 开始一次写入并返回代次；只有「仍是最新的那一次」才允许改界面。
 * - `confirm(id, value)` 记住**服务端确认过**的值；只有仍是最新一次的成功才算数，
 *   迟到的旧成功不能把确认值改回旧的（否则后续回滚会回到假值）。
 * - `fail(id)` 失败处理：不是最新一次 → `{ rollback: false }`（不动界面，不覆盖新选择）；
 *   是最新一次 → `{ rollback: true, value }` 回滚到「服务端确认过的值」，**绝不用未确认的乐观值**。
 * - `invalidate()` 组件卸载 / 切走时调用：在飞响应一律不再落地（不串到别的助理、不在卸载后写状态）。
 *
 * 与既有的 `DraftTurns`（主题草稿，带真 abort）、`local-asr-intent` 的 token 守卫同类；
 * 这里不带 AbortController——设置写入很小，只需要「最后一次为准」，并保留服务端真值。
 */
export class LatestWrite {
	private seq = 0;
	private confirmed: string | null;

	constructor(confirmed: string | null = null) {
		this.confirmed = confirmed;
	}

	/** 开始一次写入，返回代次（之后用它判断是否仍是最新一次）。 */
	begin(): number {
		return ++this.seq;
	}

	isCurrent(id: number): boolean {
		return id === this.seq;
	}

	/** 记住服务端确认过的值；返回是否仍是最新一次。 */
	confirm(id: number, value: string): boolean {
		if (id !== this.seq) return false;
		this.confirmed = value;
		return true;
	}

	/** 这次失败是否要回滚界面，以及回滚到哪个值。 */
	fail(id: number): { rollback: boolean; value: string | null } {
		return id === this.seq ? { rollback: true, value: this.confirmed } : { rollback: false, value: null };
	}

	/** 作废在飞写入（组件卸载 / 切到别的助理）。 */
	invalidate(): void {
		this.seq += 1;
	}
}
