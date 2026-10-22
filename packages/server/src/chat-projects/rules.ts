/**
 * 单聊的「大事走方案」规则（docs/design/group-team.md §13）：
 *  - CHAT_PLAN_RULE：什么时候出方案（门槛比群聊高）、怎么出、确认后怎么推进、怎么交付；只加在单聊会话，不影响群聊 / 帮手 / 后台任务；
 *  - chatPlanRules：这个对话里待确认 / 进行中的项目（方案 + 进度）接在规则后面，agent-runtime 建会话时拼进系统提示，key 变了会话在空闲时重建。
 */
import { createHash } from "node:crypto";
import { db } from "../db.ts";
import { normalizePlan, planText } from "../rooms/plan.ts";
import { renderProgress } from "../rooms/progress.ts";
import { chatProjectProgress, chatProjectsOf, chatProjectView, type ChatProjectRow } from "./store.ts";

export const CHAT_PLAN_RULE = [
	"遇到大事先出方案（只管真正多步骤的大事：要做较久、有明确的交付物、需要分几步才能做完。小事、闲聊、一两步就能做完的，照常直接做，不要出方案；拿不准时按小事做）：",
	"1. 先想清楚：用户要做成什么、怎样算完成、哪些地方不确定。普通用户往往只有一句话，能按常理定的细节你用专业判断补上，写进方案的「假设」（最关键的放最前面）；用户说得很清楚就直接整理。",
	"2. 只问必须问的：只有真正没法替用户决定、又会影响结果的事（预算、给谁用、个人偏好这类）才用 ask_user 问，一次一两个并给出建议选项。",
	"3. 用 chat_plan 出方案卡：要做成什么、怎样算完成、假设、分几个阶段（每个阶段交出什么）、哪几个关键点会请用户看一眼（可以没有）、最后交给用户什么、需要用户提供什么、大概多久。方案卡要短，别写成长篇；分工只有你和你的帮手，可以不写。发出方案卡后这一轮就停下等用户，不要开工。",
	"4. 用户在方案卡上点「就这么干」，你会收到确认通知；用户直接在聊天里说「可以」「就这么干」之类的同意，则用 chat_project_start 开始（用户没回复过这张方案卡不能用，不能替用户确认）。用户想改哪里，改好后用 chat_plan（带 projectId）重新出方案卡；说「先不做」就回到平时。",
	"5. 开始后按方案的阶段推进，自己做，或把可以并行的块派给帮手。每个阶段做完用 chat_stage_done 标记（系统会在聊天里给用户一条简短进度，你不用再复述一遍）；到了方案里的关键点，用 ask_user 请用户看一眼，等回复再接着做；做的过程中发现方案要大改，用 chat_plan（带 projectId）出改过的方案请用户确认。",
	"6. 全部阶段做完后，对照完成标准逐条核对，再用 chat_project_done 交付（summary 写做成了什么；最终要给用户的文件放进 deliverables；怎么用写进 howToUse；还没做的和建议的下一步写进 notDone），然后回到平时。",
];

const view = (p: ChatProjectRow) => chatProjectView(p);

/** 这个对话里待确认 / 进行中的项目，写给模型看（空数组 = 没有）。 */
export function projectLines(projects: ChatProjectRow[]): string[] {
	return projects.map((p) => {
		if (p.status === "proposed") return `待用户确认的方案：\n${planText(view(p), "ask_user")}\n方案卡已经发给用户，等他确认；用户在聊天里同意就用 chat_project_start，提了修改意见就改好后用 chat_plan（带 projectId）重发。`;
		return `进行中的项目：\n${planText(view(p), "ask_user")}\n${renderProgress(chatProjectProgress(p))}${p.draft ? "\n有一份改过的方案在等用户确认；确认前按原方案继续。" : ""}\n按方案推进，阶段做完用 chat_stage_done 标记，全部做完用 chat_project_done 交付。`;
	});
}

/** 是不是用户可见的单聊对话（群成员的群内对话、巡检对话、任务对话都是隐藏的，不算）。 */
export const isChatConversation = (conversationId: string | null | undefined) => !!conversationId && !!db.prepare("SELECT 1 FROM conversations WHERE id = ? AND COALESCE(hidden, 0) = 0").get(conversationId);

/** 单聊会话的方案规则 + 会话缓存键（项目的方案 / 进度变了 key 就变，空闲时重建会话）；不是单聊返回 null。 */
export function chatPlanRules(conversationId: string): { key: string; rules: string[] } | null {
	if (!isChatConversation(conversationId)) return null;
	const lines = projectLines(chatProjectsOf(conversationId));
	return { key: createHash("sha1").update(lines.join("\n")).digest("hex").slice(0, 10), rules: [...CHAT_PLAN_RULE, ...lines] };
}

/** 用户点按钮确认后叫醒助理开工的隐藏提示（用户在聊天里说可以时，助理自己调 chat_project_start，不需要它）。 */
export const confirmWakeText = (title: string, projectId: string, revised: boolean) =>
	revised
		? `（用户确认了项目「${title}」（项目编号 ${projectId}）改过的方案）按新方案调整，继续推进。`
		: `（用户确认了项目「${title}」（项目编号 ${projectId}）的方案）按方案的阶段开始推进：每个阶段做完用 chat_stage_done 标记；方案里的关键点用 ask_user 请用户看一眼；全部做完核对完成标准后用 chat_project_done 交付。`;

/**
 * 渠道（微信 / 飞书等）里没有按钮：方案卡和交付卡发成一段文字。方案卡只发还在等用户的，告诉他回「可以」开始、想改直接说；
 * 交付卡发做成了什么 / 怎么用 / 还没做的（文件由渠道按能力另发）。别的状态不发（null）。
 */
export function chatCardText(meta: Record<string, unknown>): string | null {
	const s = (v: unknown) => String(v ?? "").trim();
	if (meta.kind === "project-delivery") return [`**交付：${s(meta.title)}**`, s(meta.summary), s(meta.howToUse) && `怎么用：${s(meta.howToUse)}`, s(meta.notDone) && `还没做的：${s(meta.notDone)}`].filter(Boolean).join("\n");
	if (meta.status !== "pending") return null;
	const plan = normalizePlan(meta.plan);
	const body = [
		`**${meta.revision ? "改过的方案" : "方案"}：${s(meta.title)}**`,
		plan.goal && `要做成什么：${plan.goal}`,
		plan.doneCriteria && `怎样算完成：${plan.doneCriteria}`,
		plan.assumptions.length > 0 && `我的理解：${plan.assumptions.join("；")}`,
		plan.stages.length > 0 && `分几步：${plan.stages.map((st, i) => `${i + 1}. ${st.name}${st.output ? `（${st.output}）` : ""}`).join("；")}`,
		plan.checkpoints.length > 0 && `会请你看一眼：${plan.checkpoints.join("；")}`,
		plan.deliverables && `最后交给你：${plan.deliverables}`,
	];
	return `${body.filter(Boolean).join("\n")}\n\n回复「可以」就开始；想改哪里直接告诉我。`;
}
