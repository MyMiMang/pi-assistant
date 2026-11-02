/**
 * 主动做事（决策 0025）：助理面板 › 主动 里的「主动做事」模式、「可以放心做的事」规则清单、判断记录。
 * 模式用 <Select>，规则清单和判断记录用 <Fold>（默认折叠、显示条数、限高滚动）。
 */
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Button, Fold, Help, Input, Select, fmtTime } from "./ui";

export type Mode = "auto" | "trial" | "off";
export interface Rule {
	id: string;
	text: string;
	enabled: boolean;
}
export interface Judgment {
	id: string;
	title: string;
	basis: string;
	mode: string;
	outcome: string;
	reason: string | null;
	roomId: string | null;
	at: number;
}
const MODE_OPTIONS = [
	{ value: "auto", label: "自动（默认）", desc: "你交代过的、在授权内的事直接做完再告诉你；对上下面规则的事也直接做" },
	{ value: "trial", label: "试运行", desc: "只记成「本来会做」的卡片放进提醒，你点「就这么做」才真做" },
	{ value: "off", label: "关", desc: "不主动做事，只在需要时提醒你" },
];
const OUTCOME: Record<string, string> = {
	started: "已开始做", steered: "已并入进行中的事", queued: "排队等做", inbox: "没做成，留在提醒里", held: "稍后提醒", rejected: "被拦下",
	trial: "试运行：没真做", confirmed: "试运行后你点了「就这么做」", vetoed: "你点了「这类以后别做」", to_reminder: "没有依据，转成了提醒", cancelled: "已取消",
};

export function AutonomySection({ mode, rules, judgments, onSave }: { mode: Mode; rules: Rule[]; judgments: Judgment[]; onSave: (cfg: { autonomy?: Mode; rules?: Rule[] }) => Promise<unknown> }) {
	const [openRules, setOpenRules] = useState(false);
	const [openLog, setOpenLog] = useState(false);
	const [draft, setDraft] = useState("");
	const [err, setErr] = useState("");
	const save = (cfg: { autonomy?: Mode; rules?: Rule[] }) => onSave(cfg).then(() => setErr(""), (e) => setErr(e instanceof Error ? e.message : String(e)));
	const setRule = (id: string, patch: Partial<Rule>) => void save({ rules: rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
	return (
		<div className="space-y-3" data-testid="proactive-autonomy">
			<div className="space-y-1.5">
				<div className="font-medium">
					主动做事 <Help>助理巡检时发现你交代过的事、或对上「可以放心做的事」的事，会直接去做（单聊里或群里），再简短告诉你结果。对外承诺、花钱、破坏性改动、权限变更仍会先问你。试运行：先看它「本来会做什么」，不真做。</Help>
				</div>
				<p className="text-xs text-mut">让助理自己把事做完，而不是只提醒你；主动等级为「关」时不会巡检。</p>
				<Select className="max-w-full" value={mode} options={MODE_OPTIONS} ariaLabel="主动做事模式" testId="proactive-autonomy-mode" menuMinWidth={320} onChange={(v) => void save({ autonomy: v as Mode })} />
			</div>
			<Fold title="可以放心做的事" count={rules.length} hint="对上的事助理可以直接做" desc="每条写一句大白话，例如「报告类任务卡住超过半天，可以直接重跑一次」。你已经开始的事里看得出能帮上的一步（卡住的任务、明显的下一步），助理会直接做；你没提过的全新的事，要对上这里的某条规则才直接做（助理要对每条规则写明对上没有、依据是什么），对不上只会提醒你。" open={openRules} onToggle={() => setOpenRules(!openRules)} testId="proactive-rules">
				<div className="space-y-2">
					{!rules.length && <p className="text-xs text-mut">还没有规则：不是你当面交代的事，助理只会提醒你。</p>}
					<div className="max-h-64 space-y-1.5 overflow-y-auto">
						{rules.map((r) => (
							<div key={r.id} className="flex items-center gap-2" data-testid="proactive-rule">
								<input type="checkbox" className="pa-switch" role="switch" aria-label="启用这条规则" checked={r.enabled} onChange={(e) => setRule(r.id, { enabled: e.target.checked })} />
								<Input defaultValue={r.text} maxLength={120} aria-label="规则内容" onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== r.text && setRule(r.id, { text: e.target.value.trim() })} />
								<button className="pa-icon-btn ghost" aria-label="删除规则" onClick={() => void save({ rules: rules.filter((x) => x.id !== r.id) })}>
									<X size={13} />
								</button>
							</div>
						))}
					</div>
					<div className="flex items-center gap-2">
						<Input value={draft} maxLength={120} placeholder="新增一条，例如：整理下载目录里超过 30 天的安装包" aria-label="新规则" onChange={(e) => setDraft(e.target.value)} data-testid="proactive-rule-new" />
						<Button size="sm" disabled={!draft.trim() || rules.length >= 20} onClick={() => void save({ rules: [...rules, { id: "", text: draft.trim(), enabled: true }] }).then(() => setDraft(""))} data-testid="proactive-rule-add">
							<Plus size={13} /> 添加
						</Button>
					</div>
					{err && <p className="text-xs text-red-600">{err}</p>}
				</div>
			</Fold>
			<Fold title="判断记录" count={judgments.length} hint="助理每次主动做事的依据和结果" desc="每次主动推进记一行：做了什么、依据（你的原话或对上的规则）、结果。" open={openLog} onToggle={() => setOpenLog(!openLog)} testId="proactive-judgments">
				{!judgments.length ? (
					<p className="text-xs text-mut">还没有记录。</p>
				) : (
					<div className="max-h-72 space-y-1.5 overflow-y-auto">
						{judgments.map((j) => (
							<div key={j.id} className="rounded-lg bg-hover/60 px-2.5 py-1.5 text-xs" data-testid="proactive-judgment">
								<div className="flex items-center gap-2">
									<b className="min-w-0 flex-1 truncate text-sm">{j.title}</b>
									<span className="shrink-0 text-mut">{fmtTime(j.at)}</span>
								</div>
								<div className="text-mut">
									{OUTCOME[j.outcome] ?? j.outcome}
									{j.roomId ? " · 在群里" : ""}
									{j.reason ? ` · ${j.reason}` : ""}
								</div>
								{j.basis && <div className="text-mut">依据：{j.basis}</div>}
							</div>
						))}
					</div>
				)}
			</Fold>
		</div>
	);
}
