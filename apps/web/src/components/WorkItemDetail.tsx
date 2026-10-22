import { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, Download, FileText, HelpCircle, Loader2, MessageSquare, Send } from "lucide-react";
import { api, download } from "../api";
import type { Room } from "../types";
import { Badge, Help, Modal, Select, fmtTime } from "./ui";

/** 任务详情、新建任务与「等你决定」的回答框；看板本体在 WorkItems.tsx。 */
export interface NeedsUser { question: string; options: string[]; reason: string; requestId: string | null; at: number }
export interface Escalation { kind: "stall" | "repeat" | "retry"; level: "manager" | "user"; at: number; note: string }
export type BoardGroup = "decision" | "stuck" | "doing" | "done" | "stopped";
export interface WorkSummary {
	id: string;
	roomId: string | null;
	title: string;
	status: string;
	statusLabel: string;
	ownerAgentId: string | null;
	ownerName: string;
	latestProgress: string;
	blocker: string | null;
	revision: number;
	updatedAt: number;
	createdAt: number;
	board: BoardGroup;
	boardLabel: string;
	needsUser: NeedsUser | null;
	escalation: Escalation | null;
	runState: "none" | "queued" | "running" | "submitted" | "finished" | "failed" | "cancelled" | "interrupted";
	/** 前置任务（没有就是空数组或缺省）；服务端还没有这个字段时界面不显示这一块。 */
	dependsOn?: { id: string; title: string; status: string; statusLabel: string }[];
	/** 属于方案里的哪个阶段；没有就是 null。 */
	stage?: string | null;
}
export interface WorkRun {
	id: string;
	revision: number;
	ownerAgentId: string;
	ownerName: string;
	execKind: string;
	execId: string | null;
	status: string;
	result: string | null;
	blocker: string | null;
	error: string | null;
	createdAt: number;
	startedAt: number | null;
	finishedAt: number | null;
	submittedAt: number | null;
	stale: boolean;
	/** 交接说明（做了什么、东西在哪、接手要注意什么）；没写就是 null。 */
	handoff?: string | null;
	/** 这次提交登记的成果文件；没有就是空数组。 */
	files?: { fileId: string; name: string }[];
}
export interface WorkEvent { id: string; kind: string; actorName: string; revision: number; detail: Record<string, unknown>; createdAt: number }
export interface WorkDetail {
	item: WorkSummary & { requirement: string; doneCriteria: string; verification: { verdict?: string; note?: string; byName?: string; at?: number } | null; completedAt: number | null; sourceMessageId: string | null };
	runs: WorkRun[];
	events: WorkEvent[];
}
export const RUN_LABEL: Record<string, string> = { none: "还没执行", queued: "排队中", running: "执行中", submitted: "已提交", finished: "执行结束", failed: "执行失败", cancelled: "执行已取消", interrupted: "执行中断" };
const STATUS_TONE: Record<string, "zinc" | "green" | "amber" | "red" | "accent"> = { pending: "zinc", active: "accent", blocked: "amber", review: "amber", done: "green", paused: "zinc", cancelled: "zinc" };

export function StatusPill({ s }: { s: WorkSummary }) {
	return <Badge tone={STATUS_TONE[s.status] ?? "zinc"}>{s.statusLabel}</Badge>;
}

