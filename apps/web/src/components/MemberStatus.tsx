import { useEffect, useState } from "react";
import { CircleCheck, Crown, Hand } from "lucide-react";
import { t } from "../i18n";
import type { Agent, Message, Room } from "../types";
import { agentActivity, memberActivity, pendingCardOf, roomSummary, type ActState } from "../member-status";
import { useHelperBriefs } from "./Subagents";
import { timeAgo } from "./Tasks";
import { Avatar, cx } from "./ui";

/** 状态圆点：工作中绿色慢闪、等你黄色、空闲灰色（群成员条和单聊顶部共用）。 */
export function ActDot({ state, className }: { state: ActState; className?: string }) {
	return <i className={cx("pa-act-dot", state, className)} aria-hidden />;
}

/**
 * 群顶部成员条：最左边是群的总状态（几人在干活 / 有人等你 / 都停下了），每个成员胶囊带状态圆点和一行在做什么。
 * 数据：room.state（谁在说话 / 排队）、群里帮手（群任务执行）、消息里没处理的审批 / 提问卡；状态规则在 member-status.ts。
 */
export function RoomMembers({ room, list, onOpen }: { room: Room; list: Message[]; onOpen: (agentId: string) => void }) {
	const helpers = useHelperBriefs({ room: room.id });
	const active = room.members.filter((m) => !m.left);
	const st = room.state;
	const acts = active.map((m) => memberActivity({ agentId: m.agentId, current: st.current, queue: st.queue, pending: pendingCardOf(list, m.agentId), helpers }));
	const last = list[list.length - 1];
	const idle = acts.every((a) => a.state === "idle");
	// 全停下时「N 分钟前」要跟着走：只在空闲时每 30 秒重画一次
	const [, tick] = useState(0);
	useEffect(() => {
		if (!idle) return;
		const t = setInterval(() => tick((n) => n + 1), 30_000);
		return () => clearInterval(t);
	}, [idle]);
	const sum = roomSummary(acts, idle ? timeAgo(last ? Math.max(last.created_at, last.updated_at ?? 0) : null) : "");
	return (
		<div className="pa-room-members scrollbar-thin" data-testid="room-members">
			<span className={cx("pa-room-sum", sum.state)} data-testid="room-activity" data-state={sum.state} title={sum.state === "idle" ? "现在没有成员在干活" : undefined}>
				{sum.state === "work" ? <ActDot state="work" /> : sum.state === "wait" ? <Hand className="pa-ic" /> : <CircleCheck className="pa-ic" />}
				{sum.text}
			</span>
			{active.map((m, i) => (
				<button key={m.agentId} className={cx("pa-room-member", acts[i].state)} data-state={acts[i].state} onClick={() => onOpen(m.agentId)} title={`${m.name}${m.agentId === room.managerId ? "（管理者）" : ""}${m.scope === "room" ? " · 群专属" : ""} · ${acts[i].text}`}>
					<span className="relative shrink-0">
						<Avatar agentId={m.deleted ? undefined : m.agentId} text={m.avatar} color={m.color} size={24} />
						<ActDot state={acts[i].state} className="on-av" />
					</span>
					<span className="pa-room-member-txt">
						<span className="flex min-w-0 items-center gap-1">
							<span className="truncate">{m.name}</span>
							{m.agentId === room.managerId && <Crown size={11} className="shrink-0 text-amber-500" />}
						</span>
						<small data-testid="member-activity">{acts[i].text}</small>
					</span>
				</button>
			))}
		</div>
	);
}

/** 单聊顶部名字下面那行：状态圆点 + 在做什么（正在工作 / 帮手在做「X」/ 等你审批 / 空闲）+ 模型。 */
export function AgentStatusLine({ agent, conversation, list }: { agent: Agent; conversation?: string; list: Message[] }) {
	const helpers = useHelperBriefs({ agentId: agent.id, conversation });
	const act = agentActivity({ running: agent.status === "running", pending: pendingCardOf(list, agent.id), helpers });
	return (
		<small className="min-w-0" data-testid="agent-activity" data-state={act.state}>
			<ActDot state={act.state} />
			<span className="truncate">{t(act.text)} · {agent.model ? agent.model.id : "未配置模型"}</span>
		</small>
	);
}
