import { CheckCircle2, Clock, Loader2, ShieldAlert, XCircle } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import type { Message } from "../types";
import Markdown from "./Markdown";
import { Badge, Button, cx, Input } from "./ui";

const statusBadge = (s: string) =>
	s === "approved" ? <Badge tone="green">{t("已批准")}</Badge> : s === "rejected" ? <Badge tone="red">{t("已拒绝")}</Badge> : s === "expired" ? <Badge>{t("已过期")}</Badge> : s === "answered" ? <Badge tone="green">已回答</Badge> : <Badge tone="amber">等待你处理</Badge>;

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
	const cmd = meta.input?.command ?? JSON.stringify(meta.input, null, 2);
	return (
		<div className={cx("w-full max-w-lg rounded-2xl border p-4", pending ? "border-amber-300 bg-amber-50 dark:border-amber-700/60 dark:bg-amber-950/30" : "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900")}>
			<div className="flex items-center gap-2">
				<ShieldAlert size={18} className={pending ? "text-amber-600" : "text-zinc-400"} />
				<div className="font-medium">{t("需要你的批准")}</div>
				{meta.risk === "high" && pending && <Badge tone="red">高风险</Badge>}
				<div className="ml-auto">{statusBadge(meta.status)}</div>
			</div>
			<div className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">{String(meta.summary ?? "").split("：")[0]}</div>
			<pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-900 p-3 text-xs text-zinc-100">{cmd}</pre>
			{meta.taskId && <div className="mt-1 text-xs text-zinc-500">来自后台任务</div>}
			{pending && (
				<div className="mt-3 flex gap-2">
					<Button variant="primary" disabled={busy} onClick={() => decide(true)}>
						{t("批准")}
					</Button>
					<Button variant="outline" disabled={busy} onClick={() => decide(false)}>
						{t("拒绝")}
					</Button>
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
	return (
		<div className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
			<div className="flex items-start gap-2">
				<div className="flex-1 text-sm font-medium">{meta.question}</div>
				{!pending && statusBadge(meta.status)}
			</div>
			<div className="mt-3 flex flex-wrap gap-2">
				{(meta.options as string[]).map((o) => (
					<button
						key={o}
						disabled={!pending}
						onClick={() => answer(o)}
						className={cx(
							"rounded-full border px-3.5 py-1.5 text-sm transition",
							meta.answer === o ? "border-accent bg-accent text-white" : "border-zinc-300 hover:border-accent hover:text-accent disabled:opacity-50 dark:border-zinc-700",
						)}
					>
						{o}
					</button>
				))}
			</div>
			{pending && meta.allowFreeText && (
				<form className="mt-3 flex gap-2" onSubmit={(e) => (e.preventDefault(), text.trim() && answer(text.trim()))}>
					<Input placeholder="或者直接输入回答…" value={text} onChange={(e) => setText(e.target.value)} />
					<Button variant="primary" type="submit">
						{t("发送")}
					</Button>
				</form>
			)}
			{!pending && meta.answer && !(meta.options as string[]).includes(meta.answer) && <div className="mt-2 text-sm text-zinc-500">你的回答：{meta.answer}</div>}
		</div>
	);
}

export function TaskCard({ m }: { m: Message }) {
	const meta = m.meta;
	const [open, setOpen] = useState(false);
	const icon =
		meta.status === "done" ? <CheckCircle2 size={18} className="text-emerald-500" /> : meta.status === "failed" ? <XCircle size={18} className="text-red-500" /> : meta.status === "cancelled" ? <XCircle size={18} className="text-zinc-400" /> : meta.status === "queued" ? <Clock size={18} className="text-zinc-400" /> : <Loader2 size={18} className="animate-spin text-accent" />;
	const label = { queued: "排队中", running: "进行中", done: "已完成", failed: "失败", cancelled: "已取消" }[meta.status as string] ?? meta.status;
	return (
		<div className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
			<div className="flex items-center gap-2">
				{icon}
				<div className="text-sm font-medium">后台任务：{meta.title}</div>
				<div className="ml-auto flex items-center gap-1">
					<Badge tone={meta.status === "done" ? "green" : meta.status === "failed" ? "red" : "accent"}>{label}</Badge>
					{(meta.status === "running" || meta.status === "queued") && (
						<Button size="sm" variant="ghost" onClick={() => api(`/api/tasks/${meta.taskId}/cancel`, { method: "POST" })}>
							{t("取消")}
						</Button>
					)}
				</div>
			</div>
			{meta.result && (
				<div className="mt-2">
					<button className="text-xs text-accent" onClick={() => setOpen(!open)}>
						{open ? "收起结果" : "查看结果"}
					</button>
					{open && (
						<div className="mt-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/60">
							<Markdown text={meta.result} />
						</div>
					)}
				</div>
			)}
			{meta.error && <div className="mt-2 text-xs text-red-600">{meta.error}</div>}
		</div>
	);
}
