import type { ReactNode } from "react";
import { MessageCircleQuestion } from "lucide-react";
import type { Agent, Message, Room, WorkAsk } from "../types";
import { memberOf } from "./RoomChat";
import type { Part } from "./Chat";
import { Badge } from "./ui";

/** 成员之间的提问 / 回答（群消息 meta.kind 为 peer-ask / peer-answer）：气泡上加小标签，同一 askId 的问答看得出是一组。 */
export const isPeerMsg = (m: Message) => m.meta.kind === "peer-ask" || m.meta.kind === "peer-answer";

function PeerHead({ m, room, agents, list, onJump }: { m: Message; room: Room; agents: Agent[]; list: Message[]; onJump?: (id: string) => void }) {
	const isAsk = m.meta.kind === "peer-ask";
	const n = Number(m.meta.rounds) || 0;
	// 回答回指它回的那条提问（同一 askId、在它之前的最后一条提问）
	const ask = isAsk ? null : [...list].reverse().find((x) => x.meta.kind === "peer-ask" && x.meta.askId === m.meta.askId && x.created_at <= m.created_at) ?? null;
	const to = String(m.meta.to ?? "");
	const toName = m.meta.toName ? String(m.meta.toName) : room.members.find((x) => x.agentId === to || x.name === to)?.name ?? to;
	const askerName = ask ? memberOf(room, agents, ask.agent_id).name : "";
	return (
		<div className="pa-peer-head" data-testid="peer-head" data-peer={isAsk ? "ask" : "answer"} data-ask-id={String(m.meta.askId ?? "")}>
			<span className="pa-room-badge" data-testid="peer-tag">{isAsk ? "提问" : "回答"}{n ? ` · 第 ${n} 轮` : ""}</span>
			{isAsk && toName ? <span className="pa-peer-to" data-testid="peer-to">问 @{toName}</span> : null}
			{ask && onJump ? (
				<button type="button" className="pa-quoted" onClick={() => onJump(ask.id)} title="跳到这条提问" data-testid="peer-ref">
					<span className="pa-quoted-author">回复 {askerName} 的提问</span>
					<span className="pa-quoted-excerpt">{ask.content}</span>
				</button>
			) : null}
		</div>
	);
}

/** 包住一条群消息：不是成员互问就原样输出；是的话加标签行并标出分组（data-ask-id）。 */
export function PeerWrap({ p, room, agents, list, onJump, children }: { p: Part; room: Room; agents: Agent[]; list: Message[]; onJump?: (id: string) => void; children: ReactNode }) {
	if (p.kind !== "msg" || !isPeerMsg(p.m)) return <>{children}</>;
	return (
		<div className="pa-peer" data-testid="peer-msg" data-peer={p.m.meta.kind === "peer-ask" ? "ask" : "answer"} data-ask-id={String(p.m.meta.askId ?? "")}>
			<PeerHead m={p.m} room={room} agents={agents} list={list} onJump={onJump} />
			{children}
		</div>
	);
}

/** 任务详情里的「在等同事回答」：这个任务有没回完的提问（含已交给管理者的）才显示。 */
export function WorkAsks({ asks }: { asks?: WorkAsk[] }) {
	const open = (asks ?? []).filter((a) => a.status === "open" || a.status === "escalated");
	if (!open.length) return null;
	return (
		<section className="pa-work-block" data-testid="work-asks">
			<h4><MessageCircleQuestion className="pa-ic" />在等同事回答</h4>
			<ul className="space-y-2">
				{open.map((a) => (
					<li key={a.id} className="text-sm" data-testid="work-ask" data-kind={a.kind} data-status={a.status}>
						<div className="flex flex-wrap items-center gap-1.5">
							<span className="min-w-0 break-words">{a.kind === "upstream" ? `${a.fromName} 反馈前面的任务有问题，等 ${a.toName} 决定改不改` : `${a.fromName} 在等 ${a.toName} 回答`}</span>
							<Badge tone={a.status === "escalated" ? "amber" : "zinc"}>{a.status === "escalated" ? "已交给管理者" : `第 ${Math.max(1, a.rounds)} 轮`}</Badge>
						</div>
						{a.question ? <p className="mt-0.5 break-words text-xs text-mut">{a.question}</p> : null}
					</li>
				))}
			</ul>
		</section>
	);
}
