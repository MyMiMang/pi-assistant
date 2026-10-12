/**
 * 按需启停（DESIGN §15.2）：没有工具调用、没有人在看画面、没有任务/定时任务占用，超过设定时间就关掉这个助理的桌面；
 * 所有桌面都停了就关掉共用引擎（虚拟机后端释放内存）。判定逻辑是纯函数，单测覆盖。
 */
export interface IdleInput {
	now: number;
	/** 最近一次使用（启动、电脑工具调用、截图、画面断开、任务结束）的时间 */
	lastUse: number;
	/** 正在看实时画面的连接数 */
	viewers: number;
	/** 助理是否正在跑任务（对话回合 / 后台任务 / 定时任务） */
	busy: boolean;
	/** 0 = 从不自动关机 */
	idleMinutes: number;
}
export function shouldStop(s: IdleInput) {
	if (!s.idleMinutes || s.idleMinutes <= 0) return false;
	if (s.viewers > 0 || s.busy) return false;
	return s.now - s.lastUse >= s.idleMinutes * 60_000;
}

export class IdleTracker {
	private last = new Map<string, number>();
	private viewers = new Map<string, number>();
	constructor(private clock: () => number = Date.now) {}
	touch(agentId: string) {
		this.last.set(agentId, this.clock());
	}
	viewerOpen(agentId: string) {
		this.viewers.set(agentId, (this.viewers.get(agentId) ?? 0) + 1);
		this.touch(agentId);
	}
	viewerClose(agentId: string) {
		this.viewers.set(agentId, Math.max(0, (this.viewers.get(agentId) ?? 0) - 1));
		this.touch(agentId);
	}
	viewerCount = (agentId: string) => this.viewers.get(agentId) ?? 0;
	/** 本次检查里应该关掉哪些（running 是正在运行的桌面；忙碌的助理顺便刷新使用时间，任务结束后重新计时） */
	due(running: string[], busy: (id: string) => boolean, idleMinutes: number) {
		const now = this.clock();
		return running.filter((id) => {
			const b = busy(id);
			if (b || !this.last.has(id)) this.touch(id); // 服务重启后第一次看到：从现在开始计时
			return shouldStop({ now, lastUse: this.last.get(id)!, viewers: this.viewerCount(id), busy: b, idleMinutes });
		});
	}
	forget(agentId: string) {
		this.last.delete(agentId);
	}
}
