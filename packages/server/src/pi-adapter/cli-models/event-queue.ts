/** 进程那边来的事件先排队，`streamSimple` 这边按需一个个取（工具挂起期间事件继续排队，下一次调用接着取）。claude / codex 渠道共用。 */
export class EventQueue<T> {
	private items: T[] = [];
	private waiter: ((i: T) => void) | undefined;
	push(i: T): void {
		if (this.waiter) {
			const w = this.waiter;
			this.waiter = undefined;
			w(i);
		} else this.items.push(i);
	}
	next(): Promise<T> {
		if (this.items.length) return Promise.resolve(this.items.shift() as T);
		return new Promise((r) => (this.waiter = r));
	}
}
