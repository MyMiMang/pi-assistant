import { Ban, CheckCircle2, ChevronLeft, ChevronRight, Loader2, Pause, Play, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { AuthImage } from "./Attachments";
import { Badge, Button, cx, fmtTime, Modal } from "./ui";

export interface ActionItem {
	id: string;
	agent_id: string;
	target: "sandbox" | "host";
	tool: string;
	input: Record<string, unknown>;
	summary: string;
	outcome: "running" | "done" | "error" | "blocked";
	approval: "approved" | "task" | "auto" | null;
	detail: string | null;
	shot: string | null;
	started_at: number;
	finished_at: number | null;
}
const OUTCOME = {
	running: { icon: Loader2, text: "进行中", cls: "text-mut animate-spin" },
	done: { icon: CheckCircle2, text: "完成", cls: "text-green-600" },
	error: { icon: XCircle, text: "出错", cls: "text-red-600" },
	blocked: { icon: Ban, text: "已拦下", cls: "text-amber-600" },
} as const;
const APPROVAL: Record<string, string> = { approved: "你批准了", task: "本任务内允许", auto: "" };

/** 电脑操作记录：列表 + 逐步回放（助理电脑的动作带截图） */
export function ActionLog({ agentId, target, limit = 100 }: { agentId?: string; target?: "sandbox" | "host"; limit?: number }) {
	const v = useStore((s) => s.actionsVersion);
	const agents = useStore((s) => s.agents);
	const [items, setItems] = useState<ActionItem[] | null>(null);
	const [at, setAt] = useState<number | null>(null);
	const q = new URLSearchParams({ ...(agentId ? { agentId } : {}), ...(target ? { target } : {}), limit: String(limit) }).toString();
	useEffect(() => {
		const t = setTimeout(() => void api(`/api/actions?${q}`).then((r) => setItems(r.items)), 150);
		return () => clearTimeout(t);
	}, [v, q]);
	if (!items) return null;
	const name = (id: string) => agents.find((a) => a.id === id)?.name ?? "";
	return (
		<div className="space-y-1" data-testid="action-log">
			{!items.length && <div className="text-xs text-mut">还没有操作记录</div>}
			{items.map((a, i) => {
				const o = OUTCOME[a.outcome];
				return (
					<button key={a.id} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-hover" onClick={() => setAt(i)} data-testid="action-item">
						<o.icon size={14} className={cx("shrink-0", o.cls)} />
						<span className="min-w-0 flex-1 truncate">{a.summary}</span>
						{a.approval && APPROVAL[a.approval] && <Badge tone="green">{APPROVAL[a.approval]}</Badge>}
						{a.shot && <span className="text-xs text-mut">📷</span>}
						{!agentId && <span className="hidden text-xs text-mut sm:inline">{name(a.agent_id)}</span>}
						<span className="shrink-0 text-xs text-mut">{fmtTime(a.started_at)}</span>
					</button>
				);
			})}
			{items.length > 0 && (
				<div className="flex justify-between pt-1">
					<Button size="sm" variant="ghost" onClick={() => setAt(items.length - 1)} data-testid="action-replay">
						<Play size={14} /> 从头回放
					</Button>
					<Button size="sm" variant="ghost" onClick={() => confirm("清空这些操作记录？") && api(`/api/actions?${agentId ? `agentId=${agentId}` : ""}`, { method: "DELETE" }).then(() => setItems([]))}>
						<Trash2 size={14} /> 清空
					</Button>
				</div>
			)}
			{at !== null && items[at] && <Replay items={items} at={at} setAt={setAt} />}
		</div>
	);
}

/** 回放：列表按时间倒序，回放按时间正序（← 更早，→ 更晚） */
function Replay({ items, at, setAt }: { items: ActionItem[]; at: number; setAt: (i: number | null) => void }) {
	const [playing, setPlaying] = useState(false);
	const a = items[at];
	const o = OUTCOME[a.outcome];
	useEffect(() => {
		if (!playing) return;
		if (at === 0) return setPlaying(false);
		const t = setTimeout(() => setAt(at - 1), 1500);
		return () => clearTimeout(t);
	}, [playing, at]);
	const step = items.length - at;
	const input = useMemo(() => JSON.stringify(a.input, null, 2), [a]);
	return (
		<Modal open onClose={() => setAt(null)} title={`操作回放 · 第 ${step} / ${items.length} 步`} wide>
			<div className="space-y-3" data-testid="action-replay-view">
				<div className="flex items-center gap-2 text-sm">
					<o.icon size={16} className={o.cls} />
					<b className="min-w-0 flex-1">{a.summary}</b>
					<Badge>{a.target === "host" ? "这台电脑" : "助理电脑"}</Badge>
					{a.approval && APPROVAL[a.approval] && (
						<Badge tone="green">
							<ShieldCheck size={12} /> {APPROVAL[a.approval]}
						</Badge>
					)}
					<span className="text-xs text-mut">{new Date(a.started_at).toLocaleString("zh-CN", { hour12: false })}</span>
				</div>
				{a.shot ? (
					<AuthImage path={`/api/actions/${a.id}/shot`} alt={a.summary} className="w-full rounded-lg border border-line" />
				) : (
					<div className="rounded-lg bg-hover p-6 text-center text-sm text-mut">{a.target === "host" ? "这台电脑上的动作不截屏（只记录动作本身）" : "这一步没有截图"}</div>
				)}
				<div className="grid gap-2 sm:grid-cols-2">
					<div>
						<div className="mb-1 text-xs text-mut">动作 · {a.tool}</div>
						<pre className="pa-pre max-h-40 overflow-auto text-xs">{input}</pre>
					</div>
					<div>
						<div className="mb-1 text-xs text-mut">结果 · {o.text}</div>
						<pre className="pa-pre max-h-40 overflow-auto whitespace-pre-wrap text-xs">{a.detail || "—"}</pre>
					</div>
				</div>
				<div className="flex items-center justify-center gap-2">
					<Button size="sm" disabled={at >= items.length - 1} onClick={() => setAt(at + 1)} aria-label="上一步">
						<ChevronLeft size={14} /> 上一步
					</Button>
					<Button size="sm" variant="primary" onClick={() => setPlaying(!playing)} data-testid="replay-play">
						{playing ? <Pause size={14} /> : <Play size={14} />} {playing ? "暂停" : "播放"}
					</Button>
					<Button size="sm" disabled={at <= 0} onClick={() => setAt(at - 1)} aria-label="下一步">
						下一步 <ChevronRight size={14} />
					</Button>
				</div>
			</div>
		</Modal>
	);
}
