/**
 * 单聊「大事走方案」的 Mock 行为（docs/design/group-team.md §13，e2e 用，从 mock-provider.ts 拆出来控制单文件行数）。
 * 只在单聊会话（工具里有 chat_plan）里接管，其余返回 null 走原有 Mock：
 *  - 用户消息含「做个大事」：chat_plan 出一个两阶段的方案卡，然后停下等用户；
 *  - 用户说「可以」/「就这么干」且有一份还没做完的方案：chat_project_start 确认；用户点按钮则收到「（用户确认了项目…」通知，直接开工；
 *  - 开工后依次：写一个文件 → chat_stage_done 两个阶段 → chat_project_done 交付（带这个文件）→ 一句收尾。
 *  - 用户消息里带「慢」的方案（项目名带「（慢）」）：开工后先跑一条 sleep 命令再写文件，留出项目进行中的时间窗口（测顶部 chip / 面板 / 中途停下）。
 */
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { Msg } from "./mock-provider.ts";

const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b: { text?: string }) => b.text ?? "").join("") : "");
export const MOCK_CHAT_PLAN_FILE = "chat-plan-result.md";

export function chatPlanReply(rawU: string, last: Msg, messages: Msg[], tools: { name: string }[]) {
	// 助理还在收尾时用户就说话，会作为插话送达（带这句前缀）；当成普通的一句话处理
	const u = rawU.replace(/^（你工作时用户发来的新消息）\n?/, "");
	if (!tools.some((t) => t.name === "chat_plan")) return null;
	// 主动推进 / 巡检 / 技能建议的提示里会引用用户之前说过的话（可能含「做个大事」）：那不是用户在说话，交给原有的 Mock
	if (/^（(主动推进|技能建议)|这是(一次主动巡检|你约好的跟进|每日简报)/.test(u)) return null;
	const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
	const since = messages.slice(lastUserIdx + 1).filter((m) => m.role === "toolResult");
	const results = messages.filter((m) => m.role === "toolResult");
	// 最近一份方案卡的项目编号（还没交付的才算）
	const planned = [...results].reverse().find((m) => m.toolName === "chat_plan");
	const pending = planned && !results.slice(results.indexOf(planned) + 1).some((m) => m.toolName === "chat_project_done") ? textOf(planned).match(/项目编号 (cp_[a-z0-9]+)/)?.[1] : undefined;

	if (/做个大事/.test(u)) {
		if (last.role === "toolResult") return fauxAssistantMessage("方案卡发给你了，看一眼：没问题就点「就这么干」，或者直接回我「可以」；想改哪里直接说。");
		return fauxAssistantMessage([
			fauxText("这件事分几步，我先把方案理一下。"),
			fauxToolCall("chat_plan", {
				title: /慢/.test(u) ? "整理一份小结（慢）" : "整理一份小结",
				goal: "整理一份关于这件大事的小结文档",
				doneCriteria: `工作区里有 ${MOCK_CHAT_PLAN_FILE}，分「要点」和「成稿」两部分`,
				assumptions: ["按通用结构整理，不涉及具体行业", "篇幅控制在一页以内"],
				roles: [{ member: "我", does: "整理要点并成稿" }],
				stages: [{ name: "梳理要点", output: "要点清单" }, { name: "整理成稿", output: "一份完整的小结文件" }],
				checkpoints: ["要点清单出来后请你看一眼方向"],
				deliverables: `${MOCK_CHAT_PLAN_FILE}（小结文档）`,
				scale: "几分钟",
			}),
		]);
	}
	const button = u.match(/^（用户确认了项目「[^」]*」（项目编号 (cp_[a-z0-9]+)）/)?.[1];
	const said = /^(可以|就这么干|行|好的?，?开始)[。！!\s]*$/.test(u.trim());
	const pid = button ?? (said ? pending : undefined);
	if (!pid) return null;
	// 用户在聊天里说「可以」：先确认
	if (said && !button && !since.length) return fauxAssistantMessage([fauxText("好，我开始做。"), fauxToolCall("chat_project_start", { projectId: pid })]);
	const did = since.filter((m) => m.toolName !== "chat_project_start").map((m) => m.toolName);
	const slow = u.includes("（慢）") ? [() => fauxAssistantMessage([fauxText("好，我先做第一阶段，要花一点时间。"), fauxToolCall("bash", { command: "sleep 6; echo 第一阶段准备好了" })])] : [];
	const steps = [
		...slow,
		() => fauxAssistantMessage([fauxText("好，我先做第一阶段。"), fauxToolCall("write", { path: MOCK_CHAT_PLAN_FILE, content: "# 小结\n\n## 要点\n- 要点一\n- 要点二\n\n## 成稿\n这是整理好的小结。\n" })]),
		() => fauxAssistantMessage([fauxToolCall("chat_stage_done", { projectId: pid, stage: "梳理要点", note: "要点清单整理好了" })]),
		() => fauxAssistantMessage([fauxToolCall("chat_stage_done", { projectId: pid, stage: "2", note: "小结成稿了" })]),
		() => fauxAssistantMessage([fauxToolCall("chat_project_done", { projectId: pid, summary: "小结整理好了：要点和成稿都有，放在交付的文件里。", deliverables: [MOCK_CHAT_PLAN_FILE], howToUse: "点开交付卡里的文件就能看。", notDone: "暂时没有需要补的。" })]),
	];
	return steps[did.length]?.() ?? fauxAssistantMessage("项目做完了，成果在上面的交付卡里。");
}
