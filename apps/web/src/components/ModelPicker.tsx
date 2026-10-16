/**
 * 模型选择（单聊输入栏 / 群聊成员 / 子代理共用同一套菜单）：
 * 一个按钮打开菜单，菜单里既能换模型，也能设思考强度。
 * 菜单结构：搜索 →（模型支持推理时）思考强度 → 常用（按用户选择频次，最多 5 个的快捷入口）→ 其余按模型服务（provider）分组折叠。
 * 「常用」只是快捷入口：它**不会**把条目从原服务分组里移走（同一模型在常用与原渠道各 1 行；分组内按 provider/id 去重，跨分组不合并）。
 * 服务名一律用 provider 目录 / 用户给自定义服务起的名字，绝不按模型 id 猜。
 */
import { Brain, Check, ChevronDown, Cpu, Search } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { COMPOSER_LABEL } from "../composer";
import { dedupeGroup, frequentModels, groupModelsByProvider, pickKey, rankPicks, searchModels, type MenuPick, type MenuPicks } from "../modelMenu";
import { useStore } from "../store";
import type { Provider } from "../types";
import { cx } from "./ui";

export { pickKey, rankPicks };
/** 兼容旧名字：菜单选项的频次记录（定义在 ../modelMenu 的纯模块里） */
export type ModelPick = MenuPick;
export type ModelPicks = MenuPicks;

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

// 弹层定位：菜单用 createPortal 挂到 body、position: fixed 锚定触发器。
// 不能直接用 absolute right-0：在设置弹窗这种块级容器里，按钮 wrapper 会被拉成整行宽，
// 菜单就相对整行右对齐、跑到触发器老远；而 fixed 在 .pa-modal（glass 皮肤的 backdrop-filter、
// 入场动画的 transform 等会创建 containing block 的祖先）里坐标又是相对该祖先的，
// 只有挂到 body 才是真正相对视口。
const POP_GAP = 8;
const POP_MARGIN = 8;

/** 按触发器位置算弹层坐标：默认放在 placement 一侧，放不下且另一侧更宽裕就翻转；水平/垂直都收在视口内。 */
function popoverStyle(anchor: HTMLElement, panel: HTMLElement, placement: "up" | "down", naturalHeight: number): CSSProperties {
	const r = anchor.getBoundingClientRect();
	const vw = document.documentElement.clientWidth;
	const vh = document.documentElement.clientHeight;
	const w = panel.offsetWidth || panel.getBoundingClientRect().width || 320;
	const h = naturalHeight || panel.offsetHeight;
	const roomBelow = vh - POP_MARGIN - (r.bottom + POP_GAP);
	const roomAbove = r.top - POP_GAP - POP_MARGIN;
	let below = placement !== "up";
	if (placement === "up" ? h > roomAbove && roomBelow > roomAbove : h > roomBelow && roomAbove > roomBelow) below = !below;
	const top = Math.max(POP_MARGIN, below ? r.bottom + POP_GAP : r.top - POP_GAP - h);
	const left = Math.max(POP_MARGIN, Math.min(r.left, vw - POP_MARGIN - w));
	// 窄屏：.pa-pop 的媒体查询会把菜单固定成底部弹窗（left/right 8px、bottom 6rem），
	// 这时 top/left 会被 !important 覆盖，只需给个高度上限。
	if (vw <= 640) return { position: "fixed", top, left, zIndex: 70, visibility: "visible", maxHeight: Math.round(vh * 0.6) };
	// 宽屏：限高，超出视口的部分交给菜单内部滚动，弹层本身不被裁、也不出屏
	return { position: "fixed", top, left, zIndex: 70, visibility: "visible", maxHeight: Math.max(120, vh - POP_MARGIN - top) };
}

