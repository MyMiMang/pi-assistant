/**
 * 主动性：输入框工具栏的「主动」按钮（关 / 低 / 中 / 高）、助理面板的「主动」页（节奏、免打扰、每日简报、跟进），
 * 以及侧边栏的「提醒」收件箱（所有助理主动提出的事：有用 / 忽略 / 不再提这类 / 稍后提醒）。
 */
import { Bell, BellOff, Check, ChevronDown, Clock, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { Badge, Button, cx, fmtTime, Help, Input, Modal, avatarText } from "./ui";

type Level = "off" | "low" | "normal" | "high";
export const LEVEL_LABEL: Record<Level, string> = { off: "关", low: "低", normal: "中", high: "高" };
const LEVEL_DESC: Record<Level, string> = {
	off: "不主动找你，只在你发消息时回复",
	low: "每 4 小时看一次，每天最多 2 条，只说重要的（默认）",
	normal: "每 2 小时看一次，每天最多 4 条",
	high: "每小时看一次，每天最多 8 条",
};
interface Cfg {
	cadenceMin?: number | null;
	budget?: number | null;
	quiet: { start: string; end: string } | null;
	weekdaysOnly: boolean;
	dailyBrief: string | null;
	deliver: string;
	muted: Record<string, number>;
}
interface PState {
	level: Level;
	levelSetting: Level | null;
	effectiveLevel: string;
	throttled: boolean;
	cfg: Cfg;
	cadenceMin: number;
	budget: number;
	usedToday: number;
	nextHeartbeatAt: number | null;
	lastHeartbeatAt: number | null;
	followups: { id: string; dueAt: number; note: string }[];
}
export interface Item {
	id: string;
	agentId: string;
	kind: string;
	title: string;
	body: string;
	importance: number;
	status: "new" | "held" | "delivered" | "dismissed" | "done";
	reason: string | null;
	via: string | null;
	deliveredAt: number | null;
	deliverAfter: number | null;
	createdAt: number;
}
const KIND_LABEL: Record<string, string> = { followup: "跟进", reminder: "提醒", email: "邮件", suggest_routine: "建议定时任务", suggest_skill: "建议技能", brief: "简报", other: "其它" };

function useProactive(agentId: string) {
	const v = useStore((s) => s.proactiveVersion);
	const [d, setD] = useState<PState | null>(null);
	useEffect(() => void api(`/api/agents/${agentId}/proactive`).then(setD).catch(() => {}), [agentId, v]);
	const save = async (body: { level?: Level | null; cfg?: Partial<Cfg> }) => setD(await api(`/api/agents/${agentId}/proactive`, { method: "PUT", json: body }));
	return { d, save };
}

/** 输入框工具栏：主动等级 */
export function ProactivityPicker({ agentId }: { agentId: string }) {
	const { d, save } = useProactive(agentId);
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
		document.addEventListener("mousedown", h);
		return () => document.removeEventListener("mousedown", h);
	}, [open]);
	if (!d) return null;
	return (
		<div className="relative" ref={ref}>
			<button className="pa-chip sm" onClick={() => setOpen(!open)} title="主动性：助理会不会主动来找你" data-testid="proactive-picker">
				{d.level === "off" ? <BellOff className="pa-ic" /> : <Sparkles className="pa-ic" />}
				<span>
					<span className="max-sm:hidden">主动·</span>
					{LEVEL_LABEL[d.level]}
				</span>
				<ChevronDown size={12} />
			</button>
			{open && (
				<div className="absolute bottom-full left-0 z-30 mb-2 w-72 rounded-xl border border-line bg-card p-1.5 shadow-lg max-sm:fixed max-sm:inset-x-3 max-sm:bottom-24 max-sm:w-auto" data-testid="proactive-menu">
					<div className="px-2.5 pb-1 pt-0.5 text-xs text-mut">主动性 <Help>像同事一样偶尔主动来找你（跟进没做完的事、提醒你说过的事、重要邮件）。不会替你对外发消息。</Help></div>
					{(["off", "low", "normal", "high"] as Level[]).map((l) => (
						<button key={l} className={cx("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-hover", l === d.level && "bg-hover")} onClick={() => (setOpen(false), void save({ level: l }))} data-testid={`proactive-${l}`}>
							<span className="flex-1">
								<span className="text-sm">{LEVEL_LABEL[l]}</span>
								<span className="block text-xs text-mut">{LEVEL_DESC[l]}</span>
							</span>
							{l === d.level && <Check size={14} className="text-accent" />}
						</button>
					))}
					<div className="mt-1 flex items-center gap-2 border-t border-line px-2.5 pt-1.5 text-xs text-mut">
						<span className="flex-1">
							今天 {d.usedToday}/{d.budget} 条{d.nextHeartbeatAt ? ` · 下次 ${fmtTime(d.nextHeartbeatAt)}` : ""}
						</span>
						<button className="text-accent" onClick={() => (setOpen(false), useStore.getState().set({ info: true, infoTab: "proactive" }))}>
							更多设置
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

/** 助理面板 › 主动 */
export function ProactiveTab({ agentId }: { agentId: string }) {
	const { d, save } = useProactive(agentId);
	const v = useStore((s) => s.proactiveVersion);
	const [items, setItems] = useState<Item[]>([]);
	const [msg, setMsg] = useState("");
	useEffect(() => void api(`/api/proactive/inbox?agentId=${agentId}`).then((r) => setItems(r.items)), [agentId, v]);
	if (!d) return null;
	const c = d.cfg;
	return (
		<div className="space-y-5 text-sm" data-testid="proactive-tab">
			<div className="space-y-2">
				<div className="font-medium">主动等级</div>
				<div className="flex flex-wrap gap-1.5">
					{(["off", "low", "normal", "high"] as Level[]).map((l) => (
						<button key={l} className={cx("pa-chip sm", d.level === l && "!border-accent !text-accent")} onClick={() => void save({ level: l })}>
							{LEVEL_LABEL[l]}
						</button>
					))}
				</div>
				<p className="text-xs text-mut">{LEVEL_DESC[d.level]}</p>
				{d.throttled && <p className="text-xs text-amber-600">你最近经常忽略它的提醒，已自动调低一级（标记几次“有用”就会恢复）。</p>}
				{d.level !== "off" && (
					<div className="flex flex-wrap items-center gap-2 text-xs text-mut">
						<span>今天已提醒 {d.usedToday}/{d.budget} 条</span>
						{d.nextHeartbeatAt && <span>· 下次巡检 {fmtTime(d.nextHeartbeatAt)}</span>}
						{d.lastHeartbeatAt && <span>· 上次 {fmtTime(d.lastHeartbeatAt)}</span>}
						<button className="text-accent" onClick={() => api(`/api/agents/${agentId}/proactive/run`, { method: "POST" }).then((r) => setMsg(r.runId ? "正在后台看看…" : "已经在看了"))} data-testid="proactive-run">
							现在看看
						</button>
						{msg && <span>{msg}</span>}
					</div>
				)}
			</div>
			{d.level !== "off" && (
				<div className="space-y-3 rounded-xl border border-line p-3">
					<label className="flex items-center gap-2">
						<span className="w-24 shrink-0 text-mut">免打扰</span>
						<input type="checkbox" checked={!!c.quiet} onChange={(e) => void save({ cfg: { quiet: e.target.checked ? { start: "22:00", end: "08:00" } : null } })} />
						{c.quiet && (
							<>
								<Input className="!w-20" type="time" value={c.quiet.start} onChange={(e) => void save({ cfg: { quiet: { ...c.quiet!, start: e.target.value } } })} />
								<span>到</span>
								<Input className="!w-20" type="time" value={c.quiet.end} onChange={(e) => void save({ cfg: { quiet: { ...c.quiet!, end: e.target.value } } })} />
							</>
						)}
					</label>
					<label className="flex items-center gap-2">
						<span className="w-24 shrink-0 text-mut">只在工作日</span>
						<input type="checkbox" checked={c.weekdaysOnly} onChange={(e) => void save({ cfg: { weekdaysOnly: e.target.checked } })} />
						<span className="text-xs text-mut">周末不巡检（约好的跟进照常）</span>
					</label>
					<label className="flex items-center gap-2">
						<span className="w-24 shrink-0 text-mut">每日简报</span>
						<input type="checkbox" checked={!!c.dailyBrief} onChange={(e) => void save({ cfg: { dailyBrief: e.target.checked ? "08:30" : null } })} data-testid="proactive-brief" />
						{c.dailyBrief && <Input className="!w-24" type="time" value={c.dailyBrief} onChange={(e) => void save({ cfg: { dailyBrief: e.target.value } })} />}
					</label>
					<label className="flex items-center gap-2">
						<span className="w-24 shrink-0 text-mut">巡检间隔</span>
						<select className="pa-input !w-auto" value={c.cadenceMin ?? ""} onChange={(e) => void save({ cfg: { cadenceMin: e.target.value ? Number(e.target.value) : null } })}>
							<option value="">按等级（{d.cadenceMin} 分钟）</option>
							{[30, 60, 120, 240, 480].map((m) => (
								<option key={m} value={m}>
									{m < 60 ? `${m} 分钟` : `${m / 60} 小时`}
								</option>
							))}
						</select>
					</label>
					<label className="flex items-center gap-2">
						<span className="w-24 shrink-0 text-mut">每天最多</span>
						<select className="pa-input !w-auto" value={c.budget ?? ""} onChange={(e) => void save({ cfg: { budget: e.target.value === "" ? null : Number(e.target.value) } })}>
							<option value="">按等级（{d.budget} 条）</option>
							{[0, 1, 2, 3, 5, 8, 12].map((n) => (
								<option key={n} value={n}>
									{n} 条{n === 0 ? "（只进收件箱）" : ""}
								</option>
							))}
						</select>
					</label>
					<label className="flex items-center gap-2">
						<span className="w-24 shrink-0 text-mut">同步到渠道</span>
						<select className="pa-input !w-auto max-w-full" title="消息总是先进 Pi Assistant（App 里的对话 + 推送）；选“同步到渠道”会再把副本发到已连接的微信 / 飞书 / 钉钉 / 企业微信单聊，定时任务结果也一样" value={c.deliver === "app" ? "app" : "auto"} onChange={(e) => void save({ cfg: { deliver: e.target.value } })}>
							<option value="auto">App + 同步到渠道</option>
							<option value="app">只在 App</option>
						</select>
					</label>
					{Object.entries(c.muted).filter(([, u]) => u > Date.now()).length > 0 && (
						<div className="flex flex-wrap items-center gap-1.5 text-xs text-mut">
							暂不提醒：
							{Object.entries(c.muted)
								.filter(([, u]) => u > Date.now())
								.map(([k]) => (
									<button key={k} className="pa-chip sm" onClick={() => void save({ cfg: { muted: Object.fromEntries(Object.entries(c.muted).filter(([x]) => x !== k)) } })} title="恢复">
										{KIND_LABEL[k] ?? k} <X size={11} />
									</button>
								))}
						</div>
					)}
				</div>
			)}
			<div className="space-y-1.5">
				<div className="font-medium">约好的跟进</div>
				{!d.followups.length && <p className="text-xs text-mut">还没有约好的跟进。 <Help>助理在聊天里说“我晚点再看看”时会约在这里，到点自动回来跟进。</Help></p>}
				{d.followups.map((f) => (
					<div key={f.id} className="flex items-center gap-2 rounded-lg bg-hover/60 px-2.5 py-1.5" data-testid="followup">
						<Clock size={13} className="shrink-0 text-mut" />
						<span className="shrink-0 text-xs text-mut">{fmtTime(f.dueAt)}</span>
						<span className="min-w-0 flex-1 truncate" title={f.note}>
							{f.note}
						</span>
						<button className="pa-icon-btn ghost" aria-label="取消" onClick={() => api(`/api/agents/${agentId}/proactive/followups/${f.id}`, { method: "DELETE" })}>
							<X size={13} />
						</button>
					</div>
				))}
			</div>
			<div className="space-y-1.5">
				<div className="font-medium">最近的提醒</div>
				{!items.length && <p className="text-xs text-mut">还没有。</p>}
				{items.map((i) => (
					<ItemCard key={i.id} i={i} compact />
				))}
			</div>
		</div>
	);
}

function ItemCard({ i, compact }: { i: Item; compact?: boolean }) {
	const agent = useStore((s) => s.agents.find((a) => a.id === i.agentId));
	const act = (action: "dismiss" | "done" | "snooze", extra: Record<string, unknown> = {}) => api(`/api/proactive/items/${i.id}`, { method: "POST", json: { action, ...extra } });
	const st = i.status === "delivered" ? `已推送${i.via?.includes("channel:") ? "，并同步到聊天渠道" : ""}` : i.status === "held" ? (i.reason ?? "等待推送") : (i.reason ?? "在收件箱");
	return (
		<div className="space-y-1.5 rounded-xl border border-line p-3" data-testid="inbox-item">
			<div className="flex items-center gap-2">
				{!compact && agent && <span className="shrink-0">{avatarText(agent.avatar)}</span>}
				<b className="min-w-0 flex-1 truncate">{i.title}</b>
				<Badge tone={i.importance >= 3 ? "amber" : "zinc"}>{KIND_LABEL[i.kind] ?? i.kind}</Badge>
			</div>
			<p className="whitespace-pre-wrap text-sm text-fg/90">{i.body}</p>
			<div className="flex flex-wrap items-center gap-1.5 text-xs text-mut">
				<span className="mr-auto">
					{!compact && agent ? `${agent.name} · ` : ""}
					{fmtTime(i.createdAt)} · {st}
				</span>
				<Button size="sm" variant="ghost" onClick={() => act("done")} data-testid="inbox-done">
					有用
				</Button>
				<Button size="sm" variant="ghost" onClick={() => act("snooze", { until: Date.now() + 3 * 3600_000 })}>
					3 小时后
				</Button>
				<Button size="sm" variant="ghost" onClick={() => act("dismiss")} data-testid="inbox-dismiss">
					忽略
				</Button>
				<Button size="sm" variant="ghost" onClick={() => act("dismiss", { mute: true })} title="14 天内不再提这一类">
					不再提这类
				</Button>
				{!compact && (
					<Button size="sm" variant="ghost" onClick={() => (useStore.getState().set({ inbox: false }), void useStore.getState().selectAgent(i.agentId))}>
						去聊聊
					</Button>
				)}
			</div>
		</div>
	);
}

/** 侧边栏的提醒按钮 + 收件箱 */
export function InboxButton() {
	const v = useStore((s) => s.proactiveVersion);
	const open = useStore((s) => s.inbox);
	const [d, setD] = useState<{ items: Item[]; count: number; defaultLevel: Level } | null>(null);
	useEffect(() => void api("/api/proactive/inbox").then(setD).catch(() => {}), [v, open]);
	const close = () => useStore.getState().set({ inbox: false });
	return (
		<>
			<button className="pa-icon-btn ghost relative" title="提醒" aria-label="提醒" onClick={() => useStore.getState().set({ inbox: true })} data-testid="inbox-button">
				<Bell className="pa-ic" />
				{!!d?.count && <span className="absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full bg-accent px-1 text-center text-[10px] leading-4 text-white">{d.count > 99 ? "99+" : d.count}</span>}
			</button>
			<Modal open={open} onClose={close} title="提醒" wide>
				<div className="space-y-3 p-5" data-testid="inbox">
					<p className="text-sm text-mut">助理们最近 7 天主动提出的事。 <Help>“忽略”的事不会再提；经常被忽略的助理会自动变得更克制。</Help></p>
					{d && !d.items.length && <div className="py-8 text-center text-sm text-mut">暂时没有提醒 🌿</div>}
					{d?.items.map((i) => <ItemCard key={i.id} i={i} />)}
					{d && (
						<label className="flex items-center gap-2 border-t border-line pt-3 text-sm">
							<span className="text-mut">新助理默认主动等级</span>
							<select className="pa-input !w-auto" value={d.defaultLevel} onChange={(e) => api("/api/proactive/defaults", { method: "PUT", json: { level: e.target.value } }).then(() => api("/api/proactive/inbox").then(setD))}>
								{(["off", "low", "normal", "high"] as Level[]).map((l) => (
									<option key={l} value={l}>
										{LEVEL_LABEL[l]}
									</option>
								))}
							</select>
						</label>
					)}
				</div>
			</Modal>
		</>
	);
}
