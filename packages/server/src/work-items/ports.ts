/**
 * 任务与群之间只有两个窄接口（docs/design/group-collaboration.md「架构」）：
 *  ① 群 → 任务：onRoomWorkEvent（actions.ts）—— 群里的派活、成员移出、删群从这里进来；
 *  ② 任务 → 群：RoomPort —— 进展 / 上报发回来源群、在关键事件唤醒管理者、项目进行中的成员互相 @、进行中的项目（任务挂到哪个项目）。
 * 群模块启动时注册 RoomPort；任务模块不 import 群模块本体（避免循环、也方便以后接单聊）。
 */
export interface RoomPort {
	/** 以用户身份往群里发一条带可信任务关联的消息（看板反馈、用户的决定），走正常群路由 */
	postUserMessage: (roomId: string, text: string, opts: { workItemId?: string; from?: unknown }) => unknown;
	/** 关键事件唤醒管理者：只读看板 + 摘要；群已停止 / 本轮暂停时不唤醒（看板仍可见） */
	wakeManager: (roomId: string, reason: string, workItemId?: string) => void;
	/** 任务有真实进展：清掉群里「只聊不干活」的计数 */
	noteProgress: (roomId: string) => void;
	/** 执行结束时的回复里 @ 了其他成员：项目进行中叫醒他们（平时什么都不做） */
	peerMentions: (roomId: string, fromAgentId: string, text: string) => void;
	/** 管理者在这个群里的会话（把「等你决定」的提问卡片放进群里） */
	managerConversation: (roomId: string) => { agentId: string; conversationId: string } | null;
	/** 这个群进行中的项目（work_create 挂项目、默认挂到唯一的那个） */
	activeProjects: (roomId: string) => { id: string; title: string }[];
	/** 这个项目方案里的阶段名；没有这个项目或方案没写阶段就返回 null（表示不限制阶段名）。 */
	projectStages: (projectId: string) => string[] | null;
	/** 任务核验通过后：这个项目的阶段可能完成了——群模块判断是否「刚完成」，是就叫醒管理者通知用户（只通知一次）；管理者自己核验的不叫醒，返回提醒让它这一轮就处理 */
	stageMaybeDone: (projectId: string, byAgentId?: string) => string | null | void;
	/** 核验通过的任务让阶段刚完成、且方案有关键点时，别的阶段的下游任务先暂缓：群模块判断并记下（返回 true = 暂缓，任务模块不开始它），之后由群模块用 startReleased 放行 */
	holdForCheckpoint: (projectId: string, upstreamItemId: string, dependentItemId: string) => boolean;
	/** 群成员名单（任务执行说明里给负责人看，找同事时知道该叫谁） */
	roster: (roomId: string, agentId: string) => string;
}
let roomPort: RoomPort | null = null;
export const setRoomPort = (p: RoomPort) => void (roomPort = p);
/** 同步取（群模块已经加载时）；没注册就返回 null，调用方按“没有群”处理。 */
export const port = () => roomPort;
export async function rooms(): Promise<RoomPort> {
	if (!roomPort) await import("../rooms/index.ts"); // 群模块加载时会注册
	return roomPort!;
}

/** 当前这一轮的用户来源消息（由 rooms 提供；拿不到就不挂来源，不凭猜测关联旧消息）。 */
let sourceProvider: ((roomId: string) => string | null) | null = null;
export function setWorkSourceProvider(fn: (roomId: string) => string | null) {
	sourceProvider = fn;
}
export function currentSource(roomId: string): string | null {
	try {
		return sourceProvider?.(roomId) ?? null;
	} catch {
		return null;
	}
}
