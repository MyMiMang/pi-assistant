/**
 * 撤回一条「还在 Pi 排队、助理还没读到」的插话（docs/design/recall-pending-message.md）。
 *
 * Pi 公开接口没有「按条删除」：session.clearQueue() / agent.clearAllQueues() 只能全清。所以撤回 = 在**同一个同步块**里
 *   ① 把 agent 的转向 / 跟进队列里的原消息对象全部取出（公开的 steeringMode="all" + peekQueuedMessages，只读不消费）；
 *   ② 找到目标（用户插话，文字对得上）；找不到 = 已经进了上下文（Pi 在消息开始进上下文时才把它从队列取走）→ 返回 false，什么都没动；
 *   ③ clearQueue() 清空，再用公开的 agent.steer / agent.followUp 把**原来的消息对象**（含插话前缀、附件、自定义消息）按原顺序排回去。
 * 整段没有 await / 回调，Pi 的取队列发生在异步循环里，插不进中间，不会丢、不会乱序；排回的是同一批对象，内容 / 顺序都不变
 * （包括我们用 sendCustomMessage 排进去的后台命令结果、唤醒，不需要另外记账）。
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";

type Msg = { role?: string; content?: unknown };
const textOf = (m: Msg): string => (Array.isArray(m.content) ? (m.content as { type?: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n") : typeof m.content === "string" ? m.content : "");
const matches = (m: Msg, text: string) => {
	if (m.role !== "user") return false;
	const t = textOf(m);
	return t === text || t.endsWith(`\n${text}`);
};

/**
 * 撤回排队中的一条用户插话（`text` = 用户原文，不含插话前缀 / 技能命令）。
 * true = 已从队列里拿掉，助理永远看不到；false = 队列里没有它（已读到 / 这一轮已结束）。
 */
export function recallQueuedSteer(session: AgentSession, text: string): boolean {
	if (!session.isStreaming) return false;
	const agent = session.agent;
	const steerMode = agent.steeringMode;
	const followMode = agent.followUpMode;
	agent.steeringMode = "all";
	agent.followUpMode = "all";
	try {
		// peekQueuedMessages：转向队列有东西就只给转向，否则给跟进。清掉转向再看一次，就能把两批各自取全
		const first = agent.peekQueuedMessages();
		agent.clearSteeringQueue();
		const second = agent.peekQueuedMessages();
		const followIsFirst = first.length > 0 && second.length > 0 && first[0] === second[0]; // 转向本来就是空的
		const steering = followIsFirst ? [] : first;
		const follow = followIsFirst ? first : second;
		const at = steering.findIndex((m) => matches(m as Msg, text));
		const keep = at < 0 ? steering : steering.filter((_, i) => i !== at);
		if (at >= 0) session.clearQueue(); // 同时清掉 Pi 自己记的待发文字列表
		else agent.clearAllQueues();
		for (const m of keep) agent.steer(m);
		for (const m of follow) agent.followUp(m);
		return at >= 0;
	} finally {
		agent.steeringMode = steerMode;
		agent.followUpMode = followMode;
	}
}
