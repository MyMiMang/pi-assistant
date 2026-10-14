/**
 * 模型选择（单聊输入栏 / 群聊成员 / 子代理共用同一套菜单）：
 * 一个按钮打开菜单，菜单里既能换模型，也能设思考强度。
 * 菜单结构：搜索 →（模型支持推理时）思考强度 → 常用（按用户选择频次，最多 5 个）→ 其余按模型服务（provider）分组折叠。
 * 服务名一律用 provider 目录 / 用户给自定义服务起的名字，绝不按模型 id 猜。
 */
import { Brain, Check, ChevronDown, Cpu, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { COMPOSER_LABEL } from "../composer";
import { useStore } from "../store";
import type { Provider } from "../types";
import { cx } from "./ui";

export interface ModelEntry {
	provider: string;
	id: string;
	name: string;
	reasoning?: boolean;
	thinking?: string[];
	providerName?: string;
	/** 菜单里模型名下面的一行说明（组队选模型的理由等） */
	note?: string;
	/** 模型名右侧的小标签（价格档等） */
	badge?: string;
	/** 推荐（组队排序里的 ★） */
	star?: boolean;
}
export const THINKING_LABEL: Record<string, string> = { off: "关闭", minimal: "极简", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大" };
export const THINKING_DESC: Record<string, string> = { off: "不思考，回答最快", minimal: "几乎不思考", low: "简单推理", medium: "平衡（默认）", high: "深入推理，更慢更贵", xhigh: "非常深入", max: "最大推理预算" };

export const pickKey = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;
export interface ModelPick {
	count: number;
	at: number;
}
export type ModelPicks = Record<string, ModelPick>;

/** 已配置的服务的全部模型（含自定义）；每次打开菜单都会重新拉一次，新增渠道后不用刷新页面 */
export function useConfiguredModels() {
	const v = useStore((s) => s.system);
	const [d, setD] = useState<{ providers: Provider[]; models: ModelEntry[] }>({ providers: [], models: [] });
	const reload = useCallback(() => {
		void Promise.all([api("/api/models/providers"), api("/api/models")]).then(([p, m]) => {
			const providers = (p.providers ?? p) as Provider[];
			const ok = new Set(providers.filter((x) => x.configured).map((x) => x.id));
			setD({ providers, models: (m as ModelEntry[]).filter((x) => ok.has(x.provider)) });
		});
	}, []);
	useEffect(reload, [reload, v]);
	return { ...d, reload };
}

/** 常用排序：选择次数多的在前，次数相同看最近一次选择（服务端记录，见 server/src/model-picks.ts） */
export function rankPicks(picks: ModelPicks, limit = 5): string[] {
	return Object.entries(picks)
		.sort((a, b) => b[1].count - a[1].count || b[1].at - a[1].at)
		.slice(0, limit)
		.map(([k]) => k);
}

/** 用户选过哪些模型：服务端持久化（电脑和手机共用），本地乐观更新让「常用」立刻变 */
export function useModelPicks() {
	const [picks, setPicks] = useState<ModelPicks>({});
	useEffect(() => {
		void api<{ picks: ModelPicks }>("/api/models/picks")
			.then((d) => setPicks(d.picks ?? {}))
			.catch(() => {});
	}, []);
	const record = (m: { provider: string; id: string }) => {
		setPicks((p) => ({ ...p, [pickKey(m)]: { count: (p[pickKey(m)]?.count ?? 0) + 1, at: Date.now() } }));
		void api("/api/models/picks", { method: "POST", json: { provider: m.provider, id: m.id } }).catch(() => {});
	};
	return { picks, record };
}

export function usePopover() {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
		// 捕获阶段吃掉 Escape：菜单开着时按 Esc 只关菜单，不把底下的设置弹窗一起关掉
		const k = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.stopPropagation();
			setOpen(false);
		};
		document.addEventListener("mousedown", h);
		document.addEventListener("keydown", k, true);
		return () => (document.removeEventListener("mousedown", h), document.removeEventListener("keydown", k, true));
	}, [open]);
	return { open, setOpen, ref };
}

