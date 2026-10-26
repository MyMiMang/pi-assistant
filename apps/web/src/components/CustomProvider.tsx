/**
 * 自定义模型服务表单：中转站 / 第三方 / 本地推理服务（OpenAI 兼容、Anthropic 兼容……）。
 * API 类型列表来自服务端（pi-ai 的 API 注册表），保存后写入 Pi 的 models.json。
 */
import { CheckCircle2, Download, Loader2, Pencil, Plus, RotateCcw, Trash2, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { CustomModel, CustomProviderMeta, ProviderReferences } from "../types";
import { Badge, Button, cx, Input, Help, Select, useConfirm } from "./ui";

const PLACEHOLDER: Record<string, string> = {
	"openai-completions": "https://api.example.com/v1",
	"openai-responses": "https://api.example.com/v1",
	"anthropic-messages": "https://api.example.com/anthropic",
	"google-generative-ai": "https://generativelanguage.googleapis.com/v1beta",
};

export function useCustomProviders() {
	const [data, setData] = useState<{ providers: CustomProviderMeta[]; apis: { id: string; label: string }[]; classifierProtocols: string[] }>({ providers: [], apis: [], classifierProtocols: [] });
	const reload = () => api("/api/models/custom").then(setData);
	useEffect(() => {
		void reload();
	}, []);
	return { ...data, reload };
}

export const SOURCE: Record<string, string> = { detected: "自动识别", known: "已知模型", default: "自动（默认）", user: "手动", learned: "自动学习" };

/** token 数 → 简短好读：1048576 → 1M，131072 → 128K，384000 → 384K，235929 → 236K */
export function fmtTokens(n?: number): string {
	if (!n) return "—";
	const trim = (v: number) => (v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
	if (n >= 1_000_000) return `${trim(n % 1_048_576 === 0 ? n / 1_048_576 : n / 1_000_000)}M`;
	if (n >= 1000) return `${trim(n % 1024 === 0 ? n / 1024 : n / 1000)}K`;
	return String(n);
}
/** 用户输入 → token 数：128k / 1m / 1.5M / 131072；不带单位且小于 10000 的按 K 算（“128” 就是 128K） */
export function parseTokens(s: string): number | undefined {
	const m = s.trim().replace(/,/g, "").match(/^(\d+(?:\.\d+)?)\s*([km])?$/i);
	if (!m) return undefined;
	const v = Number(m[1]);
	const u = m[2]?.toLowerCase();
	const n = u === "m" ? v * 1_000_000 : u === "k" || v < 10_000 ? v * 1000 : v;
	return n >= 1000 ? Math.round(n) : undefined;
}
export const CTX_PRESETS: [string, number][] = [["32K", 32_768], ["64K", 65_536], ["128K", 131_072], ["200K", 200_000], ["1M", 1_048_576]];
export const OUT_PRESETS: [string, number][] = [["4K", 4096], ["8K", 8192], ["16K", 16_384], ["32K", 32_768], ["64K", 65_536]];

/** 删除前把“谁会受影响”拼成人话，避免用户删完才发现别处坏了 */
export function deleteImpact(r?: ProviderReferences): string {
	if (!r) return "";
	const lines: string[] = [];
	if (r.defaultModel) lines.push("• 默认模型会被清空，需要重新选一个");
	if (r.visionModel) lines.push("• 识图模型会改回自动选择");
	if (r.subagents) lines.push("• 帮手的固定模型会改回“跟随主会话模型”");
	if (r.subagentAgents.length) lines.push(`• ${r.subagentAgents.length} 个助理的帮手候选池里会去掉这个服务的模型`);
	if (r.agents.length) {
		const names = r.agents.slice(0, 3).join("、");
		lines.push(`• ${r.agents.length} 个助理（${names}${r.agents.length > 3 ? " 等" : ""}）的模型会回落到默认模型`);
	}
	return lines.length ? `\n\n会影响：\n${lines.join("\n")}` : "";
}

export function LimitField({ label, value, presets, onChange, testid }: { label: string; value?: number; presets: [string, number][]; onChange: (v: number) => void; testid: string }) {
	const [text, setText] = useState(value ? fmtTokens(value) : "");
	const [bad, setBad] = useState(false);
	useEffect(() => setText(value ? fmtTokens(value) : ""), [value]);
	const commit = () => {
		const v = parseTokens(text);
		setBad(!v);
		if (v) onChange(v);
	};
	return (
		<div className="min-w-0 space-y-1.5">
			<div className="text-[11px] text-mut">{label}</div>
			<div className="flex flex-wrap gap-1">
				{presets.map(([t, v]) => (
					<button key={t} type="button" onClick={() => onChange(v)} className={cx("rounded-full border px-2 py-0.5 text-[11px]", value === v ? "border-accent bg-accent-soft text-accent" : "border-line text-mut hover:text-fg")}>
						{t}
					</button>
				))}
			</div>
			<input
				className={cx("pa-input !h-7 !w-full !px-2 !text-xs", bad && "!border-red-500")}
				aria-label={label}
				data-testid={testid}
				placeholder="例如 128k、1m"
				value={text}
				onChange={(e) => (setText(e.target.value), setBad(false))}
				onBlur={commit}
				onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), commit())}
			/>
			{bad && <div className="text-[11px] text-red-600">填数字加单位，如 128k、1m</div>}
		</div>
	);
}

