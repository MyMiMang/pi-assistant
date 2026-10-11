import { CheckCircle2, Clock, Loader2, ShieldAlert, Sparkles, XCircle } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import type { Message } from "../types";
import Markdown from "./Markdown";
import { cx } from "./ui";

/** 结果卡片：审批 / 选项提问 / 后台任务（样式来自主题的 .pa-card 系列） */
export function ApprovalCard({ m }: { m: Message }) {
	const meta = m.meta;
	const [busy, setBusy] = useState(false);
	const pending = meta.status === "pending";
	const decide = async (approved: boolean) => {
		setBusy(true);
		try {
			await api(`/api/requests/${meta.requestId}`, { method: "POST", json: { approved } });
		} finally {
			setBusy(false);
		}
	};
	const input = (meta.input ?? {}) as Record<string, unknown>;
	const cmd = (input.command as string) ?? JSON.stringify(input, null, 2);
	const action = String(meta.summary ?? "").split("：")[0] || "执行操作";
	return (
		<div className={cx("pa-card pa-approval w-full max-w-[560px]", meta.status === "approved" && "approved", meta.status === "rejected" && "rejected")} data-testid="approval-card">
			<div className="pa-card-top">
				<ShieldAlert className="pa-ic warn" />
				<b>{t("需要你的批准")}</b>
				<span className="pa-tag">{meta.risk === "high" ? "高风险 · " : ""}{meta.toolName ?? action}</span>
			</div>
			<div className="pa-kv">
				<span>操作</span>
				<b>{action}</b>
			</div>
			<pre className="pa-pre">{cmd}</pre>
			{meta.taskId && <div className="mt-2 text-xs text-mut2">来自后台任务</div>}
			{pending ? (
				<div className="pa-actions">
					<button className="pa-btn ghost" disabled={busy} onClick={() => decide(false)}>
						{t("拒绝")}
					</button>
					<button className="pa-btn primary" disabled={busy} onClick={() => decide(true)}>
						{t("批准")}
					</button>
				</div>
			) : (
				<div className="mt-3">
					{meta.status === "approved" ? <span className="pa-res ok">✓ {t("已批准")}</span> : meta.status === "rejected" ? <span className="pa-res no">{t("已拒绝")}</span> : <span className="pa-res no">{t("已过期")}</span>}
				</div>
			)}
		</div>
	);
}

export function QuestionCard({ m }: { m: Message }) {
	const meta = m.meta;
	const [text, setText] = useState("");
	const pending = meta.status === "pending";
	const answer = (a: string) => api(`/api/requests/${meta.requestId}`, { method: "POST", json: { answer: a } });
	const options = (meta.options as string[]) ?? [];
	return (
		<div className="pa-card pa-question w-full max-w-[560px]">
			<div className="pa-card-top">
				<Sparkles className="pa-ic accent" />
				<b>{meta.question}</b>
				{!pending && <span className="pa-tag">已回答</span>}
			</div>
			<div className="pa-opts">
				{options.map((o, i) => (
					<button key={o} disabled={!pending && meta.answer !== o} onClick={() => pending && answer(o)} className={cx("pa-opt", meta.answer === o && "picked", !pending && meta.answer !== o && "opacity-50")}>
						{o}
						{pending && i === 0 && meta.recommended === o && <small>推荐</small>}
					</button>
				))}
			</div>
			{pending && meta.allowFreeText && (
				<form className="mt-3 flex gap-2" onSubmit={(e) => (e.preventDefault(), text.trim() && answer(text.trim()))}>
					<input className="pa-input" placeholder="或者直接输入回答…" value={text} onChange={(e) => setText(e.target.value)} />
					<button className="pa-btn primary" type="submit">
						{t("发送")}
					</button>
				</form>
			)}
			{!pending && meta.answer && !options.includes(meta.answer) && <div className="mt-2 text-sm text-mut">你的回答：{meta.answer}</div>}
		</div>
	);
}

export function TaskCard({ m }: { m: Message }) {
	const meta = m.meta;
	const [open, setOpen] = useState(false);
	const icon =
		meta.status === "done" ? <CheckCircle2 className="pa-ic ok" /> : meta.status === "failed" ? <XCircle className="pa-ic text-red-500" /> : meta.status === "cancelled" ? <XCircle className="pa-ic text-mut2" /> : meta.status === "queued" ? <Clock className="pa-ic text-mut2" /> : <Loader2 className="pa-ic animate-spin text-accent" />;
	const label = { queued: "排队中", running: "进行中", done: "已完成", failed: "失败", cancelled: "已取消" }[meta.status as string] ?? meta.status;
	return (
		<div className="pa-card pa-question w-full max-w-[560px]">
			<div className="pa-card-top !mb-0">
				{icon}
				<b className="truncate">后台任务：{meta.title}</b>
				<span className="pa-tag">{label}</span>
				{(meta.status === "running" || meta.status === "queued") && (
					<button className="pa-btn sm ghost" onClick={() => api(`/api/tasks/${meta.taskId}/cancel`, { method: "POST" })}>
						{t("取消")}
					</button>
				)}
			</div>
			{meta.result && (
				<div className="mt-2">
					<button className="text-xs text-accent" onClick={() => setOpen(!open)}>
						{open ? "收起结果" : "查看结果"}
					</button>
					{open && (
						<div className="pa-pre !font-[inherit] !text-[13px]">
							<Markdown text={meta.result} />
						</div>
					)}
				</div>
			)}
			{meta.error && <div className="mt-2 text-xs text-red-600">{meta.error}</div>}
		</div>
	);
}
