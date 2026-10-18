/**
 * 自定义 / 中转服务详情（单列）：连接（摘要 ↔ 原地编辑，显式保存）→ 模型（搜索 / 筛选 / 获取 / 手动添加 / 测试全部，
 * 每个模型展开一次保存「能做什么 / 上下文 / 最大输出 / 接口格式」）→ 高级（生图 / 语音 / 分类器 / 请求头 / 各协议地址，默认收起）→ 删除。
 * 只做呈现：保存仍走 `PUT /api/models/custom/:id`、能力走 registry capabilities、测试走 `/api/models/test`、删除复用面板的删除确认。
 */
import { Activity, Check, ChevronDown, Download, Loader2, Pencil, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { api } from "../api";
import type { CustomModel, CustomProviderMeta, ModelCapability, RegistryModel, RegistryProvider } from "../types";
import { CTX_PRESETS, fmtTokens, LimitField, OUT_PRESETS, SOURCE } from "./CustomProvider";
import { Badge, Button, cx, Help, Input, Select } from "./ui";

const CAPS: ModelCapability[] = ["chat", "vision", "image", "classifier"];
const CAP_LABEL: Record<ModelCapability, string> = { chat: "对话", vision: "识图", image: "生图", classifier: "分类器" };
const CAP_HINT: Record<ModelCapability, string> = { chat: "能聊天、用工具", vision: "能看懂图片", image: "能画图", classifier: "快速判断用，一般不用管" };
const CAP_TONE: Record<ModelCapability, "accent" | "green" | "amber" | "zinc"> = { chat: "accent", vision: "green", image: "amber", classifier: "zinc" };
const API_SHORT: Record<string, string> = { "openai-completions": "OpenAI 兼容", "anthropic-messages": "Anthropic", "google-generative-ai": "Gemini", auto: "自动（按模型识别）" };
const RELAY_APIS = ["openai-completions", "anthropic-messages", "google-generative-ai"];
type TestState = { s: "running" } | { s: "ok"; ms: number } | { s: "fail"; msg: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const body = (meta: CustomProviderMeta, patch: Partial<{ name: string; api: string; baseUrl: string; apiKey: string; noKey: boolean; models: CustomModel[]; headers: { name: string; value?: string }[]; classifiers: { protocol: string; modelId: string }[]; protocolUrls: Record<string, string> }> = {}) => ({
	name: meta.name,
	api: meta.api,
	baseUrl: meta.baseUrl,
	noKey: meta.noKey,
	headers: meta.headerNames.map((name) => ({ name })),
	models: meta.models.map(({ apiEffective: _a, baseUrlEffective: _b, ...m }) => m),
	classifiers: meta.classifiers?.map((c) => ({ protocol: c.protocol, modelId: c.modelId })) ?? [],
	...(meta.protocolUrls ? { protocolUrls: meta.protocolUrls } : {}),
	...patch,
});

/** 详情页的一个小节标题：名字 + 一句话 + 右侧操作 */
function Head({ title, hint, help, children }: { title: string; hint?: ReactNode; help?: ReactNode; children?: ReactNode }) {
	return (
		<div className="flex flex-wrap items-center gap-2">
			<span className="text-sm font-semibold">{title}</span>
			{hint && <span className="text-xs text-mut">{hint}</span>}
			{help && <Help>{help}</Help>}
			<span className="ml-auto flex flex-wrap items-center gap-1.5">{children}</span>
		</div>
	);
}

export function RelayDetail({ provider, meta, apis, classifierProtocols, strengthsSlot, imageSection, asrSection, onSaveCaps, onReload, onDelete }: {
	provider: RegistryProvider;
	meta: CustomProviderMeta;
	apis: { id: string; label: string }[];
	classifierProtocols: string[];
	strengthsSlot: (m: RegistryModel) => ReactNode;
	imageSection: ReactNode;
	asrSection: ReactNode;
	onSaveCaps: (modelId: string, caps: ModelCapability[]) => void;
	onReload: () => void;
	onDelete: () => Promise<void>;
}) {
	const [err, setErr] = useState("");
	const [tests, setTests] = useState<Record<string, TestState>>({});
	const [testAll, setTestAll] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const reg = useMemo(() => new Map(provider.models.map((m) => [m.id, m])), [provider.models]);
	const auto = meta.api === "auto";
	const put = async (patch: Parameters<typeof body>[1]) => {
		setErr("");
		try {
			await api(`/api/models/custom/${meta.id}`, { method: "PUT", json: body(meta, patch) });
			onReload();
			return true;
		} catch (e) {
			setErr(errText(e));
			return false;
		}
	};
	const isChat = (id: string) => (reg.get(id)?.type ?? "chat") === "chat";
	const runTest = async (id: string) => {
		setTests((t) => ({ ...t, [id]: { s: "running" } }));
		const t0 = performance.now();
		try {
			const r = await api<{ ok: boolean; message: string }>("/api/models/test", { method: "POST", json: { provider: meta.id, model: id } });
			setTests((t) => ({ ...t, [id]: r.ok ? { s: "ok", ms: Math.round(performance.now() - t0) } : { s: "fail", msg: r.message } }));
			return r;
		} catch (e) {
			setTests((t) => ({ ...t, [id]: { s: "fail", msg: errText(e) } }));
			return { ok: false, message: errText(e) };
		}
	};
	// 测试全部：每个对话模型用它自己的协议各测一次（服务端按模型的 api 发请求），3 个并发
	const runAll = async () => {
		setTestAll(true);
		const queue = meta.models.filter((m) => isChat(m.id)).map((m) => m.id);
		await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
			for (let id = queue.shift(); id; id = queue.shift()) await runTest(id);
		}));
		setTestAll(false);
	};
	const done = Object.values(tests).filter((t) => t.s !== "running");
	const okN = done.filter((t) => t.s === "ok").length;
	const capsOf = (id: string) => reg.get(id)?.capabilities ?? ["chat"];
	const counts = CAPS.map((c) => [c, meta.models.filter((m) => capsOf(m.id).includes(c)).length] as const).filter(([, n]) => n > 0);
	const lastOk = Object.values(tests).some((t) => t.s === "ok");
	return (
		<div className="space-y-5" data-testid={`relay-detail-${meta.id}`}>
			<div className="flex flex-wrap items-center gap-2 text-xs text-mut" data-testid="relay-status">
				<span className={cx("size-2 rounded-full", meta.configured ? "bg-emerald-500" : "bg-zinc-400")} />
				{meta.configured ? (lastOk ? "已连接" : "已保存凭据") : "未配置 Key"}
				<span>·</span>
				{meta.models.length} 个模型{counts.length ? ` · ${counts.map(([c, n]) => `${CAP_LABEL[c]} ${n}`).join(" · ")}` : ""}
			</div>
			<Connection meta={meta} apis={apis} onSave={put} onTest={() => runTest(meta.models.find((m) => isChat(m.id))?.id ?? meta.models[0]?.id ?? "")} test={tests[meta.models.find((m) => isChat(m.id))?.id ?? ""]} />
			<Models meta={meta} reg={reg} auto={auto} tests={tests} testAll={testAll} summary={done.length ? `测试完成 · ${okN} 通过 ${done.length - okN} 失败` : ""} onTestAll={runAll} onTest={runTest} onSave={put} onSaveCaps={onSaveCaps} strengthsSlot={strengthsSlot} />
			<Advanced meta={meta} auto={auto} classifierProtocols={classifierProtocols} onSave={put} imageSection={imageSection} asrSection={asrSection} />
			{err && <div className="rounded-lg bg-red-50 p-2 text-xs text-red-600 dark:bg-red-950/40" data-testid="relay-error">{err}</div>}
			<div className="flex items-center gap-3 border-t border-line pt-4">
				<div className="min-w-0 flex-1">
					<div className="text-sm">删除这个服务</div>
					<div className="text-xs text-mut">删除前会列出受影响的默认模型和助理</div>
				</div>
				<Button size="sm" variant="outline" className="text-red-600" disabled={deleting} onClick={async () => { setDeleting(true); setErr(""); try { await onDelete(); } catch (e) { setErr(`删除失败：${errText(e)}`); } finally { setDeleting(false); } }} data-testid={`service-delete-${meta.id}`}>
					{deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} 删除
				</Button>
			</div>
		</div>
	);
}

