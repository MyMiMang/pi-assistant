/** 群聊挂钩：rooms 注册，runtime 读（避免循环依赖）。 */


/** 群聊挂钩（rooms.ts 注册，避免循环依赖）：对话是不是某个群里的成员对话、群的规则与工具 */
export interface RoomHooks {
	/** 成员的群内对话 → 系统提示里的群规则 + 会话缓存键；不是群对话返回 null */
	info(agentId: string, conversationId: string): { key: string; rules: string[] } | null;
	/** 群相关工具：群里（管理者派活/提议加人），普通对话里（propose_room） */
	extensions(agentId: string, conversationId: string | null, taskId: string | null): { name: string; factory: never }[];
	/** 这个助理是否有群聊回合在进行（启动恢复时不在主对话里续跑） */
	busyInRoom(agentId: string): boolean;
}
export let roomHooks: RoomHooks | null = null;
export function setRoomHooks(h: RoomHooks) {
	roomHooks = h;
}
