/** 设置 › 用量：今天 / 7 天 / 30 天的费用与 token、按模型 / 助理 / 群、每日柱状图、缓存命中率与省下的钱；价格与汇率设置 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { type Fx, fmtMoney, fmtPct, fmtTok, refreshFx, useFx } from "./usage-fmt";
import { Help, cx } from "./ui";

type Range = "today" | "7d" | "30d";
interface Row {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	cost: number;
	saved: number;
	unknownCalls: number;
	hitRate: number | null;
	[k: string]: unknown;
}
interface Summary {
	totals: Row;
	daily: (Row & { day: string })[];
	byModel: (Row & { provider: string; providerName: string; model: string })[];
	byAgent: (Row & { agent_id: string; name: string })[];
	byRoom: (Row & { room_id: string; name: string })[];
	hasAny: boolean;
}

export function useUsageSummary(range: Range, q: { room?: string } = {}, k = 0) {
	const [s, setS] = useState<Summary | null>(null);
	const key = `${range}|${q.room ?? ""}|${k}`;
	useEffect(() => {
		let off = false;
		const qs = new URLSearchParams({ range, ...(q.room ? { room: q.room } : {}) });
		void api<Summary>(`/api/usage/summary?${qs}`).then((r) => !off && setS(r)).catch(() => {});
		return () => void (off = true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key]);
	return s;
}

/** 费用：有未知价格时提示 “另有 N 次价格未知” */
const Cost = ({ r, fx }: { r: Row; fx: Fx }) => (
	<>
		{r.calls && r.unknownCalls === r.calls ? "—" : fmtMoney(r.cost, fx)}
		{r.unknownCalls > 0 && r.unknownCalls < r.calls && <small className="ml-1 text-mut2">+{r.unknownCalls} 次未知</small>}
	</>
);

function Stat({ label, value, help, testId }: { label: string; value: React.ReactNode; help?: string; testId?: string }) {
	return (
		<div className="min-w-0 rounded-xl border border-line p-3" data-testid={testId}>
			<div className="flex items-center gap-1 text-xs text-mut">
				{label}
				{help && <Help>{help}</Help>}
			</div>
			<div className="mt-1 truncate text-lg font-semibold tabular-nums">{value}</div>
		</div>
	);
}