/** 连接：平时一行摘要；点编辑在原地改名称 / 地址 / 接口格式 / Key，显式保存。请求头在高级里。 */
function Connection({ meta, apis, onSave, onTest, test }: { meta: CustomProviderMeta; apis: { id: string; label: string }[]; onSave: (p: Parameters<typeof body>[1]) => Promise<boolean>; onTest: () => void; test?: TestState }) {
	const [edit, setEdit] = useState(false);
	const [f, setF] = useState({ name: meta.name, baseUrl: meta.baseUrl, api: meta.api, apiKey: "", noKey: meta.noKey });
	const [busy, setBusy] = useState(false);
	const start = () => (setF({ name: meta.name, baseUrl: meta.baseUrl, api: meta.api, apiKey: "", noKey: meta.noKey }), setEdit(true));
	const save = async () => {
		setBusy(true);
		const ok = await onSave({ name: f.name, baseUrl: f.baseUrl, api: f.api, noKey: f.noKey, ...(f.apiKey && !f.noKey ? { apiKey: f.apiKey } : {}) });
		setBusy(false);
		if (ok) setEdit(false);
	};
	const cell = (k: string, v: ReactNode) => (
		<div className="min-w-0">
			<div className="text-[11px] text-mut">{k}</div>
			<div className="truncate font-mono text-xs" title={typeof v === "string" ? v : undefined}>{v}</div>
		</div>
	);
	return (
		<section className="space-y-2" data-testid="relay-connection">
			<Head title="连接" hint="助理通过这个地址和 Key 调用模型">
				{!edit && (
					<Button size="sm" variant="ghost" onClick={start} data-testid={`service-edit-${meta.id}`}>
						<Pencil size={13} /> 编辑
					</Button>
				)}
				<Button size="sm" variant="outline" disabled={test?.s === "running" || !meta.models.length} onClick={onTest} data-testid={`service-test-run-${meta.id}`}>
					{test?.s === "running" ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />} 测试连接
				</Button>
			</Head>
			{edit ? (
				<div className="space-y-3 rounded-xl border border-accent/40 p-3" data-testid="relay-connection-edit">
					<label className="block space-y-1">
						<span className="text-xs text-mut">名称</span>
						<Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="服务名称" />
					</label>
					<label className="block space-y-1">
						<span className="text-xs text-mut">地址</span>
						<Input value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} aria-label="服务地址" placeholder="https://api.example.com/v1" />
					</label>
					<label className="block space-y-1">
						<span className="flex items-center gap-1 text-xs text-mut">接口格式 <Help>大多数中转选「OpenAI 兼容」。一个地址同时提供 OpenAI / Anthropic / Gemini 三种协议时选「自动」：claude-* 走 Anthropic，gemini-* 走 Gemini，其他走 OpenAI；每个模型可以单独改。</Help></span>
						<Select value={f.api} ariaLabel="接口格式" testId="relay-api" options={apis.map((a) => ({ value: a.id, label: a.label }))} onChange={(v) => setF({ ...f, api: v })} />
					</label>
					<div className="space-y-1">
						<span className="text-xs text-mut">API Key</span>
						<div className="flex items-center gap-3">
							<Input type="password" autoComplete="off" disabled={f.noKey} value={f.apiKey} placeholder={meta.noKey ? "sk-…" : "已加密保存，留空不修改"} onChange={(e) => setF({ ...f, apiKey: e.target.value })} aria-label="API Key" />
							<label className="flex shrink-0 items-center gap-1.5 text-xs text-mut">
								<input type="checkbox" checked={f.noKey} onChange={(e) => setF({ ...f, noKey: e.target.checked })} /> 无需 Key
							</label>
						</div>
					</div>
					<div className="flex gap-2">
						<Button size="sm" variant="primary" disabled={busy} onClick={() => void save()} data-testid="relay-connection-save">
							{busy && <Loader2 size={13} className="animate-spin" />} 保存
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setEdit(false)}>取消</Button>
					</div>
				</div>
			) : (
				<div className="grid grid-cols-2 gap-3 rounded-xl border border-line p-3 sm:grid-cols-[2fr_1fr_1fr]" data-testid="relay-connection-summary">
					{cell("地址", meta.baseUrl)}
					{cell("接口格式", API_SHORT[meta.api] ?? meta.api)}
					{cell("API Key", meta.noKey ? "无需" : meta.configured ? "已保存" : "未填")}
				</div>
			)}
			{test && test.s !== "running" && (
				<div className={cx("rounded-lg p-2 text-[11px]", test.s === "ok" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" : "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300")} data-testid={`service-test-result-${meta.id}`} data-ok={String(test.s === "ok")}>
					{test.s === "ok" ? `连接成功 · ${test.ms}ms` : test.msg}
				</div>
			)}
		</section>
	);
}

