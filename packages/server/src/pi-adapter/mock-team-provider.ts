/**
 * 项目通知 / 关键点 / 交付的 Mock 行为（决策 0019 第 5 步，e2e 用，从 mock-room-provider.ts 拆出来控制单文件行数）。
 * 只在管理者被「项目阶段完成了 / 所有阶段都完成了」叫醒（唤醒原因里有，且没有同时要核验的提交），或这一轮自己核验通过、核验结果里带着这条提醒时接管，其余返回 null 走原有 Mock：
 *  - 阶段完成：回两三句话的进度通知；方案目标里写了「关键点」、且完成的是第一个阶段时，先 room_checkpoint（选项「可以，继续」「要改」）；
 *  - 所有阶段都完成：方案目标里写了「交付卡」时 room_project_done（deliverables 取成员交付的 out.txt，带 howToUse / notDone），否则只回一句话（不改变原有 e2e 里项目一直进行中的行为）。
 */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { Msg } from "./mock-provider.ts";

const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b: { text?: string }) => b.text ?? "").join("") : "");

export function teamReply(u: string, systemPrompt: string, last: Msg, messages: Msg[]) {
	if (!u.startsWith("（群聊「") || !u.includes("（管理者）")) return null;
	const lastUser = [...messages].reverse().find((m) => m.role === "user");
	const since = messages.slice(messages.lastIndexOf(lastUser ?? last) + 1).filter((m) => m.role === "toolResult");
	// 管理者自己核验让阶段完成时，提醒在这一轮 work_verify 的结果里（不另叫醒）；否则看唤醒原因
	const verified = textOf([...since].reverse().find((m) => m.toolName === "work_verify") ?? ({} as Msg));
	const fromVerify = /（项目编号 pj_[a-z0-9]+）(?:的阶段「|所有阶段都完成了)/.test(verified) ? verified : "";
	const wake = u.split("唤醒原因：")[1] ?? "";
	if (!fromVerify && /等你核验/.test(wake)) return null;
	const reasons = fromVerify || wake;
	const all = reasons.match(/项目「[^」]*」（项目编号 (pj_[a-z0-9]+)）所有阶段都完成了/);
	const stage = reasons.match(/项目「[^」]*」（项目编号 (pj_[a-z0-9]+)）的阶段「([^」]+)」完成了/);
	const pid = all?.[1] ?? stage?.[1];
	if (!pid) return null;
	const me = u.match(/· 你是 ([^（）\n]+)/)?.[1]?.trim() ?? "我";
	// 这个项目的方案摘要（系统提示里 planText 渲染的那一段）
	const block = systemPrompt.slice(Math.max(0, systemPrompt.indexOf(pid)));
	const goal = block.match(/目标：([^\n]*)/)?.[1] ?? "";
	const did = (tool: string) => since.some((m) => m.toolName === tool);
	if (all) {
		if (last.role === "toolResult" && last.toolName === "room_project_done") return fauxAssistantMessage(`${me}：${/已结束/.test(textOf(last)) ? "项目交付好了，交付卡在上面。" : textOf(last).slice(0, 80)}`);
		if (!/交付卡/.test(goal)) return fauxAssistantMessage(`${me}：所有阶段都做完了，我先核对完成标准。`);
		return fauxAssistantMessage([
			fauxToolCall("room_project_done", {
				projectId: pid,
				summary: "全部阶段做完了，成果经过核验，满足完成标准",
				deliverables: ["out.txt"],
				howToUse: "打开 out.txt，第 3 行是检查点",
				notDone: "暂无；后续可以补充更多数据来源",
			}),
		]);
	}
	const name = stage![2];
	const firstStage = block.match(/阶段：1\.\s*([^→；\n]+?)(?:\s*→|；|\n|$)/)?.[1]?.trim();
	if (last.role === "toolResult" && last.toolName === "room_checkpoint") return fauxAssistantMessage(`${me}：已请你看关键点，你答复后我再继续。`);
	if (/关键点/.test(goal) && name === firstStage && !did("room_checkpoint")) {
		const cp = block.match(/关键点（[^）]*）：([^；\n]+)/)?.[1]?.trim() || "草稿方向";
		return fauxAssistantMessage([fauxToolCall("room_checkpoint", { projectId: pid, checkpoint: cp, message: `「${name}」阶段做完了，先请你看一眼方向对不对，再继续下一阶段。`, options: ["可以，继续", "要改"] })]);
	}
	return fauxAssistantMessage(`${me}：阶段「${name}」做完了，接下来做下一阶段，暂时不需要你做什么。`);
}
