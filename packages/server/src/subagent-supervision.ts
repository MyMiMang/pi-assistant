/**
 * 子代理事件的监督规则：执行结束不等于目标完成，更不等于用户要求停止。
 * 只生成分类型引导，不调模型、不修改任务、不自动 dispatch / 重试；
 * 主会话须结合最近真实用户授权与副作用证据决定，既有并发/预算/停止保护不变。
 */
import type { Subagent, SubagentEvent } from "./subagents.ts";

export const SUBAGENT_SUPERVISION_RULE = "子代理结束、失败或超时只是一次执行事件，不代表整体目标完成或用户叫停。核验结果与副作用后，原授权内有安全且明确的剩余步骤就继续推进，不要只汇报‘下一步可以做什么’或等用户再催；优先用原子代理续跑，不能盲目重放、无限重试或突破预算/权限。明确停止的工作不得自行恢复。目标、范围、完成标准或关键取舍不清楚时先追问必要问题，不猜用户意图；新的对外承诺、支出或破坏性改动若不在原授权内，先确认。明确授权的执行细节不反复请示。确需用户决策、权限或缺失信息时才提出具体阻塞；需等待外部结果就登记持久等待后结束本轮，不空转。";

export function subagentEventGuidance(kind: string): string {
	const scope = "这是子代理执行事件，不是新的用户授权；先遵守最近真实用户的要求、停止/取消及原有预算和权限范围。";
	if (kind === "stopped" || kind === "cancelled") {
		return `${scope}该子代理已被明确停止，只核验并汇报已知状态，不自动恢复这项已停止的工作；只有后续明确继续授权才可恢复。不要把子任务停止误当作无关工作的停止，也不要绕过用户对整体任务的停止。`;
	}
	if (kind === "stalled") {
		return `${scope}停滞告警不等于执行结束。先检查当前活动和真实进度；仍在执行时不要重复派发或同时续跑。需要等外部结果就登记持久等待；有安全的独立剩余工作可继续。向用户简短说明当前情况，不把告警当成整项任务暂停。`;
	}
	if (kind === "decided") {
		return `${scope}这是用户针对这个子代理卡住的问题给出的决定（来自提问卡片，是真实用户的回答）。按决定处理：要继续就用 subagent_resume 原任务、带上用户的新方向从断点继续（不要原样重试同一个做法）；要放下就停止推进并简短说明已做到哪一步。`;
	}
	if (kind === "done") {
		return `${scope}请核验产出，子代理自报完成不等于整体目标已达成。目标仍有明确且安全的剩余步骤时在原授权内继续推进，不要只汇报后等待用户再次说继续；确已完成才收口，确需用户决策或权限才提具体问题。`;
	}
	if (kind === "failed" || kind === "timeout" || kind === "lost") {
		return `${scope}本次执行失败、超时或中断，不是用户叫停，也不撤销整体任务的原授权。先用 subagent_list 查完整记录，核验已保存进度、产物及中断时可能已发生的副作用；核验后有安全且明确的下一步就用 subagent_resume 原任务从断点继续，或由主会话接手，并简短报告正在采取的行动，无需等用户再次催促。不要从头重做、重复派发、绕过权限/凭据/停止或无限重试；真正受阻时说明具体原因和所需决定。`;
	}
	return `${scope}事件状态不明确，先核实执行与产物，不猜测成功或从头重跑；核实后按原授权决定安全下一步。`;
}

const clip = (s: string, n: number) => {
	const v = (s ?? "").replace(/\s+/g, " ").trim();
	return v.length > n ? `${v.slice(0, n)}…` : v;
};
/** notify 摘要的截断长度：完整内容用 subagent_list 按 id 查，不重复整段 task/结果（省 token）。 */
export const SUBAGENT_SUMMARY_CLIP = 300;
/**
 * 子代理事件通知的短文案（纯函数，便于单测）：标题 / 摘要都截断；
 * 摘要被截断时明确给出「按子代理 ID 查全文」的入口，避免模型以为已经看全。
 */
export function subagentNotifyText(r: Subagent, event: SubagentEvent, artifacts: string): string {
	const marker = `（子代理事件 ${event.id}）`;
	const kindLabel = ({ done: "已完成", failed: "失败", stopped: "已停止", timeout: "超时", lost: "中断待核验", stalled: "停滞", decided: "等到了用户的决定" } as Record<string, string>)[event.kind] ?? event.kind;
	const title = clip(r.task, 60);
	const raw = (event.kind === "decided" ? event.reason : r.result_summary || event.reason) || "";
	const summary = clip(raw, SUBAGENT_SUMMARY_CLIP);
	const clipped = raw.replace(/\s+/g, " ").trim().length > SUBAGENT_SUMMARY_CLIP;
	return [
		`${marker}子代理「${title}」${kindLabel}${summary ? `：${summary}` : ""}`,
		`子代理 ID：${r.id}。${clipped ? `上面摘要已截断到 ${SUBAGENT_SUMMARY_CLIP} 字；` : ""}需要完整任务说明或结果时，用 subagent_list 按子代理 ID 查全文（subagent_list{subagent_id:"${r.id}"}）。`,
		`产出文件：\n${artifacts || "无"}`,
		subagentEventGuidance(event.kind),
	].join("\n");
}