async function patchAgent(agentId: string, body: Record<string, unknown>) {
	const a = await api(`/api/agents/${agentId}`, { method: "PATCH", json: body });
	useStore.setState((s) => ({ agents: s.agents.map((x) => (x.id === agentId ? { ...x, ...a } : x)) }));
}

// ------------------------------------------------------------------ 共用的下拉菜单
export interface ThinkingChoice {
	levels: string[];
	current: string;
	onPick: (level: string) => void;
}

function Option({ m, sel, id, onPick }: { m: ModelEntry; sel: boolean; id: string; onPick: (m: ModelEntry) => void }) {
	return (
		<button className={cx("flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover", sel && "bg-hover")} onClick={() => onPick(m)} data-testid={`${id}-option`} data-model={pickKey(m)}>
			<span className="min-w-0 flex-1">
				<span className="block truncate">
					{m.star ? "★ " : ""}
					{m.name}
				</span>
				{(m.badge || m.note) && (
					<span className="block truncate text-[11px] text-mut">
						{m.badge ? `${m.badge} · ` : ""}
						{m.note ?? ""}
					</span>
				)}
			</span>
			{m.reasoning && <Brain size={12} className="mt-1 shrink-0 text-mut" aria-label="支持推理" />}
			{sel && <Check size={14} className="mt-0.5 shrink-0 text-accent" />}
		</button>
	);
}

export interface ModelMenuProps {
	/** 菜单 / 搜索 / 选项的 testid 前缀（聊天用 model，群聊成员用 pm-model，子代理用 subagent-model） */
	id: string;
	models: ModelEntry[];
	providers: Provider[];
	value?: { provider: string; id: string } | null;
	thinking?: ThinkingChoice | null;
	picks?: ModelPicks;
	onPick: (m: ModelEntry) => void;
	/** false 时按传入顺序平铺（组队排序用），不按服务分组 */
	groupByProvider?: boolean;
	placement?: "up" | "down";
	/** 菜单顶部固定内容（子代理的「跟随 / 自动挑」等） */
	header?: ReactNode;
}