/** 一行一个模型：模型名永远完整占一行（太长截断，悬停看全名），下面是“1M 上下文 · 384K 输出”和来源；点一下展开编辑 */
function ModelRow({ m, onChange, onRemove }: { m: CustomModel; onChange: (p: Partial<CustomModel>) => void; onRemove: () => void }) {
	const [edit, setEdit] = useState(false);
	const src = SOURCE[m.limitsSource ?? ""] ?? "保存时自动";
	return (
		<div className="min-w-0 px-3 py-2" data-testid="custom-model-row" data-model={m.id}>
			<div className="flex min-w-0 items-center gap-2">
				<span className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg" title={m.id} data-testid="custom-model-name">
					{m.id}
				</span>
				<button type="button" className="shrink-0 rounded p-1 text-mut hover:bg-hover hover:text-fg" onClick={onRemove} aria-label={`移除 ${m.id}`} title="移除">
					<X size={13} />
				</button>
			</div>
			<button type="button" onClick={() => setEdit((x) => !x)} className="group mt-0.5 flex max-w-full min-w-0 items-center gap-1.5 text-left text-[11px] text-mut hover:text-fg" aria-expanded={edit} aria-label={`编辑 ${m.id} 的上下文和输出长度`} data-testid="custom-model-limits">
				<span className="truncate" data-testid="limits-text">
					{m.contextWindow || m.maxTokens ? `${fmtTokens(m.contextWindow)} 上下文 · ${fmtTokens(m.maxTokens)} 输出` : "上下文 / 输出：保存时自动识别"}
				</span>
				{(m.contextWindow || m.maxTokens) && <span className={cx("shrink-0 rounded-full px-1.5 py-px", m.limitsSource === "user" ? "bg-accent-soft text-accent" : "bg-hover")} data-testid="limits-source">
					{src}
				</span>}
				<Pencil size={11} className="shrink-0 opacity-60 group-hover:opacity-100" />
			</button>
			{edit && (
				<div className="mt-2 rounded-lg border border-line bg-hover p-2.5" data-testid="custom-model-editor">
					<div className="grid gap-3 sm:grid-cols-2">
						<LimitField label="上下文长度" testid="ctx-input" value={m.contextWindow} presets={CTX_PRESETS} onChange={(v) => onChange({ contextWindow: v, limitsSource: "user" })} />
						<LimitField label="最大输出" testid="out-input" value={m.maxTokens} presets={OUT_PRESETS} onChange={(v) => onChange({ maxTokens: v, limitsSource: "user" })} />
					</div>
					<div className="mt-2 flex flex-wrap items-center justify-between gap-2">
						<button type="button" className="flex items-center gap-1 text-[11px] text-mut hover:text-fg" onClick={() => (onChange({ contextWindow: undefined, maxTokens: undefined, limitsSource: undefined }), setEdit(false))}>
							<RotateCcw size={11} /> 恢复自动
						</button>
						<Button size="sm" variant="ghost" onClick={() => setEdit(false)}>
							完成
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

export function CustomProviderForm({ initial, apis, classifierProtocols = [], onSaved, onCancel, onDeleted }: { initial?: CustomProviderMeta; apis: { id: string; label: string }[]; classifierProtocols?: string[]; onSaved: (m: CustomProviderMeta) => void; onCancel?: () => void; onDeleted?: () => void }) {
	const [dialog, ask] = useConfirm();
	const [name, setName] = useState(initial?.name ?? "");
	const [apiType, setApiType] = useState(initial?.api ?? (apis.some((a) => a.id === "openai-completions") || !apis.length ? "openai-completions" : apis[0].id));
	const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
	const [apiKey, setApiKey] = useState("");
	const [noKey, setNoKey] = useState(initial?.noKey ?? false);
	const [headers, setHeaders] = useState<{ name: string; value?: string; saved?: boolean }[]>(initial?.headerNames.map((n) => ({ name: n, saved: true })) ?? []);
	const [models, setModels] = useState<CustomModel[]>(initial?.models ?? []);
	const [classifiers, setClassifiers] = useState<{ protocol: string; modelId: string }[]>(initial?.classifiers?.map((c) => ({ protocol: c.protocol, modelId: c.modelId })) ?? []);
	const [newModel, setNewModel] = useState("");
	const [fetched, setFetched] = useState<CustomModel[] | null>(null);
	const [busy, setBusy] = useState<"" | "fetch" | "save" | "test">("");
	const [err, setErr] = useState("");
	const [saved, setSaved] = useState<CustomProviderMeta | null>(initial ?? null);
	const [testModel, setTestModel] = useState(initial?.models[0]?.id ?? "");
	const [apiTouched, setApiTouched] = useState(!!initial);
	// 新建时从地址猜接口格式和名称（只预填：名称为空才填、格式没手动改过才改）
	const guess = async (url: string) => {
		if (initial || !url.trim()) return;
		const g = await api<{ api?: string; name?: string }>(`/api/models/custom/guess?url=${encodeURIComponent(url)}`).catch(() => ({}) as { api?: string; name?: string });
		if (g.api && !apiTouched && apis.some((a) => a.id === g.api)) setApiType(g.api);
		if (g.name) setName((n) => n || g.name!);
	};
	const [test, setTest] = useState<{ ok: boolean; message: string; detail?: string } | null>(null);
	useEffect(() => {
		if (!apiType && apis[0]) setApiType(apis[0].id);
	}, [apis]);

	const hdrPayload = () => headers.filter((h) => h.name.trim()).map((h) => ({ name: h.name.trim(), value: h.saved && !h.value ? undefined : (h.value ?? "") }));
	const addModel = (m: string | CustomModel) => {
		const x = typeof m === "string" ? { id: m.trim() } : { ...m, id: m.id.trim() };
		if (x.id && !models.some((y) => y.id === x.id)) setModels((l) => [...l, x]);
	};
	const patchModel = (id: string, p: Partial<CustomModel>) => setModels((l) => l.map((m) => (m.id === id ? { ...m, ...p } : m)));
	const fetchModels = async () => {
		setBusy("fetch");
		setErr("");
		try {
			const r = await api("/api/models/custom/fetch-models", { method: "POST", json: { id: initial?.id, api: apiType, baseUrl, apiKey: apiKey || undefined, headers: hdrPayload() } });
			setFetched(r.models);
		} catch (e) {
			setErr(`自动获取失败：${e instanceof Error ? e.message : e}`);
		} finally {
			setBusy("");
		}
	};
	const save = async () => {
		setBusy("save");
		setErr("");
		try {
			const body = { name, api: apiType, baseUrl, apiKey: noKey ? undefined : apiKey || undefined, noKey, headers: hdrPayload(), models, classifiers: classifiers.filter((c) => c.modelId.trim()).map((c) => ({ protocol: c.protocol, modelId: c.modelId.trim() })) };
			const editId = saved?.id ?? initial?.id;
			const m: CustomProviderMeta = await api(editId ? `/api/models/custom/${editId}` : "/api/models/custom", { method: editId ? "PUT" : "POST", json: body });
			setSaved(m);
			setModels(m.models);
			setClassifiers(m.classifiers?.map((c) => ({ protocol: c.protocol, modelId: c.modelId })) ?? []);
			setApiKey("");
			setHeaders(m.headerNames.map((n) => ({ name: n, saved: true })));
			if (!m.models.some((x) => x.id === testModel)) setTestModel(m.models[0]?.id ?? "");
			onSaved(m);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy("");
		}
	};
	const runTest = async () => {
		if (!saved) return;
		setBusy("test");
		setTest(await api("/api/models/test", { method: "POST", json: { provider: saved.id, model: testModel } }).finally(() => setBusy("")));
	};
	const label = (t: string) => <span className="text-xs font-medium text-zinc-500">{t}</span>;
	return (
		<div className="space-y-4" data-testid="custom-provider-form">
			{dialog}
			<div className="grid gap-3 sm:grid-cols-2">
				<label className="block space-y-1">
					{label("名称")}
					<Input placeholder="例如：我的中转站" value={name} onChange={(e) => setName(e.target.value)} />
				</label>
				<label className="block space-y-1">
					{label("API 类型")}
					<select value={apiType} onChange={(e) => (setApiType(e.target.value), setApiTouched(true))} className="h-9 w-full rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" aria-label="API 类型">
						{apis.map((a) => (
							<option key={a.id} value={a.id}>
								{a.label}
							</option>
						))}
					</select>
				</label>
			</div>
			<label className="block space-y-1">
				{label("Base URL")}
				<Input placeholder={PLACEHOLDER[apiType] ?? "https://…"} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} onBlur={(e) => void guess(e.target.value)} data-testid="custom-base-url" />
			</label>
			<div className="space-y-1">
				{label("API Key")}
				<div className="flex items-center gap-3">
					<Input type="password" autoComplete="off" disabled={noKey} placeholder={initial && !initial.noKey ? "已加密保存，留空则不修改" : "sk-…"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
					<label className="flex shrink-0 items-center gap-1.5 text-xs text-zinc-500">
						<input type="checkbox" checked={noKey} onChange={(e) => setNoKey(e.target.checked)} /> 无需 Key（本地服务）
					</label>
				</div>
			</div>
			<div className="space-y-1.5">
				<div className="flex items-center justify-between">
					{label("自定义请求头（可选）")}
					<Button size="sm" variant="ghost" onClick={() => setHeaders((l) => [...l, { name: "", value: "" }])}>
						<Plus size={14} /> 添加
					</Button>
				</div>
				{headers.map((h, i) => (
					<div key={i} className="flex gap-2">
						<Input placeholder="Header 名称" value={h.name} onChange={(e) => setHeaders((l) => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
						<Input type="password" autoComplete="off" placeholder={h.saved ? "已加密保存，留空不修改" : "值"} value={h.value ?? ""} onChange={(e) => setHeaders((l) => l.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
						<Button size="icon" variant="ghost" onClick={() => setHeaders((l) => l.filter((_, j) => j !== i))} aria-label="删除请求头">
							<X size={15} />
						</Button>
					</div>
				))}
			</div>
			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<span className="flex items-center gap-1">
						{label(`模型（${models.length}）`)}
						<Help>上下文长度决定输入框旁圆环的用量和自动整理的时机。来源：自动识别＝服务的模型列表接口给出；已知模型＝按模型名查 models.dev 等公开数据；默认＝256K / 128K；自动学习＝服务端报错说太大后自动调小并记住。点数值可以改。</Help>
					</span>
					<Button size="sm" variant="outline" disabled={!baseUrl || busy === "fetch"} onClick={fetchModels}>
						{busy === "fetch" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} 自动获取
					</Button>
				</div>
				{models.length > 0 && (
					<div className="min-w-0 divide-y divide-line overflow-hidden rounded-lg border border-line" data-testid="custom-models">
						{models.map((m) => (
							<ModelRow key={m.id} m={m} onChange={(p) => patchModel(m.id, p)} onRemove={() => setModels((l) => l.filter((x) => x.id !== m.id))} />
						))}
					</div>
				)}
				<form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), addModel(newModel), setNewModel(""))}>
					<Input placeholder="手动输入模型 ID，回车添加" value={newModel} onChange={(e) => setNewModel(e.target.value)} />
					<Button type="submit" variant="outline">
						添加
					</Button>
				</form>
				{/* classifier 声明（可选）：保存后由服务端在启动 / reload 时重新注册到通用分类器目录 */}
			<div className="space-y-2" data-testid="custom-classifiers">
				<div className="flex items-center justify-between">
					<span className="flex items-center gap-1">
						{label(`高级：手动指定分类器（一般不用填）${classifiers.length ? `（${classifiers.length}）` : ""}`)}
						<Help>常见的 Jev / 官方同名模型（如 jev-latest）会在保存后**自动识别**为分类器模型，不用在这里声明。只有当服务没有给出协议、你要手动告诉它是原生 System One 分类器时才填：选协议 + 对端模型 ID，鉴权沿用本渠道已保存的 Key，不会把 Key 发给别的地址。</Help>
					</span>
					<Button size="sm" variant="ghost" onClick={() => setClassifiers((l) => [...l, { protocol: classifierProtocols[0] ?? "typesafe-system-one", modelId: "" }])}>
						<Plus size={14} /> 添加
					</Button>
				</div>
				{classifiers.map((c, i) => (
					<div key={i} className="flex gap-2">
						<Select value={c.protocol} ariaLabel="分类器协议" testId={`classifier-protocol-${i}`} options={(classifierProtocols.length ? classifierProtocols : ["typesafe-system-one"]).map((p) => ({ value: p, label: p }))} onChange={(v) => setClassifiers((l) => l.map((x, j) => (j === i ? { ...x, protocol: v } : x)))} />
						<Input placeholder="对端模型 ID，例如 jev-latest" value={c.modelId} onChange={(e) => setClassifiers((l) => l.map((x, j) => (j === i ? { ...x, modelId: e.target.value } : x)))} />
						<Button size="icon" variant="ghost" onClick={() => setClassifiers((l) => l.filter((_, j) => j !== i))} aria-label="删除分类器">
							<X size={15} />
						</Button>
					</div>
				))}
				{(saved?.discoveredClassifiers?.length ?? 0) > 0 && (
					<div className="text-[11px] text-mut2" data-testid="custom-auto-classifiers">
						已自动识别 {saved!.discoveredClassifiers!.length} 个分类器模型：{saved!.discoveredClassifiers!.map((c) => c.modelId).join("、")}（在模型服务目录里查看）
					</div>
				)}
			</div>
			{fetched && (
					<div className="rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
						<div className="mb-1.5 flex items-center justify-between text-xs text-zinc-500">
							获取到 {fetched.length} 个模型，点击添加
							<button className="text-accent" onClick={() => fetched.forEach(addModel)}>
								全部添加
							</button>
						</div>
						<div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
							{fetched.map((f) => (
								<button key={f.id} onClick={() => addModel(f)} title={f.contextWindow ? `${fmtTokens(f.contextWindow)} 上下文 · ${fmtTokens(f.maxTokens)} 输出 · ${SOURCE[f.limitsSource ?? ""] ?? ""}` : undefined} className={cx("rounded-full border px-2.5 py-1 text-xs", models.some((m) => m.id === f.id) ? "border-accent text-accent" : "border-line")}>
									{f.id}
								</button>
							))}
						</div>
					</div>
				)}
			</div>
			{err && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-600 dark:bg-red-950/40">{err}</div>}
			<div className="flex flex-wrap items-center gap-2">
				<Button variant="primary" disabled={busy === "save"} onClick={save}>
					{busy === "save" && <Loader2 size={14} className="animate-spin" />} {saved ? "保存修改" : "保存"}
				</Button>
				{onCancel && (
					<Button variant="ghost" onClick={onCancel}>
						取消
					</Button>
				)}
				{saved && onDeleted && (
					<Button
						variant="ghost"
						className="ml-auto text-red-600"
						disabled={!!busy}
						onClick={async () => {
							setErr("");
							try {
								const current = await api<{ providers: CustomProviderMeta[] }>("/api/models/custom");
								const impact = deleteImpact(current.providers.find((p) => p.id === saved.id)?.references);
								if (!await ask({ title: `删除「${saved.name}」？`, body: <div className="whitespace-pre-wrap">{`删除后不能恢复。${impact}`}</div>, ok: "删除", danger: true })) return;
								setBusy("save");
								await api(`/api/models/custom/${saved.id}`, { method: "DELETE" });
								onDeleted();
							} catch (e) {
								setErr(`删除失败：${e instanceof Error ? e.message : String(e)}`);
							} finally {
								setBusy("");
							}
						}}
					>
						<Trash2 size={14} /> 删除
					</Button>
				)}
			</div>
			{saved && (
				<div className="space-y-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
					<div className="flex items-center gap-2 text-sm">
						<CheckCircle2 size={16} className="text-emerald-500" /> 已保存：{saved.name} <Badge>{saved.id}</Badge>
					</div>
					<div className="flex gap-2">
						{/* 模型列表可能很长（自建渠道可上千个），用应用内 Select（原生 select 无法搜索 / 超 20 行体验差）；小枚举 API 类型仍用原生 select */}
						<Select value={testModel} ariaLabel="测试模型" testId="custom-test-model" className="min-w-0 flex-1" options={saved.models.map((m) => ({ value: m.id, label: m.id }))} onChange={(v) => (setTestModel(v), setTest(null))} />
						<Button variant="outline" disabled={busy === "test" || !testModel} onClick={runTest}>
							{busy === "test" && <Loader2 size={14} className="animate-spin" />} 测试连接
						</Button>
					</div>
					{test && (
						<div className={cx("flex items-start gap-2 rounded-lg p-2 text-sm", test.ok ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40" : "bg-red-50 text-red-700 dark:bg-red-950/40")}>
							{test.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <XCircle size={16} className="mt-0.5 shrink-0" />}
							<span className="break-all">{test.ok ? `连接成功：${test.message}` : test.message}{!test.ok && (test.detail ? <Help className="ml-1">服务返回的原文：{test.detail}</Help> : null)}</span>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
