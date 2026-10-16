import type { ReactNode } from "react";
import { Badge, cx } from "./ui";

/**
 * 任务展示共用件（聊天卡片 / 任务概览 / 信息面板后台任务）。
 * 这里只做「显示」——不碰调度、不改任务语义。
 */

/** 工具名 → 中文（和 ChatMessages 的 TOOL_LABEL 同口径，任务卡片只需要常用的几个） */
export const STEP_LABEL: Record<string, string> = {
	bash: "运行命令",
	read: "读取文件",
	write: "写入文件",
	edit: "修改文件",
	ls: "查看目录",
	find: "查找文件",
	grep: "搜索内容",
	deliver_file: "发送文件",
	ask_user: "询问你",
	spawn_subagent: "派子代理",
	subagent_message: "补充要求",
	subagent_stop: "停止子代理",
	computer_screenshot: "查看屏幕",
	request_handoff: "请你接手",
	web_fetch: "打开网页",
	web_search: "搜索网页",
	browser: "操作浏览器",
};
export const stepLabel = (name?: string) => (name ? STEP_LABEL[name] ?? name : "");

export type TaskTone = "zinc" | "green" | "amber" | "red" | "accent";
/** 子代理（queued/running/stalled/done/failed/stopped/timeout/lost）和后台任务（cancelled）共用一套状态词 */
const STATUS: Record<string, { label: string; tone: TaskTone }> = {
	queued: { label: "排队中", tone: "zinc" },
	running: { label: "运行中", tone: "accent" },
	stalled: { label: "暂无进展", tone: "amber" },
	done: { label: "已完成", tone: "green" },
	failed: { label: "失败", tone: "red" },
	stopped: { label: "已停止", tone: "zinc" },
	timeout: { label: "超时", tone: "red" },
	lost: { label: "中断", tone: "red" },
	cancelled: { label: "已取消", tone: "zinc" },
};
export function taskStatus(status: string): { label: string; tone: TaskTone } {
	return STATUS[status] ?? { label: status, tone: "zinc" };
}
/** 还没结束、需要优先看的状态 */
export const taskLive = (status: string) => ["running", "stalled", "queued"].includes(status);

export function TaskBadge({ status }: { status: string }) {
	const s = taskStatus(status);
	return <Badge tone={s.tone}>{s.label}</Badge>;
}

/**
 * 从任务全文抽一个短标题：纯前端、有界，不调用模型、不消耗 token。
 * 全文不会丢——详情里仍显示原文（TaskInstructions / 任务详情首条消息）。
 */
export function taskTitle(text: string | undefined, max = 42): string {
	const raw = String(text ?? "").replace(/\s+/g, " ").trim();
	if (!raw) return "任务";
	// 去掉「子代理：」「（后台子代理任务）」这类前缀
	const s = raw.replace(/^[（(【\[]?\s*(?:后台)?子代理(?:任务)?\s*[）)】\]]?\s*[:：]?\s*/, "").trim() || raw;
	const cut = s.split(/[。！？；]|[.]\s/)[0].trim() || s;
	if (cut.length <= max) return cut;
	// 前半句里有冒号时，优先切在冒号，标题更像人话
	const colon = cut.search(/[:：]/);
	if (colon >= 6 && colon <= max) return cut.slice(0, colon);
	return `${cut.slice(0, max).trimEnd()}…`;
}

/** 相对时间（次要信息）：刚刚 / 3 分钟前 / 2 小时前 / 昨天 / 10月14日 */
export function timeAgo(ts: number | undefined | null): string {
	if (!ts) return "";
	const diff = Date.now() - ts;
	if (diff < 60_000) return "刚刚";
	if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
	if (diff < 2 * 86400_000) return "昨天";
	return new Date(ts).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

/** 折叠的任务全文说明：原生 <details>，键盘可用；prewrap + 长路径不横溢 */
export function TaskInstructions({ text, label = "查看任务说明" }: { text?: string; label?: string }) {
	if (!text?.trim()) return null;
	return (
		<details className="group mt-1" data-testid="task-instructions">
			<summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-accent hover:underline [&::-webkit-details-marker]:hidden">
				<span className="transition group-open:rotate-90">›</span>
				{label}
			</summary>
			<p className="mt-1.5 max-h-64 overflow-y-auto rounded-lg bg-hover px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-mut [overflow-wrap:anywhere]">{text}</p>
		</details>
	);
}

/**
 * 任务列表行：短标题 + 状态 badge + 次要信息（执行者 / 当前活动 / 更新时间）。
 * 给任务概览（可点开详情）和信息面板后台任务（只读）共用。
 */
export function TaskRow({ title, status, meta, time, onClick, testId, id, footer, active }: { title: string; status: string; meta?: ReactNode; time?: number; onClick?: () => void; testId?: string; id?: string; footer?: ReactNode; active?: boolean }) {
	const body = (
		<>
			<span className="flex min-w-0 flex-1 items-center gap-2">
				<span className="min-w-0 flex-1 truncate text-sm text-fg" title={title}>
					{title}
				</span>
				{active && <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[11px] text-accent" data-testid="task-current">当前</span>}
			</span>
			<TaskBadge status={status} />
		</>
	);
	const sub = (meta || time) && (
		<div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-mut2">
			{meta && <span className="min-w-0 truncate">{meta}</span>}
			{time ? <span className="ml-auto shrink-0">{timeAgo(time)}</span> : null}
		</div>
	);
	if (!onClick)
		return (
			<div className="w-full min-w-0 rounded-xl bg-hover px-3 py-2" data-testid={testId} data-id={id}>
				<div className="flex min-w-0 items-center gap-2">{body}</div>
				{sub}
				{footer}
			</div>
		);
	return (
		<button type="button" className={cx("w-full min-w-0 rounded-xl border bg-card px-3 py-2 text-left transition hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent", active ? "border-accent" : "border-line")} onClick={onClick} data-testid={testId} data-id={id} data-state={status} data-current={active ? "true" : undefined}>
			<div className="flex min-w-0 items-center gap-2">{body}</div>
			{sub}
			{footer}
		</button>
	);
}