function TestBadge({ t, chat }: { t?: TestState; chat: boolean }) {
	if (!chat) return <span className="text-[11px] text-mut2">不参与</span>;
	if (!t) return null;
	if (t.s === "running") return <Loader2 size={12} className="animate-spin text-mut" />;
	if (t.s === "ok") return <span className="flex items-center gap-0.5 text-[11px] text-emerald-600" data-testid="model-test-ok"><Check size={12} />{t.ms}ms</span>;
	return <span className="flex items-center gap-0.5 text-[11px] text-red-600" title={t.msg} data-testid="model-test-fail"><X size={12} />失败</span>;
}

function Models({ meta, reg, auto, tests, testAll, summary, onTestAll, onTest, onSave, onSaveCaps, strengthsSlot }: {
	meta: CustomProviderMeta;
	reg: Map<string, RegistryModel>;
	auto: boolean;
	tests: Record<string, TestState>;
	testAll: boolean;
	summary: string;
	onTestAll: () => void;
	onTest: (id: string) => void;
	onSave: (p: Parameters<typeof body>[1]) => Promise<boolean>;
	onSaveCaps: (modelId: string, caps: ModelCapability[]) => void;
	strengthsSlot: (m: RegistryModel) => ReactNode;
}) {
	const [q, setQ] = useState("");
	const [cap, setCap] = useState<ModelCapability | "all">("all");
	const [open, setOpen] = useState<string | null>(null);
	const [fetched, setFetched] = useState<CustomModel[] | null>(null);
	const [adding, setAdding] = useState(false);
	const [newId, setNewId] = useState("");
	const [busy, setBusy] = useState("");
	const capsOf = (id: string) => reg.get(id)?.capabilities ?? ["chat"];
	const list = meta.models.filter((m) => (!q || m.id.toLowerCase().includes(q.toLowerCase())) && (cap === "all" || capsOf(m.id).includes(cap)));
	const fetchList = async () => {
		setBusy("fetch");
		try {
			setFetched((await api<{ models: CustomModel[] }>("/api/models/custom/fetch-models", { method: "POST", json: { id: meta.id, api: meta.api, baseUrl: meta.baseUrl, headers: meta.headerNames.map((name) => ({ name })) } })).models);
		} catch (e) {
			setFetched([]);
			alertErr(e);
		} finally {
			setBusy("");
		}
	};
	const [fetchErr, setFetchErr] = useState("");
	const alertErr = (e: unknown) => setFetchErr(`获取失败：${errText(e)}`);
	const addModels = async (ms: CustomModel[]) => {
		const fresh = ms.filter((m) => !meta.models.some((x) => x.id === m.id));
		if (!fresh.length) return;
		setBusy("add");
		await onSave({ models: [...body(meta).models, ...fresh] });
		setBusy("");
	};
	const chips: [ModelCapability | "all", string, number][] = [["all", "全部", meta.models.length], ...CAPS.map((c) => [c, CAP_LABEL[c], meta.models.filter((m) => capsOf(m.id).includes(c)).length] as [ModelCapability, string, number]).filter(([, , n]) => n > 0)];
	return (
		<section className="space-y-2" data-testid="relay-models">
			<Head title={`模型 ${meta.models.length}`} help="能力来自 Pi 目录 / 你的设置 / 服务端模型列表；靠名字猜的标「?」。上下文长度决定输入框旁圆环的用量和自动整理的时机。">
				<Button size="sm" variant="outline" disabled={testAll || !meta.models.length} onClick={onTestAll} data-testid="relay-test-all">
					{testAll ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />} 测试全部模型
				</Button>
				<Button size="sm" variant="outline" disabled={busy === "fetch"} onClick={() => void fetchList()} data-testid="relay-fetch">
					{busy === "fetch" ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} 获取模型列表
				</Button>
				<Button size="sm" variant="ghost" onClick={() => setAdding((v) => !v)} data-testid="relay-add-open">
					<Plus size={13} /> 手动添加
				</Button>
			</Head>
			<div className="flex flex-wrap items-center gap-2">
				<div className="relative min-w-36 flex-1">
					<Search size={14} className="absolute top-2.5 left-2.5 text-zinc-400" />
					<Input className="!pl-8" placeholder="搜索模型" value={q} onChange={(e) => setQ(e.target.value)} data-testid="relay-model-search" />
				</div>
				<div className="flex gap-1 rounded-lg bg-hover p-0.5 text-xs">
					{chips.map(([k, l, n]) => (
						<button key={k} className={cx("rounded-md px-2 py-1", cap === k ? "bg-card font-medium shadow-sm" : "text-mut")} onClick={() => setCap(k)} data-testid={`relay-filter-${k}`}>
							{l} {n}
						</button>
					))}
				</div>
				{summary && <span className="text-[11px] text-mut" data-testid="relay-test-summary">{summary}</span>}
			</div>
			{adding && (
				<form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), newId.trim() && void addModels([{ id: newId.trim() }]).then(() => setNewId("")))}>
					<Input placeholder="模型 ID，回车添加" value={newId} onChange={(e) => setNewId(e.target.value)} data-testid="relay-add-input" />
					<Button type="submit" size="sm" variant="outline" disabled={busy === "add"}>添加</Button>
				</form>
			)}
			{fetchErr && <div className="text-xs text-red-600">{fetchErr}</div>}
			{fetched && fetched.length > 0 && (
				<div className="rounded-lg border border-line p-2" data-testid="relay-fetched">
					<div className="mb-1.5 flex items-center justify-between text-xs text-mut">
						获取到 {fetched.length} 个模型，点击添加
						<span className="flex gap-3">
							<button className="text-accent" onClick={() => void addModels(fetched)}>全部添加</button>
							<button onClick={() => setFetched(null)}>收起</button>
						</span>
					</div>
					<div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
						{fetched.map((f) => {
							const has = meta.models.some((m) => m.id === f.id);
							return (
								<button key={f.id} disabled={has} onClick={() => void addModels([f])} className={cx("rounded-full border px-2.5 py-1 text-xs", has ? "border-accent text-accent" : "border-line")}>
									{f.id}
								</button>
							);
						})}
					</div>
				</div>
			)}
			<div className="max-h-[28rem] divide-y divide-line overflow-y-auto rounded-xl border border-line" data-testid={`service-models-${meta.id}`}>
				{!list.length && <div className="p-3 text-xs text-mut">{meta.models.length ? "没有匹配的模型" : "还没有模型：点「获取模型列表」或「手动添加」"}</div>}
				{list.map((m) => (
					<ModelLine key={m.id} m={m} meta={meta} r={reg.get(m.id)} auto={auto} t={tests[m.id]} open={open === m.id} onToggle={() => setOpen(open === m.id ? null : m.id)} onTest={() => onTest(m.id)} onSave={onSave} onSaveCaps={onSaveCaps} strengthsSlot={strengthsSlot} />
				))}
			</div>
		</section>
	);
}

