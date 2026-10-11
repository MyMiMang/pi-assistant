/** 实时事件总线：所有状态先写数据库，再通过这里推给所有在线客户端（WebSocket）。 */
export type BusEvent = { type: string; [k: string]: unknown };
type Listener = (e: BusEvent & { seq: number }) => void;
let seq = 0;
const listeners = new Set<Listener>();
export const bus = {
	emit(e: BusEvent) {
		const ev = { ...e, seq: ++seq };
		for (const l of listeners) {
			try {
				l(ev);
			} catch {
				/* ignore */
			}
		}
	},
	on(l: Listener) {
		listeners.add(l);
		return () => listeners.delete(l);
	},
	get seq() {
		return seq;
	},
	get clientCount() {
		return listeners.size;
	},
};