export function ModelMenu({ id, models, providers, value, thinking, picks, onPick, groupByProvider = true, placement = "up", header }: ModelMenuProps) {
	const [q, setQ] = useState("");
	const [openGroups, setOpenGroups] = useState<string[]>(() => (value?.provider ? [value.provider] : models[0] ? [models[0].provider] : []));
	const nameOf = (p: string) => providers.find((x) => x.id === p)?.name ?? models.find((m) => m.provider === p)?.providerName ?? p;
	const k = q.trim().toLowerCase();
	const shown = models.filter((m) => !k || `${m.name} ${m.id} ${m.provider} ${nameOf(m.provider)}`.toLowerCase().includes(k));
	// 搜索时不显示「常用」；不搜索时常用最多 5 个，且从下面的分组里去掉，避免同一个模型出现两次
	const frequent = k ? [] : rankPicks(picks ?? {}, 5).map((key) => models.find((m) => pickKey(m) === key)).filter((m): m is ModelEntry => !!m);
	const freqKeys = new Set(frequent.map(pickKey));
	const rest = shown.filter((m) => !freqKeys.has(pickKey(m)));
	const groups: { provider: string; name: string; models: ModelEntry[] }[] = [];
	if (groupByProvider) {
		const by = new Map<string, ModelEntry[]>();
		for (const m of rest) by.set(m.provider, [...(by.get(m.provider) ?? []), m]);
		const entries = [...by.entries()].sort((a, b) => Number(b[0] === value?.provider) - Number(a[0] === value?.provider) || nameOf(a[0]).localeCompare(nameOf(b[0]), "zh"));
		for (const [provider, ms] of entries) groups.push({ provider, name: nameOf(provider), models: ms });
	} else if (rest.length) groups.push({ provider: "", name: "", models: rest });
	const isOpen = (p: string) => !groupByProvider || !!k || openGroups.includes(p);
	return (
		<div className={cx("pa-pop absolute right-0 z-30 flex max-h-[60vh] w-80 flex-col rounded-xl border border-line bg-card p-1.5 shadow-lg", placement === "up" ? "bottom-full mb-2" : "top-full mt-2")} data-testid={`${id}-menu`}>
			<label className="mb-1 flex items-center gap-2 rounded-lg bg-hover px-2.5 py-1.5">
				<Search size={14} className="text-mut" />
				<input autoFocus className="min-w-0 flex-1 bg-transparent text-sm outline-none" placeholder="搜索模型或服务…" value={q} onChange={(e) => setQ(e.target.value)} data-testid={`${id}-search`} />
			</label>
			{header}
			{thinking && thinking.levels.length > 1 && (
				<div className="mb-1 rounded-lg border border-line px-2.5 py-1.5" data-testid={`${id}-thinking`}>
					<div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-mut uppercase">
						<Brain size={12} /> 思考强度
					</div>
					<div className="flex flex-wrap gap-1">
						{thinking.levels.map((l) => (
							<button key={l} title={THINKING_DESC[l] ?? ""} onClick={() => thinking.onPick(l)} className={cx("rounded-full border px-2 py-0.5 text-[11px]", l === thinking.current ? "border-accent bg-accent-soft text-accent" : "border-line text-mut hover:text-fg")} data-testid={`thinking-${l}`}>
								{THINKING_LABEL[l] ?? l}
							</button>
						))}
					</div>
				</div>
			)}
			<div className="min-h-0 flex-1 overflow-y-auto">
				{!models.length && <div className="p-3 text-sm text-mut">还没有配置模型服务：在 设置 › 模型 里添加</div>}
				{!!models.length && !shown.length && <div className="p-3 text-sm text-mut">没有匹配的模型</div>}
				{frequent.length > 0 && (
					<div className="py-1" data-testid={`${id}-frequent`}>
						<div className="px-2.5 pb-0.5 text-[11px] font-semibold tracking-wide text-mut uppercase">常用</div>
						{frequent.map((m) => (
							<Option key={pickKey(m)} m={m} sel={pickKey(m) === (value ? pickKey(value) : "")} id={id} onPick={onPick} />
						))}
					</div>
				)}
				{groups.map((g) => (
					<div key={g.provider || "flat"} className="py-1">
						{groupByProvider ? (
							<button className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1 text-left" onClick={() => setOpenGroups((l) => (l.includes(g.provider) ? l.filter((x) => x !== g.provider) : [...l, g.provider]))} aria-expanded={isOpen(g.provider)} data-testid={`${id}-group-${g.provider}`}>
								<ChevronDown size={12} className={cx("shrink-0 text-mut transition-transform", !isOpen(g.provider) && "-rotate-90")} />
								<span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wide text-mut uppercase">{g.name}</span>
								<span className="shrink-0 text-[11px] text-mut2">{g.models.length}</span>
							</button>
						) : null}
						{isOpen(g.provider) &&
							g.models.map((m) => <Option key={pickKey(m)} m={m} sel={pickKey(m) === (value ? pickKey(value) : "")} id={id} onPick={onPick} />)}
					</div>
				))}
			</div>
		</div>
	);
}