/** 「等你决定」：管理者或系统只在需要你拍板时才问；点选项或写一句，交回管理者按你的决定继续。 */
export function DecisionBox({ item, onDone, compact }: { item: WorkSummary; onDone: () => void; compact?: boolean }) {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const nu = item.needsUser;
	if (!nu) return null;
	const answer = async (a: string) => {
		if (busy || !a.trim()) return;
		setBusy(true);
		setErr("");
		try {
			await api(`/api/work-items/${item.id}/decide`, { method: "POST", json: { answer: a } });
			setText("");
			onDone();
		} catch (e) {
			setErr(String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="pa-work-decision" data-testid="work-decision" data-work-item={item.id}>
			<p className="pa-work-decision-q"><HelpCircle className="pa-ic" />{nu.question}</p>
			{!compact && nu.reason ? <small className="text-mut2">原因：{nu.reason}</small> : null}
			<div className="pa-work-decision-opts">
				{nu.options.map((o) => <button key={o} className="pa-chip sm" disabled={busy} onClick={() => void answer(o)} data-testid="work-decision-option">{o}</button>)}
			</div>
			<div className="pa-work-decision-free">
				<input className="pa-input !h-8 text-sm" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void answer(text)} placeholder="或者写一句你的决定" aria-label="你的决定" data-testid="work-decision-text" />
				<button className="pa-btn sm primary" disabled={busy || !text.trim()} onClick={() => void answer(text)} data-testid="work-decision-send">{busy ? <Loader2 className="pa-ic animate-spin" /> : "交给管理者"}</button>
			</div>
			{err ? <p className="pa-work-error" role="alert">{err}</p> : null}
		</div>
	);
}

export function CreateWorkItem({ room, onClose, onCreated }: { room: Room; onClose: () => void; onCreated: (id: string) => void }) {
	const [title, setTitle] = useState("");
	const [requirement, setRequirement] = useState("");
	const [done, setDone] = useState("");
	const [owner, setOwner] = useState("");
	const [start, setStart] = useState(true);
	const [err, setErr] = useState("");
	const [busy, setBusy] = useState(false);
	const members = room.members.filter((m) => !m.left && !m.deleted);
	const submit = async () => {
		if (busy) return;
		setBusy(true);
		setErr("");
		try {
			const d = await api<WorkDetail>(`/api/rooms/${room.id}/work-items`, { method: "POST", json: { title, requirement, doneCriteria: done, ownerAgentId: owner || null, start } });
			onCreated(d.item.id);
		} catch (e) {
			setErr(String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Modal open onClose={onClose} title="新建任务" testId="work-create">
			<div className="space-y-3 p-4">
				<label className="pa-work-field"><span>任务名字</span><input className="pa-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：完成这周的竞品报告" autoFocus data-testid="work-create-title" /></label>
				<label className="pa-work-field"><span>要做成什么</span><textarea className="pa-input min-h-20" value={requirement} onChange={(e) => setRequirement(e.target.value)} placeholder="目标、范围、约束" data-testid="work-create-requirement" /></label>
				<label className="pa-work-field"><span>完成标准</span><textarea className="pa-input min-h-16" value={done} onChange={(e) => setDone(e.target.value)} placeholder="怎么检查算做完" data-testid="work-create-done" /></label>
				<div className="pa-work-field"><span>负责人</span>
					<Select value={owner} options={[{ value: "", label: "先不指定（待安排）", hint: "" }, ...members.map((m) => ({ value: m.agentId, label: m.name, hint: m.agentId === room.managerId ? "管理者" : "" }))]} onChange={setOwner} ariaLabel="任务负责人" testId="work-create-owner" />
				</div>
				<label className="flex items-center gap-2 text-sm text-mut"><input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} data-testid="work-create-start" />创建后马上派给负责人开始</label>
				<p className="text-xs text-mut2">只记录责任不会唤醒模型；勾选开始会在负责人自己的任务会话里执行（不占群里的发言）。执行结束也不会自动完成，要核验。</p>
				{err ? <p className="pa-work-error" role="alert" data-testid="work-create-error">{err}</p> : null}
				<div className="flex justify-end gap-2">
					<button className="pa-btn ghost" onClick={onClose}>取消</button>
					<button className="pa-btn primary" disabled={busy || !title.trim()} onClick={() => void submit()} data-testid="work-create-submit">{busy ? "保存中…" : "创建"}</button>
				</div>
			</div>
		</Modal>
	);
}

export function WorkDetailPane({ room, id, detail, error, onBack, onChanged, onSent }: { room: Room; id: string; detail: WorkDetail | null; error: string; onBack: () => void; onChanged: () => void; onSent: () => void }) {
	const [err, setErr] = useState("");
	const [note, setNote] = useState("");
	const [feedback, setFeedback] = useState("");
	const [busy, setBusy] = useState("");
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState({ title: "", requirement: "", doneCriteria: "" });
	const [owner, setOwner] = useState("");
	const members = room.members.filter((m) => !m.left && !m.deleted);
	useEffect(() => {
		if (!detail) return;
		setDraft({ title: detail.item.title, requirement: detail.item.requirement, doneCriteria: detail.item.doneCriteria });
		setOwner(detail.item.ownerAgentId ?? "");
	}, [detail?.item.id, detail?.item.revision]);
	const act = async (action: string, extra: Record<string, unknown> = {}) => {
		if (busy) return;
		setBusy(action);
		setErr("");
		try {
			await api(`/api/work-items/${id}/${action}`, { method: "POST", json: extra });
			setNote("");
			onChanged();
		} catch (e) {
			setErr(String(e));
		} finally {
			setBusy("");
		}
	};
	const patch = async (body: Record<string, unknown>) => {
		if (busy) return;
		setBusy("edit");
		setErr("");
		try {
			await api(`/api/work-items/${id}`, { method: "PATCH", json: body });
			setEditing(false);
			onChanged();
		} catch (e) {
			setErr(String(e)); // 失败保留草稿，不把用户写的内容清掉
		} finally {
			setBusy("");
		}
	};
	const sendFeedback = async () => {
		if (busy || !feedback.trim()) return;
		setBusy("feedback");
		setErr("");
		try {
			await api(`/api/work-items/${id}/feedback`, { method: "POST", json: { text: feedback } });
			setFeedback("");
			onSent();
		} catch (e) {
			setErr(String(e));
		} finally {
			setBusy("");
		}
	};
	if (!detail) {
		return <div className="p-4"><button className="pa-chip" onClick={onBack} data-testid="work-detail-back"><ArrowLeft className="pa-ic" />返回</button>{error ? <p className="pa-work-error" role="alert">{error}</p> : <p className="pa-work-empty"><Loader2 className="pa-ic animate-spin" />正在加载…</p>}</div>;
	}
	const it = detail.item;
	const canContinue = ["active", "blocked", "paused"].includes(it.status);
	return (
		<div className="pa-work-detail" data-testid="work-detail">
			<div className="pa-work-detail-head">
				<button className="pa-chip sm" onClick={onBack} data-testid="work-detail-back"><ArrowLeft className="pa-ic" />返回</button>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2"><b className="min-w-0 break-words" data-testid="work-detail-title">{it.title}</b><StatusPill s={it} /></div>
					<small>{it.ownerName || "未安排负责人"} · 第 {it.revision} 次修订 · {RUN_LABEL[it.runState]} · {fmtTime(it.updatedAt)}{it.stage ? ` · 阶段：${it.stage}` : ""}</small>
				</div>
			</div>
			{err && !editing ? <p className="pa-work-error" role="alert" data-testid="work-action-error">{err}</p> : null}
			{it.needsUser ? <section className="pa-work-block"><h4>等你决定</h4><DecisionBox item={it} onDone={onChanged} /></section> : null}
			{it.escalation && !it.needsUser ? <p className="pa-work-warn" data-testid="work-escalation"><AlertTriangle className="pa-ic" />{it.escalation.note}（{it.escalation.level === "manager" ? "已请管理者处理" : "已向你报告"}）</p> : null}
			{it.dependsOn && it.dependsOn.length > 0 ? (
				<section className="pa-work-block" data-testid="work-detail-depends">
					<h4>前置任务</h4>
					<ul className="space-y-1">
						{it.dependsOn.map((d) => (
							<li key={d.id} className="flex items-center gap-2 text-sm">
								<span className="min-w-0 flex-1 truncate">{d.title}</span>
								<Badge tone={STATUS_TONE[d.status] ?? "zinc"}>{d.statusLabel}</Badge>
							</li>
						))}
					</ul>
				</section>
			) : null}
			<section className="pa-work-block"><h4>要做成什么</h4><p>{it.requirement || "（没有写）"}</p></section>
			<section className="pa-work-block"><h4>完成标准</h4><p>{it.doneCriteria || "（没有写）"}</p></section>
			<section className="pa-work-block"><h4>最近进度</h4><p>{it.latestProgress || "暂无"}</p>{it.blocker ? <p className="pa-work-warn"><AlertTriangle className="pa-ic" />受阻：{it.blocker}</p> : null}</section>
			{it.verification && it.verification.verdict === "pass" ? <section className="pa-work-block"><h4>验收结论</h4><p>{it.verification.note}<br /><small>{it.verification.byName} · {it.verification.at ? fmtTime(it.verification.at) : ""}</small></p></section> : null}
			<section className="pa-work-actions">
				{it.status === "pending" && it.ownerAgentId ? <button className="pa-btn sm primary" disabled={!!busy} onClick={() => void act("start")} data-testid="work-action-start">开始</button> : null}
				{canContinue ? <button className="pa-btn sm" disabled={!!busy} onClick={() => void act("continue")} data-testid="work-action-continue">继续 / 安排下一次执行</button> : null}
				{!["done", "cancelled"].includes(it.status) ? <button className="pa-btn sm ghost" disabled={!!busy} onClick={() => void act("pause")} data-testid="work-action-pause">暂停</button> : null}
				{!["done", "cancelled"].includes(it.status) ? <button className="pa-btn sm ghost" disabled={!!busy} onClick={() => void act("cancel")} data-testid="work-action-cancel">取消</button> : null}
				<button className="pa-btn sm ghost" disabled={!!busy} onClick={() => setEditing(!editing)} data-testid="work-action-edit">编辑要求 / 改派</button>
			</section>
			{["done", "cancelled"].includes(it.status) ? (
				<section className="pa-work-block"><h4>这个任务已经{it.status === "done" ? "完成" : "取消"}</h4>
					<p className="text-sm text-mut">要在这个任务上继续改，请在下面「在群里说」里明确说“重开，改成……”；管理者会恢复原任务、保留原来的验收历史。随便发一条消息不会自动复活。</p>
				</section>
			) : null}
			{it.status === "review" ? (
				<section className="pa-work-block pa-work-verify"><h4>核验</h4>
					<Help>核验必须写检查结论：你实际看到了什么、为什么通过、退回还是走不通。普通文字回复不算验收；只有这里通过才完成。「这条路走不通」用在任务本身做不到（不是做得不够好），不会自动重做。</Help>
					<textarea className="pa-input min-h-20" value={note} onChange={(e) => setNote(e.target.value)} placeholder="检查结论：看到了哪个产物、哪一处符合 / 不符合完成标准" data-testid="work-verify-note" />
					<div className="flex flex-wrap gap-2">
						<button className="pa-btn sm primary" disabled={!!busy || !note.trim()} onClick={() => void act("verify", { verdict: "pass", note })} data-testid="work-verify-pass"><CheckCircle2 className="pa-ic" />通过，完成</button>
						<button className="pa-btn sm" disabled={!!busy || !note.trim()} onClick={() => void act("verify", { verdict: "return", note })} data-testid="work-verify-return">退回修改</button>
						<button className="pa-btn sm ghost" disabled={!!busy || !note.trim()} onClick={() => void act("verify", { verdict: "impossible", note })} data-testid="work-verify-impossible">这条路走不通</button>
					</div>
				</section>
			) : null}
			{editing ? (
				<section className="pa-work-block" data-testid="work-edit">
					<label className="pa-work-field"><span>任务名字</span><input className="pa-input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
					<label className="pa-work-field"><span>要做成什么</span><textarea className="pa-input min-h-20" value={draft.requirement} onChange={(e) => setDraft({ ...draft, requirement: e.target.value })} data-testid="work-edit-requirement" /></label>
					<label className="pa-work-field"><span>完成标准</span><textarea className="pa-input min-h-16" value={draft.doneCriteria} onChange={(e) => setDraft({ ...draft, doneCriteria: e.target.value })} /></label>
					<div className="pa-work-field"><span>负责人</span><Select value={owner} options={[{ value: "", label: "未安排" }, ...members.map((m) => ({ value: m.agentId, label: m.name, hint: m.agentId === room.managerId ? "管理者" : "" }))]} onChange={setOwner} ariaLabel="任务负责人" /></div>
					{err ? <p className="pa-work-error" role="alert" data-testid="work-action-error">{err}</p> : null}
					<div className="flex justify-end gap-2"><button className="pa-btn ghost sm" onClick={() => setEditing(false)}>取消</button><button className="pa-btn primary sm" disabled={!!busy} onClick={() => void patch({ ...draft, ownerAgentId: owner || null })} data-testid="work-edit-save">保存</button></div>
				</section>
			) : null}
			<section className="pa-work-block pa-work-feedback">
				<h4><MessageSquare className="pa-ic" />有问题？在群里说</h4>
				<p className="text-xs text-mut2">会自动带上这个任务；管理者据此定位同一任务、更新要求并退回重做。不用先手动改看板状态。</p>
				<textarea className="pa-input min-h-16" value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="例如：这版缺少检查点，改成每条结论都附来源" data-testid="work-feedback-text" />
				<button className="pa-btn sm primary self-end" disabled={!!busy || !feedback.trim()} onClick={() => void sendFeedback()} data-testid="work-feedback-send"><Send className="pa-ic" />在群里说</button>
			</section>
			<section className="pa-work-block">
				<h4>执行历史</h4>
				{detail.runs.length === 0 ? <p className="text-xs text-mut2">还没有执行。任务责任和单次执行是分开的。</p> : (
					<div className="pa-work-runs">
						{detail.runs.map((r) => (
							<div key={r.id} className="pa-work-run" data-testid="work-run">
								<div className="flex flex-wrap items-center gap-2"><b>第 {r.revision} 次修订</b><span className="pa-tag">{r.status}</span>{r.stale ? <span className="pa-tag warn">旧修订 · 仅历史</span> : null}<small>{r.ownerName} · {fmtTime(r.createdAt)}</small></div>
								{r.result ? <p>{r.result.slice(0, 400)}</p> : null}
								{r.blocker ? <p className="pa-work-warn">受阻：{r.blocker}</p> : null}
								{r.error ? <p className="pa-work-error">{r.error}</p> : null}
								{r.handoff ? <p className="text-xs text-mut"><b className="text-mut2">交接：</b>{r.handoff}</p> : null}
								{r.files && r.files.length > 0 ? (
									<div className="flex flex-wrap gap-1.5" data-testid="work-run-files">
										{r.files.map((f) => (
											<button key={f.fileId} type="button" className="pa-chip sm" onClick={() => void download(`/api/files/${f.fileId}`, f.name)} title={`下载 ${f.name}`} data-testid="work-run-file">
												<FileText className="pa-ic" />
												<span className="max-w-[10rem] truncate">{f.name}</span>
												<Download className="pa-ic" size={12} />
											</button>
										))}
									</div>
								) : null}
							</div>
						))}
					</div>
				)}
				{detail.events.length > 0 ? (
					<details className="pa-work-events"><summary>变更记录 {detail.events.length}</summary>
						<ul>{detail.events.slice(0, 20).map((e) => <li key={e.id}>{fmtTime(e.createdAt)} · {e.actorName} · {e.kind} · 第 {e.revision} 次修订</li>)}</ul>
					</details>
				) : null}
			</section>
		</div>
	);
}
