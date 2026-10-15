/**
 * 输入框工具栏里、模型选择左边的上下文圆环：圆环 = 当前上下文占模型上下文窗口的比例。
 * 鼠标悬停显示简要（已用 / 总量 / 百分比）；点击弹出详情：上下文、本会话累计 token（输入/输出/缓存）和费用、整理上下文。
 */
import { modelLabel } from "./ModelOptions";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { Button, cx } from "./ui";
import { useCompactDialog } from "./CompactDialog";

interface Ctx {
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
	model: { provider: string; providerName?: string; id: string; name?: string } | null;
	session: { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; cost: number; userMessages: number; assistantMessages: number; toolCalls: number } | null;
}

export const fmtTok = (n: number | null | undefined) => (n == null ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e5 ? 0 : 1)}k` : String(n));

export function ContextRing({ agentId, running }: { agentId: string; running: boolean }) {
	const cid = useStore((s) => s.convs[agentId]?.current ?? null);
	const [c, setC] = useState<Ctx | null>(null);
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const [compactNode, openCompact] = useCompactDialog(cid);
	const load = () => (cid ? api<Ctx>(`/api/conversations/${cid}/context`).then(setC).catch(() => setC(null)) : setC(null));
	useEffect(() => {
		void load();
	}, [cid, running]);
	useEffect(() => {
		if (!open) return;
		void load();
		const h = (e: Event) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
		document.addEventListener("pointerdown", h);
		return () => document.removeEventListener("pointerdown", h);
	}, [open]);
	const pct = c?.percent ?? 0;
	const r = 8;
	const len = 2 * Math.PI * r;
	const tone = pct >= 85 ? "#ef4444" : pct >= 60 ? "#f59e0b" : "var(--acc)";
	const brief = c?.tokens != null ? `上下文 ${fmtTok(c.tokens)} / ${fmtTok(c.contextWindow)}（${c.percent ?? 0}%）` : "上下文：发送消息后显示";
	return (
		<div className="relative" ref={ref}>
			<button className="pa-ctx-ring" onClick={() => setOpen(!open)} title={brief} aria-label="上下文用量" data-testid="context-ring" data-percent={c?.percent ?? ""}>
				<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
					<circle cx="10" cy="10" r={r} fill="none" stroke="currentColor" strokeOpacity=".22" strokeWidth="2.4" />
					<circle cx="10" cy="10" r={r} fill="none" stroke={tone} strokeWidth="2.4" strokeLinecap="round" strokeDasharray={`${(len * pct) / 100} ${len}`} transform="rotate(-90 10 10)" style={{ transition: "stroke-dasharray .4s" }} />
				</svg>
			</button>
			{open && (
				<div className="pa-pop absolute bottom-full right-0 z-30 mb-2 w-72 space-y-3 rounded-xl border border-line bg-card p-3 text-sm shadow-lg" data-testid="context-pop">
					<div>
						<div className="flex items-baseline justify-between">
							<b>上下文</b>
							<span className="text-xs text-mut">{c?.model ? modelLabel(c.model) : ""}</span>
						</div>
						<div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-hover">
							<div className="h-full rounded-full" style={{ width: `${pct}%`, background: tone }} />
						</div>
						<div className="mt-1 flex justify-between text-xs text-mut">
							<span>
								已用 {fmtTok(c?.tokens)} / {fmtTok(c?.contextWindow)}
							</span>
							<span>{c?.percent != null ? `${c.percent}%` : "—"}</span>
						</div>
					</div>
					{c?.session && (
						<div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
							<div className="col-span-2 text-sm font-semibold">本次对话累计</div>
							<span className="text-mut">输入</span>
							<span className="text-right tabular-nums">{fmtTok(c.session.tokens.input)}</span>
							<span className="text-mut">输出</span>
							<span className="text-right tabular-nums">{fmtTok(c.session.tokens.output)}</span>
							<span className="text-mut">缓存读 / 写</span>
							<span className="text-right tabular-nums">
								{fmtTok(c.session.tokens.cacheRead)} / {fmtTok(c.session.tokens.cacheWrite)}
							</span>
							<span className="text-mut">合计</span>
							<span className="text-right font-medium tabular-nums">{fmtTok(c.session.tokens.total)}</span>
							{c.session.cost > 0 && (
								<>
									<span className="text-mut">费用</span>
									<span className="text-right tabular-nums">${c.session.cost.toFixed(4)}</span>
								</>
							)}
							<span className="text-mut">消息 / 工具调用</span>
							<span className="text-right tabular-nums">
								{c.session.userMessages + c.session.assistantMessages} / {c.session.toolCalls}
							</span>
						</div>
					)}
					{!c?.session && <div className="text-xs text-mut">发送消息后显示用量。</div>}
					<div className={cx("flex justify-end", !cid && "hidden")}>
						<Button size="sm" variant="outline" disabled={running || !c?.tokens} onClick={() => openCompact(() => void load())} title={running ? "助理正在工作，等这一轮结束再整理" : "把较早的对话压缩成摘要，腾出上下文"} data-testid="context-compact">
							整理上下文
						</Button>
					</div>
				</div>
			)}
			{compactNode}
		</div>
	);
}