export interface ModelPickerButtonProps {
	/** 按钮的 testid */
	testid: string;
	/** 菜单 / 搜索 / 选项的 testid 前缀；不传就用按钮 testid */
	id?: string;
	models: ModelEntry[];
	providers: Provider[];
	value?: { provider: string; id: string } | null;
	thinking?: ThinkingChoice | null;
	picks?: ModelPicks;
	onPick: (m: ModelEntry) => void;
	/** 按钮上的文字（一般是「模型名 · 思考档位」）；不传就只显示图标 */
	text?: string;
	icon?: ReactNode;
	title?: string;
	ariaLabel?: string;
	buttonClass?: string;
	/** true：聊天输入栏那种窄容器里只留图标 */
	hideTextInNarrow?: boolean;
	groupByProvider?: boolean;
	placement?: "up" | "down";
	/** 菜单顶部固定内容（子代理的「跟随 / 自动挑」、群聊的「默认模型」）；回调里可 close() 关掉菜单 */
	header?: (close: () => void) => ReactNode;
	disabled?: boolean;
	/** 打开菜单时调用（用于重新拉一次模型列表） */
	onOpen?: () => void;
}

/** 共用的「模型按钮 + 菜单」；聊天 / 群聊成员 / 子代理都用它，避免各写一套 */
export function ModelPickerButton({ testid, id = testid, models, providers, value, thinking, picks, onPick, text, icon, title, ariaLabel, buttonClass, hideTextInNarrow, groupByProvider, placement, header, disabled, onOpen }: ModelPickerButtonProps) {
	const { open, setOpen, ref } = usePopover();
	return (
		<div className="relative min-w-0" ref={ref}>
			<button
				className={cx("pa-chip sm !shrink min-w-0", buttonClass)}
				disabled={disabled}
				onClick={() => {
					if (!open) onOpen?.();
					setOpen(!open);
				}}
				title={title}
				aria-label={ariaLabel}
				data-testid={testid}
			>
				{icon ?? <Cpu className="pa-ic" />}
				{text ? <span className={cx("truncate", hideTextInNarrow && COMPOSER_LABEL)}>{text}</span> : null}
				<ChevronDown size={12} />
			</button>
			{open && (
				<ModelMenu
					id={id}
					models={models}
					providers={providers}
					value={value}
					thinking={thinking ? { ...thinking, onPick: (l) => (setOpen(false), thinking.onPick(l)) } : null}
					picks={picks}
					groupByProvider={groupByProvider}
					placement={placement}
					header={header?.(() => setOpen(false))}
					onPick={(m) => (setOpen(false), onPick(m))}
				/>
			)}
		</div>
	);
}

// ------------------------------------------------------------------ 单聊输入栏：一个按钮同时管模型和思考强度
export function ModelPicker({ agentId }: { agentId: string }) {
	const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
	const d = useConfiguredModels();
	const { picks, record } = useModelPicks();
	if (!agent) return null;
	const cur = agent.model;
	const entry = d?.models.find((m) => m.provider === cur?.provider && m.id === cur?.id);
	const levels = entry?.thinking ?? [];
	const curThinking = agent.thinking && levels.includes(agent.thinking) ? agent.thinking : levels[0];
	const reasoning = levels.length > 1;
	const text = `${entry?.name ?? cur?.id ?? "选择模型"}${reasoning ? ` · ${THINKING_LABEL[curThinking] ?? curThinking}` : ""}`;
	return (
		<ModelPickerButton
			testid="model-picker"
			id="model"
			models={d?.models ?? []}
			providers={d?.providers ?? []}
			value={cur ?? null}
			thinking={reasoning ? { levels, current: curThinking, onPick: (l) => void patchAgent(agentId, { thinking: l }) } : null}
			picks={picks}
			onPick={(m) => {
				record(m);
				void patchAgent(agentId, { model: { provider: m.provider, id: m.id } });
			}}
			text={text}
			hideTextInNarrow
			onOpen={d.reload}
			buttonClass="max-w-[220px] max-sm:max-w-[120px]"
			title="选择这个助理用的模型和思考强度"
			ariaLabel={`模型：${entry?.name ?? cur?.id ?? "未选择"}${reasoning ? `，思考强度 ${THINKING_LABEL[curThinking] ?? curThinking}` : ""}`}
		/>
	);
}
