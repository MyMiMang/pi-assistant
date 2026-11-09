/** 原生 ACP 没有事件时的保护；等待审批不计时。测试可完全替换时钟，无需真等十分钟。 */
export interface AcpClock {
	now(): number;
	setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
	clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export const acpClock: AcpClock = { now: Date.now, setTimeout, clearTimeout };

export class AcpInactivity {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private last = 0;
	private running = false;

	constructor(
		private readonly ms: number,
		private readonly waiting: () => boolean,
		private readonly cancel: () => void,
		private readonly clock: AcpClock = acpClock,
	) {}

	start(): void {
		this.running = true;
		this.activity();
	}

	activity(): void {
		this.last = this.clock.now();
		if (this.running) this.arm(this.ms);
	}

	stop(): void {
		this.running = false;
		if (this.timer) this.clock.clearTimeout(this.timer);
		this.timer = undefined;
	}

	private arm(ms: number): void {
		if (this.timer) this.clock.clearTimeout(this.timer);
		this.timer = this.clock.setTimeout(() => {
			this.timer = undefined;
			if (!this.running) return;
			if (this.waiting()) {
				this.activity();
				return;
			}
			const left = this.ms - (this.clock.now() - this.last);
			if (left > 0) {
				this.arm(left);
			} else {
				this.stop();
				this.cancel();
			}
		}, ms);
		this.timer.unref?.();
	}
}
