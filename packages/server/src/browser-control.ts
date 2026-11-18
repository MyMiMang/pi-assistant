import type { BrowserControl } from "@pi-assistant/shared";

/** 页级串行输入。接管立即作废排队租约，在途不能安全取消时保持锁定。 */
export class BrowserInputControl {
	state: BrowserControl = "agent";
	generation = 1;
	error?: string;
	private tail: Promise<unknown> = Promise.resolve();
	private running = 0;
	constructor(private paused: () => boolean, private deadlineMs = 5000) {}
	check(owner: "agent" | "user", generation: number) {
		if (this.paused()) throw new Error("浏览器操作已暂停");
		if (this.state !== owner || generation !== this.generation) throw new Error("网页控制权已变化，请重新读取页面；不要重放未确认的操作");
	}
	run<T>(owner: "agent" | "user", generation: number, checkIdentity: () => void, action: (check: () => void) => Promise<T>): Promise<T> {
		const check = () => { this.check(owner, generation); checkIdentity(); };
		check();
		const next = this.tail.then(async () => {
			check();
			this.running++;
			try { return await action(check); } finally { this.running--; }
		});
		this.tail = next.catch(() => {});
		return next;
	}
	private async drain(reread: () => Promise<unknown> = async () => {}) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([this.tail.then(reread), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("仍未获得控制权：在途操作尚未结束。页面保持锁定，结果未知，请核实后显式恢复。")), this.deadlineMs); })]);
		} finally { clearTimeout(timer); }
	}
	/** 显式环境切换先冻结所有原页；超时与失败继续锁定，不能偷偷恢复。 */
	async freeze() {
		this.check("agent", this.generation);
		this.state = "draining"; this.generation++;
		try { await this.drain(); } catch (e) { this.error = e instanceof Error ? e.message : String(e); throw e; }
	}
	thaw() {
		if (this.state !== "draining" || this.running) throw new Error("网页仍有未结算操作");
		this.state = "agent"; this.generation++; this.error = undefined;
	}
	async takeover(recover = false, reread: () => Promise<unknown> = async () => {}) {
		if (this.state === "user") return;
		if (this.state !== "agent" && !(recover && this.state === "draining")) throw new Error("控制权正在变更，请等待或显式恢复");
		this.state = "draining";
		const version = ++this.generation;
		this.error = undefined;
		try {
			await this.drain(reread);
			if (version !== this.generation) throw new Error("控制权已变化");
			this.state = "user";
		} catch (e) { this.error = e instanceof Error ? e.message : String(e); throw e; }
	}
	async giveBack(reread: () => Promise<unknown>) {
		if (this.state !== "user") throw new Error("尚未接管网页，不能交还");
		this.state = "reading";
		const version = ++this.generation;
		try {
			await this.drain(reread);
			if (version !== this.generation) throw new Error("控制权已变化");
			this.state = "agent";
			this.error = undefined;
		} catch (e) { this.state = "draining"; this.error = e instanceof Error ? e.message : String(e); throw e; }
	}
	get inFlight() { return this.running; }
}
