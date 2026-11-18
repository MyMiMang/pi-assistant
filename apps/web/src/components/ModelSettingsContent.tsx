import { useStore } from "../store";
import { ModelPicker } from "./ModelPicker";
import { ContextDetails } from "./ContextRing";
import { AgentImageModel } from "./ImageModels";
import { SubagentModels } from "./Subagents";
import { Help } from "./ui";

/** 模型：聊天模型复用输入框那套选择器——地方够就把弹层内容（思考 / Fast / 模型目录）直接铺开，窄或矮时退回同款按钮；各自即时保存。画图和子代理各一个折叠区。 */
export function ModelSettingsContent({ agentId }: { agentId: string }) {
	const room = useStore((s) => s.rooms.find((r) => r.id === s.room));
	const member = room?.members.find((m) => m.agentId === agentId && !m.left);
	const current = useStore((s) => s.convs[agentId]?.current);
	const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
	const inRoom = !!member?.conversationId;
	const cid = inRoom ? member.conversationId : current;
	const running = inRoom ? room?.state.current?.agentId === agentId || !!room?.state.background?.includes(agentId) || !!room?.state.tidying?.includes(agentId) : agent?.status === "running";
	return (
		<div className="text-sm" data-testid="agent-models-tab">
			<div className="pa-info-sechead">
				<strong>聊天模型<Help>和输入框下面的模型按钮是同一个设置：换模型、调思考强度、开关 Fast，改完立刻保存。思考强度选「跟随默认」时按全局默认档位走。面板窄或窗口矮时会收成一个按钮，点开是同样的内容。</Help></strong>
			</div>
			<p className="pa-info-lead">这个助理平时用的大脑</p>
			<ModelPicker agentId={agentId} allowThinkingFollow hideTextInNarrow={false} placement="down" buttonClass="max-w-full" layout="auto" />
			{cid && <section className="mt-4" data-testid="agent-context">
				<div className="pa-info-sechead"><strong>{inRoom ? "在本群的上下文" : "上下文"}<Help>上下文是模型这次能一起阅读的内容，和长期记忆不同。群里的每位成员有独立的上下文；整理会把较早内容压缩成摘要，原始聊天记录仍然保留。会话尚未加载时，已用量取最近一次调用的读入量，累计用量暂不显示。</Help></strong></div>
				<p className="pa-info-lead">它现在记着多少内容；快满时会自动整理，也可以手动整理</p>
				<ContextDetails key={cid} conversationId={cid} running={running} />
			</section>}
			<div className="mt-3">
				<AgentImageModel agentId={agentId} />
			</div>
			<SubagentModels agentId={agentId} />
		</div>
	);
}

