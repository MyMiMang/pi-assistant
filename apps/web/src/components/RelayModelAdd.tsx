import { THINKING_LEVEL_ORDER } from "@pi-assistant/shared";
import { Loader2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api";
import { THINKING_LABEL } from "../thinking-slider";
import type { CustomModel, CustomProviderMeta } from "../types";
import { Button, cx, Input } from "./ui";

function CapabilityPreview({ model }: { model: CustomModel }) {
	const capability = model.effectiveCapability;
	const levels = THINKING_LEVEL_ORDER.filter((level) => typeof capability?.levels?.[level] === "string");
	const vision = capability?.vision === true ? "能识图" : capability?.vision === false ? "不能识图" : "待确认";
	const thinking = capability?.reasoning === false ? "不支持思考" : capability?.reasoning === true
		? (levels.length ? `可选：${levels.map((level) => THINKING_LABEL[level]).join(" / ")}` : "会思考 · 档位待确认") : "待确认";
	return (
		<span className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 text-xs" data-testid="relay-add-capability">
			<span><span className="block text-mut">识图（读入图片）</span>{vision}</span>
			<span><span className="block text-mut">思考档位</span>{thinking}</span>
		</span>
	);
}

function CapabilitySources({ models }: { models: CustomModel[] }) {
	return (
		<details className="text-xs text-mut">
			<summary className="cursor-pointer">能力来源与手动纠正</summary>
			<div className="mt-2 max-h-36 space-y-1 overflow-y-auto">
				{models.map(({ id, effectiveCapability: c }) => (
					<p key={id} className="break-all"><code>{id}</code>：识图 {c?.visionSource ?? "未声明"} · 思考 {c?.reasoningSource ?? "未声明"} · 档位 {c?.levelsSource ?? "未声明"}{c?.source ? ` · ${c.source}` : ""}</p>
				))}
			</div>
			<p className="mt-2">需要纠正时，添加后展开模型修改；刷新列表不会覆盖手动设置。</p>
		</details>
	);
}

export function RelayModelAdd({ meta, onAdd, onClose }: {
	meta: CustomProviderMeta;
	onAdd: (models: CustomModel[], refreshExisting: boolean) => Promise<boolean>;
	onClose: () => void;
}) {
	const titleId = useId();
	// Parent keys this panel to the saved channel snapshot; identical reloads must not replace a live preview.
	const [directoryQuery] = useState(() => ({ id: meta.id, api: meta.api, baseUrl: meta.baseUrl, headers: meta.headerNames.map((name) => ({ name })) }));
	const [mode, setMode] = useState<"catalog" | "manual">("catalog");
	const [input, setInput] = useState("");
	const [attempt, setAttempt] = useState(0);
	const [models, setModels] = useState<CustomModel[] | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	const [error, setError] = useState("");
	const [saving, setSaving] = useState(false);
	const request = useRef<AbortController | null>(null);
	const applying = useRef(false);
	const id = input.trim();
	const [saved] = useState(() => new Set(meta.models.map((m) => m.id)));
	const previewId = mode === "manual" ? id : "";
	const duplicate = mode === "manual" && saved.has(id);
	const waiting = (mode === "catalog" || (!!id && !duplicate)) && !models && !error;
	const chosen = mode === "manual" ? models ?? [] : (models ?? []).filter((m) => selected.includes(m.id));
	const validChoice = chosen.length > 0 && (mode === "manual" || chosen.length === selected.length) && chosen.every((m) => !saved.has(m.id));

	useEffect(() => {
		if (mode === "manual" && (!previewId || duplicate)) return;
		const ctrl = new AbortController();
		request.current = ctrl;
		const load = async () => {
			try {
				if (mode === "manual") {
					const { model } = await api<{ model: CustomModel }>(`/api/models/custom/${encodeURIComponent(directoryQuery.id)}/add-preview`, { method: "POST", json: { modelId: previewId }, signal: ctrl.signal });
					if (model?.id !== previewId) throw new Error("返回的型号与输入不一致，请重新预览。");
					if (!ctrl.signal.aborted) setModels([{ id: previewId, effectiveCapability: model.effectiveCapability }]);
				} else {
					const { models: list } = await api<{ models: CustomModel[] }>("/api/models/custom/fetch-models", { method: "POST", json: directoryQuery, signal: ctrl.signal });
					if (!Array.isArray(list) || list.some((m) => typeof m?.id !== "string" || !m.id)) throw new Error("渠道返回的列表格式不正确。");
					if (!ctrl.signal.aborted) {
						const unique = new Map(list.map((m) => [m.id, m]));
						setSelected((ids) => ids.filter((id) => unique.has(id) && !saved.has(id)));
						setModels([...unique.values()]);
					}
				}
			} catch (e) {
				if (!ctrl.signal.aborted) setError(`${mode === "manual" ? "预览" : "获取列表"}失败：${e instanceof Error ? e.message : String(e)}`);
			}
		};
		const timer = window.setTimeout(() => void load(), mode === "manual" ? 250 : 0);
		return () => { window.clearTimeout(timer); ctrl.abort(); };
	}, [mode, previewId, duplicate, attempt, directoryQuery, saved]);

	const clearPreview = () => {
		request.current?.abort();
		setModels(null);
		setError("");
	};
	const changeMode = (next: typeof mode) => {
		if (mode === next || applying.current) return;
		clearPreview();
		setSelected([]);
		setMode(next);
	};
	const refresh = () => {
		clearPreview();
		setAttempt((n) => n + 1);
	};
	const save = async (refreshExisting: boolean) => {
		if (applying.current || !models || (refreshExisting ? mode !== "catalog" || !models.length : !validChoice)) return;
		applying.current = true;
		setError("");
		setSaving(true);
		try {
			if (await onAdd(refreshExisting ? models : chosen, refreshExisting)) onClose();
			else setError("没有保存，请查看渠道错误后重试。");
		} finally {
			applying.current = false;
			setSaving(false);
		}
	};

	return (
		<section aria-labelledby={titleId} className="min-w-0 space-y-3 rounded-xl border border-accent/40 bg-card p-3" data-testid="relay-add-panel">
			<div><h3 id={titleId} className="text-sm font-semibold">添加模型</h3><p className="text-xs text-mut">先看识图与思考档位，再添加到当前渠道。</p></div>
			<div className="flex flex-wrap gap-2" role="group" aria-label="添加方式">
				<Button type="button" variant={mode === "catalog" ? "outline" : "ghost"} size="sm" aria-pressed={mode === "catalog"} data-testid="relay-add-catalog" disabled={saving} onClick={() => changeMode("catalog")}>从渠道目录选</Button>
				<Button type="button" variant={mode === "manual" ? "outline" : "ghost"} size="sm" aria-pressed={mode === "manual"} data-testid="relay-add-manual" disabled={saving} onClick={() => changeMode("manual")}>手动输入型号</Button>
			</div>
			{mode === "catalog" ? (
				<div className="space-y-2" data-testid="relay-fetched">
					<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-mut">
						<span>{models ? `已获取 ${models.length} 个型号，可多选` : "沿用当前渠道的连接设置"}</span>
						<Button type="button" size="sm" variant="outline" disabled={saving || waiting} onClick={refresh} data-testid="relay-fetch">{models ? "重新获取列表" : "获取模型列表"}</Button>
					</div>
					{models && !models.length && <p className="text-xs text-mut">目录没有返回型号，可以手动输入。</p>}
					{models && models.length > 0 && <div className="max-h-64 space-y-1.5 overflow-y-auto">
						{models.map((m) => {
							const checked = selected.includes(m.id);
							const exists = saved.has(m.id);
							return <label key={m.id} data-testid="relay-add-directory-row" data-model={m.id} className={cx("block space-y-1 rounded-lg border p-2", checked ? "border-accent bg-accent-soft" : "border-line")}>
								<span className="flex items-start gap-2 text-xs">
									<input type="checkbox" className="mt-0.5 shrink-0" aria-label={m.id} checked={checked} disabled={saving || exists} onChange={(e) => { const checked = e.target.checked; setSelected((ids) => checked ? [...ids, m.id] : ids.filter((x) => x !== m.id)); }} />
									<code className="min-w-0 break-all">{m.id}</code>{exists && <span className="shrink-0 text-mut">已添加</span>}
								</span>
								<CapabilityPreview model={m} />
							</label>;
						})}
					</div>}
				</div>
			) : (
				<div className="space-y-2">
					<label className="block space-y-1 text-xs"><span>模型 ID</span><Input autoComplete="off" placeholder="输入型号，也可输入目录未收录的型号" value={input} disabled={saving} data-testid="relay-add-input" onChange={(e) => {
						if (e.target.value.trim() !== id) clearPreview();
						setInput(e.target.value);
					}} /></label>
					{duplicate && <p className="text-xs text-mut">当前渠道已有这个型号。</p>}
					{models?.[0] && <div className="space-y-1 rounded-lg border border-line p-2" data-testid="relay-add-preview"><code className="break-all text-xs">{id}</code><CapabilityPreview model={models[0]} /></div>}
					{error && !models && <Button type="button" size="sm" variant="outline" onClick={refresh}>重新预览</Button>}
				</div>
			)}
			{waiting && <p role="status" className="flex items-center gap-1 text-xs text-mut"><Loader2 size={13} className="animate-spin" />{mode === "catalog" ? "正在获取目录…" : "正在预览能力…"}</p>}
			{error && <p role="alert" className="break-words text-xs text-red-600">{error}</p>}
			<div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
				<span className="mr-auto text-xs text-mut">{validChoice && `已选 ${chosen.length} 款 · `}待确认也能添加。</span>
				<Button type="button" size="sm" variant="ghost" data-testid="relay-add-cancel" disabled={saving} onClick={() => { if (!applying.current) { clearPreview(); onClose(); } }}>取消</Button>
				<Button type="button" size="sm" variant="primary" disabled={saving || !validChoice} onClick={() => void save(false)} data-testid="relay-add-save">
					{saving && <Loader2 size={13} className="animate-spin" />}{validChoice ? `添加 ${chosen.length} 款到当前渠道` : "添加到当前渠道"}
				</Button>
			</div>
			{!!models?.length && <CapabilitySources models={models} />}
			{mode === "catalog" && !!models?.length && <details className="text-xs text-mut">
				<summary className="cursor-pointer" data-testid="relay-add-refresh-options">批量添加并刷新已有能力</summary>
				<p className="my-1">此操作不按勾选范围：添加当前目录的所有新型号，并刷新已有型号的列表能力；手动设置保留。</p>
				<Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void save(true)} data-testid="relay-add-refresh-existing">添加新模型并更新已有能力</Button>
			</details>}
		</section>
	);
}
