/**
 * 自定义模型服务表单：中转站 / 第三方 / 本地推理服务（OpenAI 兼容、Anthropic 兼容……）。
 * API 类型列表来自服务端（pi-ai 的 API 注册表），保存后写入 Pi 的 models.json。
 */
import { CheckCircle2, Download, Loader2, Plus, Trash2, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { CustomModel, CustomProviderMeta } from "../types";
import { Badge, Button, cx, Input, Help } from "./ui";

const PLACEHOLDER: Record<string, string> = {
	"openai-completions": "https://api.example.com/v1",
	"openai-responses": "https://api.example.com/v1",
	"anthropic-messages": "https://api.example.com/anthropic",
	"google-generative-ai": "https://generativelanguage.googleapis.com/v1beta",
};

export function useCustomProviders() {
	const [data, setData] = useState<{ providers: CustomProviderMeta[]; apis: { id: string; label: string }[] }>({ providers: [], apis: [] });
	const reload = () => api("/api/models/custom").then(setData);
	useEffect(() => {
		void reload();
	}, []);
	return { ...data, reload };
}

const SOURCE: Record<string, string> = { detected: "自动识别", known: "已知模型", default: "自动（默认）", user: "手动" };

export function CustomProviderForm({ initial, apis, onSaved, onCancel, onDeleted }: { initial?: CustomProviderMeta; apis: { id: string; label: string }[]; onSaved: (m: CustomProviderMeta) => void; onCancel?: () => void; onDeleted?: () => void }) {
	const [name, setName] = useState(initial?.name ?? "");
	const [apiType, setApiType] = useState(initial?.api ?? apis[0]?.id ?? "openai-completions");
	const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
	const [apiKey, setApiKey] = useState("");
	const [noKey, setNoKey] = useState(initial?.noKey ?? false);
	const [headers, setHeaders] = useState<{ name: string; value?: string; saved?: boolean }[]>(initial?.headerNames.map((n) => ({ name: n, saved: true })) ?? []);
	const [models, setModels] = useState<CustomModel[]>(initial?.models ?? []);
	const [newModel, setNewModel] = useState("");
	const [fetched, setFetched] = useState<CustomModel[] | null>(null);
	const [busy, setBusy] = useState<"" | "fetch" | "save" | "test">("");
	const [err, setErr] = useState("");
	const [saved, setSaved] = useState<CustomProviderMeta | null>(initial ?? null);
	const [testModel, setTestModel] = useState(initial?.models[0]?.id ?? "");
	const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
	useEffect(() => {
		if (!apiType && apis[0]) setApiType(apis[0].id);
	}, [apis]);

	const hdrPayload = () => headers.filter((h) => h.name.trim()).map((h) => ({ name: h.name.trim(), value: h.saved && !h.value ? undefined : (h.value ?? "") }));
	const addModel = (m: string | CustomModel) => {
		const x = typeof m === "string" ? { id: m.trim() } : { ...m, id: m.id.trim() };
		if (x.id && !models.some((y) => y.id === x.id)) setModels((l) => [...l, x]);
	};
	const setLimit = (id: string, k: "contextWindow" | "maxTokens", kTokens: string) => {
		const v = Math.round(Number(kTokens) * 1000);
		setModels((l) => l.map((m) => (m.id === id ? { ...m, [k]: v > 0 ? v : undefined, limitsSource: "user" } : m)));
	};
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
			const body = { name, api: apiType, baseUrl, apiKey: noKey ? undefined : apiKey || undefined, noKey, headers: hdrPayload(), models };
			const editId = saved?.id ?? initial?.id;
			const m: CustomProviderMeta = await api(editId ? `/api/models/custom/${editId}` : "/api/models/custom", { method: editId ? "PUT" : "POST", json: body });
			setSaved(m);
			setModels(m.models);
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
			<div className="grid gap-3 sm:grid-cols-2">
				<label className="block space-y-1">
					{label("名称")}
					<Input placeholder="例如：我的中转站" value={name} onChange={(e) => setName(e.target.value)} />
				</label>
				<label className="block space-y-1">
					{label("API 类型")}
					<select value={apiType} onChange={(e) => setApiType(e.target.value)} className="h-9 w-full rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" aria-label="API 类型">
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
				<Input placeholder={PLACEHOLDER[apiType] ?? "https://…"} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
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
					{label(`模型（${models.length}）`)}
					<Button size="sm" variant="outline" disabled={!baseUrl || busy === "fetch"} onClick={fetchModels}>
						{busy === "fetch" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} 自动获取
					</Button>
				</div>
				{models.length > 0 && (
					<div className="divide-y divide-line rounded-lg border border-line" data-testid="custom-models">
						<div className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-mut">
							<span className="min-w-0 flex-1">模型</span>
							<span className="w-20 text-right">上下文（K）</span>
							<span className="w-20 text-right">最大输出（K）</span>
							<span className="w-16" />
							<Help>上下文长度决定输入框旁圆环的用量和自动整理上下文的时机。来源：自动识别（服务的模型列表接口给出）/ 已知模型（按模型名匹配）/ 默认（128K / 8K，保守值）。不对可以直接改。</Help>
						</div>
						{models.map((m) => (
							<div key={m.id} className="flex items-center gap-2 px-2.5 py-1.5 text-xs" data-testid="custom-model-row" data-model={m.id}>
								<span className="min-w-0 flex-1 truncate font-mono" title={m.id}>{m.id}</span>
								<input className="pa-input h-7 w-20 px-1.5 text-right text-xs" inputMode="numeric" aria-label={`${m.id} 上下文（K）`} placeholder="自动" value={m.contextWindow ? String(Math.round(m.contextWindow / 100) / 10) : ""} onChange={(e) => setLimit(m.id, "contextWindow", e.target.value)} />
								<input className="pa-input h-7 w-20 px-1.5 text-right text-xs" inputMode="numeric" aria-label={`${m.id} 最大输出（K）`} placeholder="自动" value={m.maxTokens ? String(Math.round(m.maxTokens / 100) / 10) : ""} onChange={(e) => setLimit(m.id, "maxTokens", e.target.value)} />
								<span className="w-16 shrink-0 text-right text-[11px] text-mut" data-testid="limits-source">{SOURCE[m.limitsSource ?? ""] ?? "保存时自动"}</span>
								<button className="shrink-0 text-mut hover:text-fg" onClick={() => setModels((l) => l.filter((x) => x.id !== m.id))} aria-label={`移除 ${m.id}`}>
									<X size={12} />
								</button>
							</div>
						))}
					</div>
				)}
				<form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), addModel(newModel), setNewModel(""))}>
					<Input placeholder="手动输入模型 ID，回车添加" value={newModel} onChange={(e) => setNewModel(e.target.value)} />
					<Button type="submit" variant="outline">
						添加
					</Button>
				</form>
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
								<button key={f.id} onClick={() => addModel(f)} title={f.contextWindow ? `上下文 ${Math.round(f.contextWindow / 1000)}K · ${SOURCE[f.limitsSource ?? ""] ?? ""}` : undefined} className={cx("rounded-full border px-2.5 py-1 text-xs", models.some((m) => m.id === f.id) ? "border-accent text-accent" : "border-line")}>
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
						onClick={async () => {
							if (!confirm(`删除「${saved.name}」？`)) return;
							await api(`/api/models/custom/${saved.id}`, { method: "DELETE" });
							onDeleted();
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
						<select value={testModel} onChange={(e) => (setTestModel(e.target.value), setTest(null))} className="h-9 min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" aria-label="测试模型">
							{saved.models.map((m) => (
								<option key={m.id}>{m.id}</option>
							))}
						</select>
						<Button variant="outline" disabled={busy === "test" || !testModel} onClick={runTest}>
							{busy === "test" && <Loader2 size={14} className="animate-spin" />} 测试连接
						</Button>
					</div>
					{test && (
						<div className={cx("flex items-start gap-2 rounded-lg p-2 text-sm", test.ok ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40" : "bg-red-50 text-red-700 dark:bg-red-950/40")}>
							{test.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <XCircle size={16} className="mt-0.5 shrink-0" />}
							<span className="break-all">{test.ok ? `连接成功：${test.message}` : test.message}</span>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
