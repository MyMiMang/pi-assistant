import { db } from "./db.ts";

/**
 * 主动提醒 / 定时任务结果等“助理先开口”的消息：按用户偏好选出要镜像的渠道会话（只选单聊，不发到群），
 * 并把它们绑定到这条消息所在的 Pi Assistant 对话 —— 之后 insertMessage 写库，出站镜像把副本发过去；
 * 用户在渠道里的回复也会落进同一个对话（带渠道标记）。必须在 insertMessage 之前调用。
 * pref：auto = 这个助理所有已连接渠道的单聊；app = 不镜像；其它 = 指定渠道 id。
 */
export function bindMirrors(agentId: string, conversationId: string, pref: string) {
	if (pref === "app") return [];
	const peers = db
		.prepare("SELECT p.channel_id, p.peer_id FROM channel_peers p JOIN channels c ON c.id = p.channel_id WHERE c.agent_id = ? AND c.enabled = 1 AND p.allowed = 1 AND p.is_group = 0 AND p.ctx IS NOT NULL AND p.conversation_id IS NOT NULL")
		.all(agentId) as { channel_id: string; peer_id: string }[];
	const chosen = pref === "auto" ? peers : peers.filter((p) => p.channel_id === pref);
	for (const p of chosen) db.prepare("UPDATE channel_peers SET conversation_id = ? WHERE channel_id = ? AND peer_id = ?").run(conversationId, p.channel_id, p.peer_id);
	return chosen;
}