/** 按钮 + 弹层的通用状态：open、触发器 ref、弹层 ref、弹层内联定位 style。 */
export function usePopover(placement: "up" | "down" = "down") {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const natural = useRef(0);
	const [style, setStyle] = useState<CSSProperties>({ position: "fixed", top: 0, left: 0, zIndex: 70, visibility: "hidden" });
	useEffect(() => {
		if (!open) return;
		// 菜单 portal 到了 body，点击判断要同时看触发器和菜单本身
		const inside = (t: EventTarget | null) => !!ref.current?.contains(t as Node) || !!menuRef.current?.contains(t as Node);
		const h = (e: MouseEvent) => {
			if (!inside(e.target)) setOpen(false);
		};
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
	useLayoutEffect(() => {
		if (!open) return;
		const anchor = ref.current;
		const panel = menuRef.current;
		if (!anchor || !panel) return;
		natural.current = panel.offsetHeight; // 不受 maxHeight 限制的自然高度，用来决定往上还是往下
		const place = () => {
			const a = ref.current;
			const p = menuRef.current;
			if (!a || !p) return;
			const next = popoverStyle(a, p, placement, natural.current);
			setStyle((prev) => (prev.top === next.top && prev.left === next.left && prev.maxHeight === next.maxHeight && prev.visibility === next.visibility ? prev : next));
		};
		place();
		// 设置弹窗内容滚动、窗口缩放、菜单自己变高都要重新贴回触发器
		const ro = new ResizeObserver(place);
		ro.observe(panel);
		addEventListener("resize", place);
		document.addEventListener("scroll", place, true);
		return () => {
			ro.disconnect();
			removeEventListener("resize", place);
			document.removeEventListener("scroll", place, true);
		};
	}, [open, placement]);
	return { open, setOpen, ref, menuRef, style };
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

/**
 * 独立的「思考强度」小按钮（复用同一套档位文案与样式）。
 * current = null 表示跟随默认；传 followLabel 时菜单里多一个「跟随…」选项（子代理用）。
 */
export function ThinkingButton({ testid, levels, current, followLabel, onPick, text, title, ariaLabel, buttonClass, placement = "down" }: { testid: string; levels: string[]; current: string | null; followLabel?: string; onPick: (level: string | null) => void; text?: string; title?: string; ariaLabel?: string; buttonClass?: string; placement?: "up" | "down" }) {
	const { open, setOpen, ref, menuRef, style } = usePopover(placement);
	const label = text ?? (current ? (THINKING_LABEL[current] ?? current) : (followLabel ?? "思考"));
	return (
		<div className="relative min-w-0" ref={ref}>
			<button className={cx("pa-chip sm !shrink min-w-0", buttonClass)} onClick={() => setOpen(!open)} title={title ?? "思考强度"} aria-label={ariaLabel ?? `思考强度：${label}`} data-testid={testid}>
				<Brain className="pa-ic" />
				<span className="truncate">
					<span className="max-sm:hidden">思考·</span>
					{label}
				</span>
				<ChevronDown size={12} />
			</button>
			{open &&
				createPortal(
					<div ref={menuRef} style={style} className="pa-pop flex w-56 flex-col rounded-xl border border-line bg-card p-1.5 shadow-lg" data-testid={`${testid}-menu`}>
						{followLabel && (
						<button className={cx("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-hover", current === null && "bg-hover")} onClick={() => (setOpen(false), onPick(null))} data-testid={`${testid}-follow`}>
							<span className="flex-1 text-sm">{followLabel}</span>
							{current === null && <Check size={14} className="text-accent" />}
						</button>
					)}
						{/* 档位多 / 小屏（≤640 走底部弹窗）时自身可滚动，底部的 xhigh / max 不会被裁掉 */}
						<div className="min-h-0 flex-1 overflow-y-auto">
							{levels.map((l) => (
								<button key={l} className={cx("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-hover", current === l && "bg-hover")} onClick={() => (setOpen(false), onPick(l))} data-testid={`${testid}-${l}`}>
									<span className="flex-1">
										<span className="text-sm">{THINKING_LABEL[l] ?? l}</span>
										<span className="block text-xs text-mut">{THINKING_DESC[l] ?? ""}</span>
									</span>
									{current === l && <Check size={14} className="text-accent" />}
								</button>
							))}
						</div>
					</div>,
					document.body,
				)}
		</div>
	);
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
	/** 菜单顶部固定内容（子代理的「跟随 / 自动挑」等） */
	header?: ReactNode;
	/** 弹层定位由 ModelPickerButton 的 usePopover 提供（portal 到 body + fixed 锚定触发器） */
	panelRef?: RefObject<HTMLDivElement | null>;
	panelStyle?: CSSProperties;
}

export function ModelMenu({ id, models, providers, value, thinking, picks, onPick, groupByProvider = true, header, panelRef, panelStyle }: ModelMenuProps) {
	const [q, setQ] = useState("");
	const [openGroups, setOpenGroups] = useState<string[]>(() => (value?.provider ? [value.provider] : models[0] ? [models[0].provider] : []));
	const nameOf = (p: string) => providers.find((x) => x.id === p)?.name ?? models.find((m) => m.provider === p)?.providerName ?? p;
	const shown = searchModels(models, q, nameOf);
	// 「常用」是快捷入口：只在顶部多列一份，不从下面的服务分组里摘掉（去重只在同一分组内做）
	const frequent = frequentModels(models, picks, q, 5);
	const groups = groupByProvider ? groupModelsByProvider(shown, nameOf, value?.provider) : shown.length ? [{ provider: "", name: "", models: dedupeGroup(shown) }] : [];
	const isOpen = (p: string) => !groupByProvider || !!q.trim() || openGroups.includes(p);
	return (
		<div ref={panelRef} style={panelStyle} className="pa-pop flex w-80 flex-col rounded-xl border border-line bg-card p-1.5 shadow-lg" data-testid={`${id}-menu`}>
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
	const { open, setOpen, ref, menuRef, style } = usePopover(placement ?? "up");
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
			{open &&
				createPortal(
					<ModelMenu
						id={id}
						models={models}
						providers={providers}
						value={value}
						thinking={thinking ? { ...thinking, onPick: (l) => (setOpen(false), thinking.onPick(l)) } : null}
						picks={picks}
						groupByProvider={groupByProvider}
						panelRef={menuRef}
						panelStyle={style}
						header={header?.(() => setOpen(false))}
						onPick={(m) => (setOpen(false), onPick(m))}
					/>,
					document.body,
				)}
		</div>
	);
}

// ------------------------------------------------------------------ 候选池：多选（勾选后不关菜单）
function PoolOption({ m, checked, id, onToggle }: { m: ModelEntry; checked: boolean; id: string; onToggle: (m: ModelEntry, checked: boolean) => void }) {
	return (
		<label className={cx("flex w-full cursor-pointer items-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover", checked && "bg-hover")} data-testid={`${id}-option`} data-model={pickKey(m)}>
			<input type="checkbox" className="mt-1 shrink-0 accent-[var(--acc)]" checked={checked} onChange={(e) => onToggle(m, e.target.checked)} data-testid={`${id}-check`} />
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
		</label>
	);
}

export interface ModelPoolMenuProps {
	id: string;
	models: ModelEntry[];
	providers: Provider[];
	value: { provider: string; id: string }[];
	picks?: ModelPicks;
	onToggle: (m: ModelEntry, checked: boolean) => void;
	/** 弹层定位由 ModelPoolButton 的 usePopover 提供（portal 到 body + fixed 锚定触发器） */
	panelRef?: RefObject<HTMLDivElement | null>;
	panelStyle?: CSSProperties;
}

/** 候选池多选菜单：搜索 + 常用 + 按服务分组，勾选不关菜单（复用 ModelMenu 的分组/搜索/常用规则）。 */
export function ModelPoolMenu({ id, models, providers, value, picks, onToggle, panelRef, panelStyle }: ModelPoolMenuProps) {
	const [q, setQ] = useState("");
	const [openGroups, setOpenGroups] = useState<string[]>(() => (models[0] ? [models[0].provider] : []));
	const nameOf = (p: string) => providers.find((x) => x.id === p)?.name ?? models.find((m) => m.provider === p)?.providerName ?? p;
	const selKeys = new Set(value.map(pickKey));
	const shown = searchModels(models, q, nameOf);
	// 同 ModelMenu：常用只是快捷入口，候选池里选过的模型也要留在原服务分组
	const frequent = frequentModels(models, picks, q, 5);
	const groups = groupModelsByProvider(shown, nameOf);
	const isOpen = (p: string) => !!q.trim() || openGroups.includes(p);
	return (
		<div ref={panelRef} style={panelStyle} className="pa-pop flex w-80 flex-col rounded-xl border border-line bg-card p-1.5 shadow-lg" data-testid={`${id}-menu`}>
			<label className="mb-1 flex items-center gap-2 rounded-lg bg-hover px-2.5 py-1.5">
				<Search size={14} className="text-mut" />
				<input autoFocus className="min-w-0 flex-1 bg-transparent text-sm outline-none" placeholder="搜索模型或服务…" value={q} onChange={(e) => setQ(e.target.value)} data-testid={`${id}-search`} />
			</label>
			<div className="px-2.5 pb-1 text-[11px] text-mut2">{value.length ? `已选 ${value.length} 个；派活时在池内按任务挑，失败只在池内换` : "一个都不选 = 跟随主会话当前模型"}</div>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{!models.length && <div className="p-3 text-sm text-mut">还没有配置模型服务：在 设置 › 模型 里添加</div>}
				{!!models.length && !shown.length && <div className="p-3 text-sm text-mut">没有匹配的模型</div>}
				{frequent.length > 0 && (
					<div className="py-1" data-testid={`${id}-frequent`}>
						<div className="px-2.5 pb-0.5 text-[11px] font-semibold tracking-wide text-mut uppercase">常用</div>
						{frequent.map((m) => (
							<PoolOption key={pickKey(m)} m={m} checked={selKeys.has(pickKey(m))} id={id} onToggle={onToggle} />
						))}
					</div>
				)}
				{groups.map((g) => (
					<div key={g.provider} className="py-1">
						<button className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1 text-left" onClick={() => setOpenGroups((l) => (l.includes(g.provider) ? l.filter((x) => x !== g.provider) : [...l, g.provider]))} aria-expanded={isOpen(g.provider)} data-testid={`${id}-group-${g.provider}`}>
							<ChevronDown size={12} className={cx("shrink-0 text-mut transition-transform", !isOpen(g.provider) && "-rotate-90")} />
							<span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wide text-mut uppercase">{g.name}</span>
							<span className="shrink-0 text-[11px] text-mut2">{g.models.filter((m) => selKeys.has(pickKey(m))).length || g.models.length}</span>
						</button>
						{isOpen(g.provider) && g.models.map((m) => <PoolOption key={pickKey(m)} m={m} checked={selKeys.has(pickKey(m))} id={id} onToggle={onToggle} />)}
					</div>
				))}
			</div>
		</div>
	);
}

export interface ModelPoolButtonProps {
	testid: string;
	id?: string;
	models: ModelEntry[];
	providers: Provider[];
	value: { provider: string; id: string }[];
	picks?: ModelPicks;
	onToggle: (m: ModelEntry, checked: boolean) => void;
	text: string;
	title?: string;
	ariaLabel?: string;
	buttonClass?: string;
	placement?: "up" | "down";
	onOpen?: () => void;
}

/** 共用的「候选池按钮 + 多选菜单」：勾选后菜单不关，方便一次选好几个。 */
export function ModelPoolButton({ testid, id = testid, models, providers, value, picks, onToggle, text, title, ariaLabel, buttonClass, placement, onOpen }: ModelPoolButtonProps) {
	const { open, setOpen, ref, menuRef, style } = usePopover(placement ?? "down");
	return (
		<div className="relative min-w-0" ref={ref}>
			<button className={cx("pa-chip sm !shrink min-w-0", buttonClass)} onClick={() => { if (!open) onOpen?.(); setOpen(!open); }} title={title} aria-label={ariaLabel} data-testid={testid}>
				<Cpu className="pa-ic" />
				<span className="truncate">{text}</span>
				<ChevronDown size={12} />
			</button>
			{open && createPortal(<ModelPoolMenu id={id} models={models} providers={providers} value={value} picks={picks} onToggle={onToggle} panelRef={menuRef} panelStyle={style} />, document.body)}
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
