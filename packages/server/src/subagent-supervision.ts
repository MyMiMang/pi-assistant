/**
 * 子代理事件的监督规则：执行结束不等于目标完成，更不等于用户要求停止。
 * 只生成分类型引导，不调模型、不修改任务、不自动 dispatch / 重试；
 * 主会话须结合最近真实用户授权与副作用证据决定，既有并发/预算/停止保护不变。
 */
import type { Subagent, SubagentEvent } from "./subagents.ts";

export const SUBAGENT_SUPERVISION_RULE = "子代理结束、失败或超时只是一次执行事件，不代表整体目标完成或用户叫停。核验结果与副作用后，原授权内有安全且明确的剩余步骤就继续推进，不要只汇报‘下一步可以做什么’或等用户再催；优先用原子代理续跑，不能盲目重放、无限重试或突破预算/权限。明确停止的工作不得自行恢复。目标、范围、完成标准或关键取舍不清楚时先追问必要问题，不猜用户意图；新的对外承诺、支出或破坏性改动若不在原授权内，先确认。明确授权的执行细节不反复请示。确需用户决策、权限或缺失信息时才提出具体阻塞；需等待外部结果就登记持久等待后结束本轮，不空转。";

export function subagentEventGuidance(kind: string, reason = ""): string {
	const scope = "这是子代理执行事件，不是新的用户授权；先遵守最近真实用户的要求、停止/取消及原有预算和权限范围。";
	if (kind === "stopped" || kind === "cancelled") {
		return `${scope}该子代理已被明确停止，只核验并汇报已知状态，不自动恢复这项已停止的工作；只有后续明确继续授权才可恢复。不要把子任务停止误当作无关工作的停止，也不要绕过用户对整体任务的停止。`;
	}
	if (kind === "stalled") {
		return `${scope}系统已经诊断过：它不是在慢慢跑的长命令，而是真卡住了。卡住由你自己处理，目标不变：按上面这一级的建议做（看记录 → 带纠正 subagent_restart → 换做法 / 派新帮手 / 自己接手），同一原因反复出现就换策略，不要原样重试。不要问用户要不要继续等或停止；只有进展需要用户才能给的东西（批准、登录凭据、真正的取舍、只有用户有的资源）时，才直接说清楚要什么。`;
	}
	if (kind === "done") {
		return `${scope}请核验产出，子代理自报完成不等于整体目标已达成。目标仍有明确且安全的剩余步骤时在原授权内继续推进，不要只汇报后等待用户再次说继续；确已完成才收口，确需用户决策或权限才提具体问题。`;
	}
	if (kind === "failed" && /已用尽办法/.test(reason)) {
		return `${scope}这个帮手卡住后各级办法都试过了。向用户报告一份清楚的失败总结：目标是什么、做到了哪一步、试过哪些办法、卡在哪、你判断的原因；有可行的替代方案就一并说明。不要问用户要不要继续等或停止。`;
	}
	if (kind !== "lost" && /（需要用户：/.test(reason)) {
		return `${scope}这次受阻需要用户才能给的东西（见原因里「需要用户」）。直接向用户提出这个具体需要（例如批准哪一步、登录哪个服务、提供哪个凭据），说明拿到后你会怎么继续；不要笼统地说「卡住了」。`;
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
	const kindLabel = ({ done: "已完成", failed: "失败", stopped: "已停止", timeout: "超时", lost: "中断待核验", stalled: "卡住了" } as Record<string, string>)[event.kind] ?? event.kind;
	const title = clip(r.task, 60);
	const raw = (event.kind === "stalled" ? event.reason : r.result_summary || event.reason) || "";
	const summary = clip(raw, SUBAGENT_SUMMARY_CLIP);
	const clipped = raw.replace(/\s+/g, " ").trim().length > SUBAGENT_SUMMARY_CLIP;
	return [
		`${marker}子代理「${title}」${kindLabel}${summary ? `：${summary}` : ""}`,
		`子代理 ID：${r.id}。${clipped ? `上面摘要已截断到 ${SUBAGENT_SUMMARY_CLIP} 字；` : ""}需要完整任务说明或结果时，用 subagent_list 按子代理 ID 查全文（subagent_list{subagent_id:"${r.id}"}）。`,
		`产出文件：\n${artifacts || "无"}`,
		subagentEventGuidance(event.kind, event.reason),
	].join("\n");
}