function Bars({ daily, fx, range }: { daily: Summary["daily"]; fx: Fx; range: Range }) {
	// 补齐没有用量的日子
	const days = useMemo(() => {
		const n = range === "today" ? 1 : range === "7d" ? 7 : 30;
		const map = new Map(daily.map((d) => [d.day, d]));
		const out: { day: string; cost: number; tok: number }[] = [];
		for (let i = n - 1; i >= 0; i--) {
			const day = new Date(Date.now() - i * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
			const d = map.get(day);
			out.push({ day, cost: d?.cost ?? 0, tok: d ? d.input + d.output + d.cacheRead + d.cacheWrite : 0 });
		}
		return out;
	}, [daily, range]);
	const byCost = days.some((d) => d.cost > 0);
	const max = Math.max(1e-12, ...days.map((d) => (byCost ? d.cost : d.tok)));
	return (
		<div data-testid="usage-chart">
			<div className="mb-1 text-xs text-mut">每日{byCost ? "费用" : " token"}</div>
			<div className="flex h-28 items-end gap-[3px]">
				{days.map((d) => {
					const v = byCost ? d.cost : d.tok;
					return (
						<div key={d.day} className="group relative flex h-full min-w-0 flex-1 items-end" title={`${d.day}：${fmtMoney(d.cost, fx)} · ${fmtTok(d.tok)} token`}>
							<div className="w-full rounded-t bg-accent/70 group-hover:bg-accent" style={{ height: `${v ? Math.max(4, (v / max) * 100) : 1}%` }} />
						</div>
					);
				})}
			</div>
			<div className="mt-1 flex justify-between text-[10px] text-mut2">
				<span>{days[0]?.day.slice(5)}</span>
				<span>{days[days.length - 1]?.day.slice(5)}</span>
			</div>
		</div>
	);
}

function Table({ rows, fx, name }: { rows: (Row & { label: string; sub?: string })[]; fx: Fx; name: string }) {
	if (!rows.length) return <div className="py-4 text-center text-sm text-mut2">暂无</div>;
	const max = Math.max(1e-12, ...rows.map((r) => r.cost || 0));
	return (
		<div className="overflow-x-auto">
			<table className="w-full min-w-[420px] text-sm" data-testid={`usage-table-${name}`}>
				<thead>
					<tr className="text-left text-xs text-mut">
						<th className="py-1.5 font-normal">名称</th>
						<th className="py-1.5 text-right font-normal">费用</th>
						<th className="py-1.5 text-right font-normal">输入 / 输出</th>
						<th className="py-1.5 text-right font-normal">缓存命中</th>
						<th className="py-1.5 text-right font-normal">次数</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((r, i) => (
						<tr key={i} className="border-t border-line">
							<td className="max-w-[180px] py-1.5 pr-2">
								<div className="truncate">{r.label}</div>
								{r.sub && <div className="truncate text-[11px] text-mut2">{r.sub}</div>}
								<div className="mt-0.5 h-1 rounded bg-accent/60" style={{ width: `${((r.cost || 0) / max) * 100}%` }} />
							</td>
							<td className="py-1.5 text-right tabular-nums whitespace-nowrap"><Cost r={r} fx={fx} /></td>
							<td className="py-1.5 text-right tabular-nums whitespace-nowrap">{fmtTok(r.input + r.cacheRead + r.cacheWrite)} / {fmtTok(r.output)}</td>
							<td className="py-1.5 text-right tabular-nums">{fmtPct(r.hitRate)}</td>
							<td className="py-1.5 text-right tabular-nums">{r.calls}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export function UsageTab() {
	const fx = useFx();
	const [range, setRange] = useState<Range>("7d");
	const [by, setBy] = useState<"model" | "agent" | "room">("model");
	const [k, setK] = useState(0);
	const s = useUsageSummary(range, {}, k);
	const t = s?.totals;
	const rows =
		!s ? [] : by === "model" ? s.byModel.map((r) => ({ ...r, label: r.model, sub: r.providerName })) : by === "agent" ? s.byAgent.map((r) => ({ ...r, label: r.name })) : s.byRoom.map((r) => ({ ...r, label: r.name }));
	return (
		<div className="space-y-6" data-testid="usage-tab">
			<section>
				<div className="mb-3 flex flex-wrap items-center gap-2">
					<div className="flex min-w-0 items-center gap-1.5 font-semibold">
						用量
						<Help>每次调用模型都会记下 token 数，按当时的价格算费用。价格来自 models.dev 或你在下面填的自定义价格；查不到价格的显示「—」，补上价格后会自动重算。明细保留 90 天，更早的按天汇总。</Help>
					</div>
					<div className="ml-auto flex gap-1" role="tablist">
						{(["today", "7d", "30d"] as Range[]).map((r) => (
							<button key={r} className={cx("pa-chip sm", range === r && "!bg-accent-soft !text-accent")} onClick={() => setRange(r)} data-testid={`usage-range-${r}`}>
								{{ today: "今天", "7d": "7 天", "30d": "30 天" }[r]}
							</button>
						))}
					</div>
				</div>
				{!s ? (
					<div className="py-6 text-center text-sm text-mut2">加载中…</div>
				) : (
					<>
						<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
							<Stat label="费用" value={<Cost r={t!} fx={fx} />} testId="usage-cost" help={t!.unknownCalls ? `有 ${t!.unknownCalls} 次调用查不到价格，没算进去。可以在下面「价格」里补上。` : undefined} />
							<Stat label="token" value={fmtTok(t!.input + t!.output + t!.cacheRead + t!.cacheWrite)} help={`输入 ${fmtTok(t!.input)} · 读缓存 ${fmtTok(t!.cacheRead)} · 写缓存 ${fmtTok(t!.cacheWrite)} · 输出 ${fmtTok(t!.output)}（其中推理 ${fmtTok(t!.reasoning)}）`} />
							<Stat label="缓存命中率" value={fmtPct(t!.hitRate)} testId="usage-hit" help="读缓存的 token ÷ 全部输入 token（新输入 + 读缓存 + 写缓存）。命中的部分通常只收一到两折。" />
							<Stat label="缓存省下" value={fmtMoney(t!.saved, fx)} testId="usage-saved" help="读缓存的 token 如果按原价输入要多花的钱。" />
						</div>
						<div className="mt-4">
							<Bars daily={s.daily} fx={fx} range={range} />
						</div>
					</>
				)}
			</section>
			{s && (
				<section>
					<div className="mb-2 flex gap-1">
						{(["model", "agent", "room"] as const).map((b) => (
							<button key={b} className={cx("pa-chip sm", by === b && "!bg-accent-soft !text-accent")} onClick={() => setBy(b)} data-testid={`usage-by-${b}`}>
								{{ model: "按模型", agent: "按助理", room: "按群聊" }[b]}
							</button>
						))}
					</div>
					<Table rows={rows} fx={fx} name={by} />
				</section>
			)}
			<PriceSettings onChanged={() => setK((x) => x + 1)} />
		</div>
	);
}

interface PriceModel {
	provider: string;
	providerName: string;
	id: string;
	name?: string;
	price: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null;
	source: string;
	note: string;
}
type Override = { mode: "discount"; discount: number } | { mode: "price"; currency: "USD" | "CNY"; input: number; output: number; cacheRead?: number; cacheWrite?: number };

function PriceSettings({ onChanged }: { onChanged: () => void }) {
	const fx = useFx();
	const [d, setD] = useState<{ fx: Fx; prices: Record<string, Override>; models: PriceModel[] } | null>(null);
	const [edit, setEdit] = useState<string | null>(null);
	const load = () => void api<typeof d>("/api/usage/settings").then(setD).catch(() => {});
	useEffect(load, []);
	const save = async (json: object) => {
		await api("/api/usage/settings", { method: "PUT", json });
		const r = await api<NonNullable<typeof d>>("/api/usage/settings");
		setD(r);
		refreshFx(r.fx);
		onChanged();
	};
	if (!d) return null;
	const perM = (usd: number | undefined) => (usd === undefined ? "—" : fmtMoney(usd, fx).replace(/^([¥$])/, "$1"));
	return (
		<section data-testid="usage-prices">
			<div className="mb-3 flex items-center gap-1.5 font-semibold">
				价格
				<Help>单价是每百万 token。中转站、自建服务查不到价格时，可以按服务填「官方价打几折」，或直接填单价（人民币或美元）。</Help>
			</div>
			<div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
				<span className="text-mut">显示</span>
				<select className="pa-input !h-8 !w-auto !px-2 text-sm" value={d.fx.display} onChange={(e) => void save({ fx: { display: e.target.value } })} data-testid="usage-currency">
					<option value="CNY">人民币 ¥</option>
					<option value="USD">美元 $</option>
				</select>
				<span className="text-mut">汇率 1 美元 =</span>
				<input className="pa-input !h-8 !w-20 !px-2 text-sm" type="number" step="0.01" min="0.01" defaultValue={d.fx.rate} onBlur={(e) => Number(e.target.value) > 0 && Number(e.target.value) !== d.fx.rate && void save({ fx: { rate: Number(e.target.value) } })} aria-label="汇率" data-testid="usage-rate" />
				<span className="text-mut">元</span>
			</div>
			<div className="space-y-1.5">
				{d.models.map((m) => {
					const key = `${m.provider}/${m.id}`;
					const ov = d.prices[key] ?? d.prices[`${m.provider}/*`];
					return (
						<div key={key} className="rounded-lg border border-line p-2" data-testid="price-row" data-model={key}>
							<div className="flex min-w-0 items-center gap-2 text-sm">
								<div className="min-w-0 flex-1">
									<div className="truncate">{m.name || m.id}</div>
									<div className="truncate text-[11px] text-mut2">
										{m.providerName} · {m.price ? `输入 ${perM(m.price.input)} / 输出 ${perM(m.price.output)}${m.price.cacheRead !== undefined ? ` / 读缓存 ${perM(m.price.cacheRead)}` : ""}` : "价格未知"} · {m.note}
									</div>
								</div>
								<button className="pa-chip sm shrink-0" onClick={() => setEdit(edit === key ? null : key)} data-testid="price-edit">
									{ov ? "改" : "自定义"}
								</button>
							</div>
							{edit === key && <OverrideForm m={m} ov={ov} onSave={async (scope, v) => (await save({ price: { key: scope, value: v } }), setEdit(null))} />}
						</div>
					);
				})}
				{!d.models.length && <div className="text-sm text-mut2">还没有配置模型</div>}
			</div>
		</section>
	);
}

function OverrideForm({ m, ov, onSave }: { m: PriceModel; ov?: Override; onSave: (scope: string, v: Override | null) => void }) {
	const [mode, setMode] = useState<"discount" | "price">(ov?.mode ?? (m.price ? "discount" : "price"));
	const [scope, setScope] = useState<"model" | "provider">("model");
	const [disc, setDisc] = useState(ov?.mode === "discount" ? String(ov.discount) : "1");
	const [cur, setCur] = useState<"CNY" | "USD">(ov?.mode === "price" ? ov.currency : "CNY");
	const [vals, setVals] = useState<Record<string, string>>(ov?.mode === "price" ? { input: String(ov.input), output: String(ov.output), cacheRead: ov.cacheRead !== undefined ? String(ov.cacheRead) : "", cacheWrite: ov.cacheWrite !== undefined ? String(ov.cacheWrite) : "" } : { input: "", output: "", cacheRead: "", cacheWrite: "" });
	const key = scope === "model" ? `${m.provider}/${m.id}` : `${m.provider}/*`;
	const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
	return (
		<div className="mt-2 space-y-2 border-t border-line pt-2 text-sm" data-testid="price-form">
			<div className="flex flex-wrap gap-1">
				<button className={cx("pa-chip sm", mode === "discount" && "!bg-accent-soft !text-accent")} onClick={() => setMode("discount")} disabled={!m.price && !ov}>官方价打折</button>
				<button className={cx("pa-chip sm", mode === "price" && "!bg-accent-soft !text-accent")} onClick={() => setMode("price")}>填单价</button>
				<select className="pa-input ml-auto !h-7 !w-auto !px-1.5 text-xs" value={scope} onChange={(e) => setScope(e.target.value as "model")} aria-label="适用范围">
					<option value="model">只这个模型</option>
					<option value="provider">{m.providerName} 的全部模型</option>
				</select>
			</div>
			{mode === "discount" ? (
				<label className="flex items-center gap-2">
					<span className="text-mut">官方价 ×</span>
					<input className="pa-input !h-8 !w-24 !px-2" type="number" step="0.05" min="0" value={disc} onChange={(e) => setDisc(e.target.value)} data-testid="price-discount" />
					<Help>例如中转按官方价 8 折收费就填 0.8。</Help>
				</label>
			) : (
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
					<select className="pa-input !h-8 !px-1.5 text-xs" value={cur} onChange={(e) => setCur(e.target.value as "CNY")} aria-label="币种">
						<option value="CNY">元 / 百万</option>
						<option value="USD">美元 / 百万</option>
					</select>
					{(["input", "output", "cacheRead", "cacheWrite"] as const).map((f) => (
						<input key={f} className="pa-input !h-8 !px-2 text-xs" type="number" step="0.01" min="0" placeholder={{ input: "输入", output: "输出", cacheRead: "读缓存（可空）", cacheWrite: "写缓存（可空）" }[f]} value={vals[f]} onChange={(e) => setVals({ ...vals, [f]: e.target.value })} aria-label={f} data-testid={`price-${f}`} />
					))}
				</div>
			)}
			<div className="flex gap-2">
				<button
					className="pa-chip sm !bg-accent !text-white"
					data-testid="price-save"
					onClick={() => onSave(key, mode === "discount" ? { mode, discount: Number(disc) } : { mode, currency: cur, input: Number(vals.input) || 0, output: Number(vals.output) || 0, cacheRead: num(vals.cacheRead), cacheWrite: num(vals.cacheWrite) })}
				>
					保存
				</button>
				{ov && (
					<button className="pa-chip sm" onClick={() => onSave(key, null)}>
						恢复默认
					</button>
				)}
			</div>
		</div>
	);
}

/** 群聊顶部：这个群累计花了多少（30 天） */
export function RoomCost({ roomId }: { roomId: string }) {
	const fx = useFx();
	const s = useUsageSummary("30d", { room: roomId });
	if (!s?.hasAny) return null;
	const t = s.totals;
	return (
		<span data-testid="room-cost" title={`近 30 天：${fmtTok(t.input + t.output + t.cacheRead + t.cacheWrite)} token，缓存命中 ${fmtPct(t.hitRate)}`}>
			{" · "}近 30 天 {t.calls && t.unknownCalls === t.calls ? "—" : fmtMoney(t.cost, fx)}
		</span>
	);
}