/** 一行一个模型；展开后一次保存：能做什么 / 上下文 / 最大输出 /（自动模式）接口格式；更多里是擅长标签；自动识别的只读 */
function ModelLine({ m, meta, r, auto, t, open, onToggle, onTest, onSave, onSaveCaps, strengthsSlot }: {
	m: CustomModel;
	meta: CustomProviderMeta;
	r?: RegistryModel;
	auto: boolean;
	t?: TestState;
	open: boolean;
	onToggle: () => void;
	onTest: () => void;
	onSave: (p: Parameters<typeof body>[1]) => Promise<boolean>;
	onSaveCaps: (modelId: string, caps: ModelCapability[]) => void;
	strengthsSlot: (m: RegistryModel) => ReactNode;
}) {
	const caps = r?.capabilities ?? ["chat"];
	const chat = (r?.type ?? "chat") === "chat";
	const [d, setD] = useState({ caps, ctx: m.contextWindow, out: m.maxTokens, src: m.limitsSource, api: m.api ?? "" });
	const [more, setMore] = useState(false);
	const [busy, setBusy] = useState(false);
	const reset = () => setD({ caps, ctx: m.contextWindow, out: m.maxTokens, src: m.limitsSource, api: m.api ?? "" });
	const save = async () => {
		setBusy(true);
		const capsChanged = String(d.caps) !== String(caps);
		// 一次保存：能力也写进同一个 PUT，避免旧能力把刚改的覆盖回去
		const models = body(meta).models.map((x) => (x.id !== m.id ? x : { ...x, contextWindow: d.ctx, maxTokens: d.out, limitsSource: d.src, ...(capsChanged ? { capabilities: d.caps } : {}), ...(auto ? { api: d.api || undefined } : {}) }));
		const ok = await onSave({ models });
		if (ok && capsChanged) onSaveCaps(m.id, d.caps);
		setBusy(false);
		if (ok) onToggle();
	};
	const remove = () => void onSave({ models: body(meta).models.filter((x) => x.id !== m.id) });
	const proto = m.apiEffective ?? meta.api;
	return (
		<div className={cx(open && "bg-hover/40")} data-testid="service-model" data-model={m.id} data-type={r?.type ?? "chat"}>
			<button className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left" onClick={() => (reset(), onToggle())} aria-expanded={open} data-testid="relay-model-toggle">
				<span className="w-40 min-w-0 shrink truncate font-mono text-xs" title={m.id}>{m.id}</span>
				<span className="flex shrink-0 gap-1" data-testid="model-caps">
					{caps.map((c) => <Badge key={c} tone={CAP_TONE[c]}>{CAP_LABEL[c]}{r?.inferred?.includes(c) ? "?" : ""}</Badge>)}
				</span>
				{auto && (
					<span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-[10px] text-mut" data-testid="model-protocol" title={m.baseUrlEffective}>
						{API_SHORT[proto] ?? proto}{m.api ? "" : " · 自动识别"}
					</span>
				)}
				<span className="min-w-0 flex-1 truncate text-[11px] text-mut">{chat ? (m.contextWindow ? `${fmtTokens(m.contextWindow)} 上下文 · ${fmtTokens(m.maxTokens)} 输出` : "上下文：保存时自动识别") : "不适用"}</span>
				<TestBadge t={t} chat={chat} />
				<ChevronDown size={14} className={cx("shrink-0 text-mut transition-transform", !open && "-rotate-90")} />
			</button>
			{open && (
				<div className="mx-3 mb-3 space-y-4 rounded-xl border border-line bg-card p-3" data-testid="relay-model-editor">
					<div className="space-y-1.5">
						<div className="text-xs font-medium">能做什么</div>
						<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
							{CAPS.map((c) => (
								<label key={c} className={cx("flex cursor-pointer items-start gap-2 rounded-lg border p-2 text-xs", d.caps.includes(c) ? "border-accent bg-accent-soft" : "border-line")}>
									<input type="checkbox" className="mt-0.5" checked={d.caps.includes(c)} onChange={(e) => setD({ ...d, caps: e.target.checked ? [...d.caps, c] : d.caps.filter((x) => x !== c) })} data-testid={`relay-cap-${c}`} />
									<span><span className="block font-medium">{CAP_LABEL[c]}</span><span className="text-mut">{CAP_HINT[c]}</span></span>
								</label>
							))}
						</div>
						<div className="text-[11px] text-mut2">按已知模型自动勾选；不确定可以不改</div>
					</div>
					{chat && (
						<div className="grid gap-3 sm:grid-cols-2">
							<LimitField label={`上下文长度 · ${SOURCE[d.src ?? ""] ?? "自动"}`} testid="ctx-input" value={d.ctx} presets={CTX_PRESETS} onChange={(v) => setD({ ...d, ctx: v, src: "user" })} />
							<LimitField label="最大输出" testid="out-input" value={d.out} presets={OUT_PRESETS} onChange={(v) => setD({ ...d, out: v, src: "user" })} />
						</div>
					)}
					{chat && d.src === "user" && (
						<button className="flex items-center gap-1 text-[11px] text-mut hover:text-fg" onClick={() => setD({ ...d, ctx: undefined, out: undefined, src: undefined })}>
							<RotateCcw size={11} /> 恢复自动
						</button>
					)}
					{auto && (
						<label className="block space-y-1">
							<span className="flex items-center gap-1 text-xs font-medium">接口格式 <Help>{`按模型名自动识别为「${API_SHORT[m.apiEffective ?? ""] ?? m.apiEffective}」。这个中转对某个模型用的协议不一样时在这里改，地址会按协议自动换。`}</Help></span>
							<Select value={d.api} ariaLabel="模型接口格式" testId="relay-model-api" options={[{ value: "", label: "自动识别" }, ...RELAY_APIS.map((a) => ({ value: a, label: API_SHORT[a] }))]} onChange={(v) => setD({ ...d, api: v })} />
						</label>
					)}
					<div className="rounded-lg bg-hover">
						<button className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs" onClick={() => setMore((v) => !v)} aria-expanded={more}>
							<span className="font-medium">更多</span><span className="text-mut">擅长标签 · 自动识别的信息</span>
							<ChevronDown size={13} className={cx("ml-auto text-mut", !more && "-rotate-90")} />
						</button>
						{more && (
							<div className="space-y-3 px-3 pb-3 text-xs">
								{r && strengthsSlot(r)}
								<div className="grid grid-cols-3 gap-2 text-[11px]" data-testid="relay-model-auto">
									<div><div className="text-mut">思考支持</div>{m.reasoning ? "支持" : "不支持"}</div>
									<div><div className="text-mut">能看图</div>{m.input?.includes("image") ? "能" : "不能"}</div>
									<div><div className="text-mut">请求地址</div><span className="break-all font-mono">{m.baseUrlEffective ?? meta.baseUrl}</span></div>
								</div>
							</div>
						)}
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Button size="sm" variant="primary" disabled={busy} onClick={() => void save()} data-testid="relay-model-save">
							{busy && <Loader2 size={13} className="animate-spin" />} 保存
						</Button>
						<Button size="sm" variant="ghost" onClick={onToggle}>取消</Button>
						{chat && (
							<Button size="sm" variant="ghost" className="ml-auto" onClick={onTest} data-testid="relay-model-test">
								<Activity size={13} /> 测试这个模型
							</Button>
						)}
						<Button size="sm" variant="ghost" className={cx("text-red-600", !chat && "ml-auto")} onClick={remove} data-testid="relay-model-remove">
							移除
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

/** 高级：生图 / 语音 / 分类器 / 请求头 /（自动模式）各协议地址；默认收起 */
function Advanced({ meta, auto, classifierProtocols, onSave, imageSection, asrSection }: { meta: CustomProviderMeta; auto: boolean; classifierProtocols: string[]; onSave: (p: Parameters<typeof body>[1]) => Promise<boolean>; imageSection: ReactNode; asrSection: ReactNode }) {
	const init = () => ({
		headers: meta.headerNames.map((name) => ({ name, value: "", saved: true })),
		classifiers: meta.classifiers?.map((c) => ({ protocol: c.protocol, modelId: c.modelId })) ?? [],
		urls: Object.fromEntries(RELAY_APIS.map((a) => [a, meta.protocolUrls?.[a] ?? ""])) as Record<string, string>,
	});
	const [s, setS] = useState(init);
	const [busy, setBusy] = useState(false);
	const dirty = JSON.stringify(s) !== JSON.stringify(init());
	const save = async () => {
		setBusy(true);
		const ok = await onSave({
			headers: s.headers.filter((h) => h.name.trim()).map((h) => ({ name: h.name.trim(), value: h.saved && !h.value ? undefined : h.value })),
			classifiers: s.classifiers.filter((c) => c.modelId.trim()).map((c) => ({ protocol: c.protocol, modelId: c.modelId.trim() })),
			...(auto ? { protocolUrls: Object.fromEntries(Object.entries(s.urls).filter(([, v]) => v.trim())) } : {}),
		});
		setBusy(false);
		if (ok) setS(init());
	};
	const row = (title: string, hint: string, help: ReactNode, action: ReactNode, content: ReactNode, testid: string) => (
		<div className="space-y-1.5 border-t border-line px-3 py-3 first:border-t-0" data-testid={testid}>
			<div className="flex items-center gap-1.5"><span className="text-sm font-medium">{title}</span>{help && <Help>{help}</Help>}<span className="ml-auto">{action}</span></div>
			<div className="text-[11px] text-mut">{hint}</div>
			{content}
		</div>
	);
	const protos = classifierProtocols.length ? classifierProtocols : ["typesafe-system-one"];
	return (
		<details className="rounded-xl border border-line" data-testid="relay-advanced">
			<summary className="cursor-pointer px-3 py-2.5 text-sm font-semibold">
				高级 <span className="ml-1 text-xs font-normal text-mut">生图、语音识别、分类器、请求头{auto ? "、各协议地址" : ""}；一般不用改</span>
			</summary>
			<div className="border-t border-line">
				<div className="border-b border-line px-3 py-3 empty:hidden">{imageSection}</div>
				<div className="border-b border-line px-3 py-3 empty:hidden">{asrSection}</div>
				{auto && row("各协议地址", "默认都从上面的地址自动推出来，只有某个协议在别的地址时才填", "OpenAI 兼容 → 地址/v1，Anthropic → 地址根，Gemini → 地址/v1beta。这里填了就用这里的。", null, (
					<div className="space-y-1.5">
						{RELAY_APIS.map((a) => (
							<label key={a} className="flex items-center gap-2 text-xs">
								<span className="w-24 shrink-0 text-mut">{API_SHORT[a]}</span>
								<Input value={s.urls[a]} placeholder="自动" onChange={(e) => setS({ ...s, urls: { ...s.urls, [a]: e.target.value } })} aria-label={`${API_SHORT[a]} 地址`} data-testid={`relay-url-${a}`} />
							</label>
						))}
					</div>
				), "relay-protocol-urls")}
				{row("手动指定分类器", `已自动识别 ${meta.discoveredClassifiers?.length ?? 0} 个${s.classifiers.length ? `，手动 ${s.classifiers.length} 个` : "，未手动指定"}`, "只有服务没说明协议时才需要；鉴权沿用这里的 Key。", (
					<Button size="sm" variant="ghost" onClick={() => setS({ ...s, classifiers: [...s.classifiers, { protocol: protos[0], modelId: "" }] })}><Plus size={13} /> 添加</Button>
				), s.classifiers.map((c, i) => (
					<div key={i} className="flex gap-2">
						<Select value={c.protocol} ariaLabel="分类器协议" testId={`classifier-protocol-${i}`} options={protos.map((p) => ({ value: p, label: p }))} onChange={(v) => setS({ ...s, classifiers: s.classifiers.map((x, j) => (j === i ? { ...x, protocol: v } : x)) })} />
						<Input placeholder="对端模型 ID" value={c.modelId} onChange={(e) => setS({ ...s, classifiers: s.classifiers.map((x, j) => (j === i ? { ...x, modelId: e.target.value } : x)) })} />
						<Button size="icon" variant="ghost" aria-label="删除分类器" onClick={() => setS({ ...s, classifiers: s.classifiers.filter((_, j) => j !== i) })}><X size={14} /></Button>
					</div>
				)), "relay-classifiers")}
				{row("请求头", s.headers.length ? `${s.headers.length} 个` : "无", "少数中转要求额外的身份信息（如 X-Org-Id）；值会加密保存。", (
					<Button size="sm" variant="ghost" onClick={() => setS({ ...s, headers: [...s.headers, { name: "", value: "", saved: false }] })} data-testid="relay-header-add"><Plus size={13} /> 添加</Button>
				), s.headers.map((h, i) => (
					<div key={i} className="flex gap-2">
						<Input placeholder="名称" value={h.name} onChange={(e) => setS({ ...s, headers: s.headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
						<Input type="password" autoComplete="off" placeholder={h.saved ? "已加密保存，留空不修改" : "值"} value={h.value} onChange={(e) => setS({ ...s, headers: s.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
						<Button size="icon" variant="ghost" aria-label="删除请求头" onClick={() => setS({ ...s, headers: s.headers.filter((_, j) => j !== i) })}><X size={14} /></Button>
					</div>
				)), "relay-headers")}
				{dirty && (
					<div className="flex gap-2 border-t border-line px-3 py-2.5">
						<Button size="sm" variant="primary" disabled={busy} onClick={() => void save()} data-testid="relay-advanced-save">{busy && <Loader2 size={13} className="animate-spin" />} 保存</Button>
						<Button size="sm" variant="ghost" onClick={() => setS(init())}>还原</Button>
					</div>
				)}
			</div>
		</details>
	);
}
