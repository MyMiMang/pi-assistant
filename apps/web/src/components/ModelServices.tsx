/**
 * 统一模型服务（真实 CRUD，接公开 API）。
 * 设计见 docs/design/model-settings-unified.md；契约对齐（唯一事实来源）：
 *  - registry：`GET /api/models/registry` → `{ providers: RegistryProvider[] }`（packages/server/src/model-registry.ts）
 *  - 官方目录 / 登录：`GET /api/models/providers`、`POST /api/models/login`（Pi 公开登录流程，见 Models.tsx 的 LoginFlow）
 *  - 自定义 / 中转：`GET/POST/PUT/DELETE /api/models/custom`、`POST /api/models/custom/fetch-models`
 *  - 生图适配：`GET/POST/PUT/DELETE /api/image-models/*`（复用同一个服务的 Key 时传 `keyFrom`，不新建第二套 imageKey）
 * 一个服务 = 一份 baseUrl + 一份凭据，可同时含 chat / vision / image / classifier；生图与分类器不再单独配凭据。
 * 能力只按可靠来源；猜出来的标「未确认」。接口未就绪时显示加载 / 失败（不渲染 demo 数据）。
 */
import { Activity, AlertTriangle, Check, CheckCircle2, ChevronDown, Download, Gauge, Loader2, Monitor, Pencil, Play, Plus, RefreshCw, RotateCcw, Search, ShieldCheck, Square, Trash2, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { PROVIDER_ICONS } from "./provider-icons";
import type { ModelCapability, ModelType, Provider, RegistryModel, RegistryProvider } from "../types";
import { ImageProviderForm, type ImageModelsData, useImageModels } from "./ImageModels";
import { CustomProviderForm, useCustomProviders } from "./CustomProvider";
import { ProviderSetup, useProviders } from "./Models";
import { StrengthTags, useModelStrengths } from "./ModelStrengths";
import { Badge, Button, cx, fmtSize, Fold, Help, Input, Modal, Select, useConfirm } from "./ui";
import { useStore } from "../store";

const CAPS: ModelCapability[] = ["chat", "vision", "image", "classifier"];
const CAP_LABEL: Record<ModelCapability, string> = { chat: "对话", vision: "识图", image: "生图", classifier: "分类器" };
const CAP_TONE: Record<ModelCapability, "accent" | "green" | "amber" | "zinc"> = { chat: "accent", vision: "green", image: "amber", classifier: "zinc" };
const TYPE_LABEL: Record<ModelType, string> = { chat: "对话", image: "生图", classifier: "分类器" };
const AVATAR_TONES = [
	"bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
	"bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
	"bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
	"bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
	"bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
	"bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300",
];
function initials(name: string) {
	const ascii = name.trim().match(/[A-Za-z0-9]+/g) ?? [];
	if (ascii.length >= 2) return ((ascii[0]?.[0] ?? "") + (ascii[ascii.length - 1]?.[0] ?? "")).toUpperCase();
	const one = ascii[0];
	if (one && one.length >= 2) return one.slice(0, 2).toUpperCase();
	const chars = [...name.trim()].filter((c) => c.trim());
	return ((chars[0] ?? "") + (chars[chars.length - 1] ?? "")).toUpperCase();
}
function ServiceIcon({ provider }: { provider: Pick<RegistryProvider, "id" | "name" | "kind"> }) {
	const brand = provider.kind === "builtin" ? PROVIDER_ICONS[provider.id] : undefined;
	if (brand)
		return <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-white text-zinc-700 [&>svg]:size-5 dark:bg-zinc-800 dark:text-zinc-200" data-testid="service-icon" data-service-icon={provider.id} data-service-icon-kind="brand" dangerouslySetInnerHTML={{ __html: brand }} />;
	let h = 0;
	for (const c of provider.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return (
		<span aria-hidden className={cx("flex size-9 shrink-0 items-center justify-center rounded-lg text-xs font-semibold", AVATAR_TONES[h % AVATAR_TONES.length])} data-testid="service-icon" data-service-icon={provider.id} data-service-icon-kind={provider.kind}>
			{initials(provider.name)}
		</span>
	);
}

/** 能力标签：可靠来源正常显示；inferred 的标「未确认」（不假装事实）。 */
function CapabilityChips({ capabilities, inferred = [], testId }: { capabilities: ModelCapability[]; inferred?: ModelCapability[]; testId?: string }) {
	return (
		<span className="flex flex-wrap items-center gap-1" data-testid={testId}>
			{capabilities.map((c) => (
				<Badge key={c} tone={inferred.includes(c) ? "zinc" : CAP_TONE[c]}>
					{CAP_LABEL[c]}
					{inferred.includes(c) ? "？" : ""}
				</Badge>
			))}
			{!capabilities.length && <span className="text-[11px] text-mut2">能力未知</span>}
		</span>
	);
}

/** 能力纠正：多选 checkbox，保存后按「用户显式配置」记可靠来源（PUT 到 registry）。 */
function CapabilityEditor({ model, onSave, onCancel }: { model: RegistryModel; onSave: (caps: ModelCapability[]) => void; onCancel: () => void }) {
	const [picked, setPicked] = useState<ModelCapability[]>(model.capabilities);
	const toggle = (c: ModelCapability) => setPicked((l) => (l.includes(c) ? l.filter((x) => x !== c) : [...l, c]));
	return (
		<div className="space-y-2 rounded-lg border border-line p-2.5" data-testid="capability-editor" data-model={model.id}>
			<div className="text-xs font-medium">设置「{model.name || model.id}」的能力（可多选）</div>
			<div className="flex flex-wrap gap-2">
				{CAPS.map((c) => (
					<label key={c} className="flex items-center gap-1.5 text-xs">
						<input type="checkbox" checked={picked.includes(c)} onChange={() => toggle(c)} data-testid={`cap-${c}`} />
						{CAP_LABEL[c]}
					</label>
				))}
			</div>
			<div className="text-[11px] text-mut2">不确定时也可以不选：不影响保存，助理不会据此自动决策。选「分类器」后，只有能确定协议（官方目录同模型，或服务端给出协议）才会注册进分类器目录；认不出会标「未确认」，不会乱调未知端点。</div>
			<div className="flex gap-2">
				<Button size="sm" variant="primary" onClick={() => onSave(picked)} data-testid="cap-save">
					保存
				</Button>
				<Button size="sm" variant="ghost" onClick={onCancel}>
					取消
				</Button>
			</div>
		</div>
	);
}

/** 模型行：id + 类型 + 能力标签 + 「能力」纠正；有擅长标签时可在行内改（建群按这个挑模型）。 */
function ModelRow({ model, strengths, onSave }: { model: RegistryModel; strengths?: ReturnType<typeof useModelStrengths>; onSave: (caps: ModelCapability[]) => void }) {
	const [edit, setEdit] = useState(false);
	const [strengthOpen, setStrengthOpen] = useState(false);
	const labels = strengths?.data?.labels ?? [];
	const strength = strengths?.byModel.get(`${model.provider}/${model.id}`);
	return (
		<div className="px-2.5 py-1.5" data-testid="service-model" data-model={model.id} data-type={model.type}>
			<div className="flex items-center gap-2 text-xs">
				<span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-[11px] text-mut">{TYPE_LABEL[model.type]}</span>
				{model.discovered && <span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-[11px] text-mut2" title="按官方目录同模型 / 服务端元数据自动识别">自动识别</span>}
				<span className="min-w-0 flex-1 truncate font-mono" title={model.id}>
					{model.id}
				</span>
				<CapabilityChips capabilities={model.capabilities} inferred={model.inferred} testId="model-caps" />
				{strength && labels.length > 0 && (
					<button className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-mut2 hover:bg-hover hover:text-fg" onClick={() => setStrengthOpen(!strengthOpen)} aria-expanded={strengthOpen} data-testid="model-strength-toggle">
						擅长{strength.tags.length ? ` ${strength.tags.length}` : ""}
					</button>
				)}
				<button className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-mut2 hover:bg-hover hover:text-fg" onClick={() => setEdit(!edit)} aria-expanded={edit} data-testid="model-capability-toggle">
					能力
				</button>
			</div>
			{strengthOpen && strength && (
				<div className="mt-1.5">
					<StrengthTags labels={labels} model={strength} onPut={(tags) => void strengths?.put(model.provider, model.id, tags)} />
				</div>
			)}
			{model.type === "image" && (
				<div className="mt-1 flex flex-wrap gap-1 text-[11px] text-mut2">
					{model.imageAdapter && <span data-testid="image-adapter">生图适配：{model.imageAdapter.kind} · {model.imageAdapter.edit ? "支持改图" : "不支持改图"}</span>}
					{model.costNote && <span>· {model.costNote}</span>}
				</div>
			)}
			{edit && (
				<div className="mt-2">
					<CapabilityEditor model={model} onSave={(c) => (onSave(c), setEdit(false))} onCancel={() => setEdit(false)} />
				</div>
			)}
		</div>
	);
}

/** 测试连接：真实调用一次（走 `/api/models/test`），有 loading / 失败重试。 */
function TestConnection({ providerId, models }: { providerId: string; models: RegistryModel[] }) {
	const options = models.map((m) => ({ value: m.id, label: m.id }));
	const [model, setModel] = useState(options[0]?.value ?? "");
	const [state, setState] = useState<"idle" | "running" | { ok: boolean; message: string }>("idle");
	useEffect(() => {
		if (!options.some((o) => o.value === model)) setModel(options[0]?.value ?? "");
	}, [providerId]);
	const run = async () => {
		if (!model) return;
		setState("running");
		try {
			const r = await api<{ ok: boolean; message: string }>("/api/models/test", { method: "POST", json: { provider: providerId, model } });
			setState({ ok: r.ok, message: r.message });
		} catch (e) {
			setState({ ok: false, message: e instanceof Error ? e.message : String(e) });
		}
	};
	return (
		<div className="space-y-1.5" data-testid={`service-test-${providerId}`}>
			<div className="flex items-center gap-2">
				{options.length > 1 ? (
					<div className="min-w-0 flex-1">
						<Select value={model} ariaLabel="测试模型" testId={`service-test-model-${providerId}`} options={options} onChange={setModel} />
					</div>
				) : (
					<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-mut">{model || "没有可测的模型"}</span>
				)}
				<Button size="sm" variant="outline" disabled={!model || state === "running"} onClick={() => void run()} data-testid={`service-test-run-${providerId}`}>
					{state === "running" ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />} 测试连接
				</Button>
			</div>
			{state !== "idle" && state !== "running" && (
				<div className={cx("flex items-start gap-1.5 rounded-lg p-2 text-[11px]", state.ok ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" : "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300")} data-testid={`service-test-result-${providerId}`} data-ok={String(state.ok)}>
					{state.ok ? <CheckCircle2 size={13} className="mt-0.5 shrink-0" /> : <XCircle size={13} className="mt-0.5 shrink-0" />}
					<span className="break-all">{state.ok ? `连接成功：${state.message}` : state.message}</span>
				</div>
			)}
		</div>
	);
}

/** 生图适配：把本服务的生图模型绑定到同一个 provider（keyFrom），不新建第二套 Key。 */
function ImageAdapterSection({ provider, images, onReload }: { provider: RegistryProvider; images: ImageModelsData | null; onReload: () => void }) {
	const [editing, setEditing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	if (provider.kind !== "custom" || !images) return null;
	const bound = images.providers.find((p) => p.keyFrom === provider.id);
	const imageModelIds = provider.models.filter((m) => m.capabilities.includes("image") && m.type === "chat").map((m) => m.id);
	if (!bound && !imageModelIds.length) return null;
	const bind = async () => {
		setBusy(true);
		setErr("");
		try {
			await api("/api/image-models/providers", { method: "POST", json: { kind: "openai", name: provider.name, baseUrl: provider.baseUrl, keyFrom: provider.id, models: imageModelIds } });
			onReload();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	const unbind = async () => {
		if (!bound) return;
		setBusy(true);
		setErr("");
		try {
			await api(`/api/image-models/providers/${bound.id}`, { method: "DELETE" });
			onReload();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	if (editing && images) return <ImageProviderForm data={images} initial={bound} onDone={() => (setEditing(false), onReload())} onCancel={() => setEditing(false)} />;
	return (
		<div className="space-y-1.5 rounded-lg border border-line p-2.5" data-testid={`image-adapter-section-${provider.id}`} data-bound={String(!!bound)}>
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<span className="font-medium">生图适配</span>
				{bound ? (
					<span className="text-mut" data-testid={`image-adapter-bound-${provider.id}`}>
						已绑定（复用本服务 Key）：{bound.models.join("、")}
					</span>
				) : (
					<span className="text-mut2" data-testid={`image-adapter-unbound-${provider.id}`}>
						这个服务有能力生图：绑定后复用同一份 Key，不再单独填 Key。
					</span>
				)}
				{!bound && (
					<Button size="sm" variant="outline" disabled={busy} onClick={() => void bind()} data-testid={`image-adapter-bind-${provider.id}`}>
						{busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} 绑定生图
					</Button>
				)}
				{bound && (
					<>
						<Button size="sm" variant="ghost" onClick={() => setEditing(true)} data-testid={`image-adapter-edit-${provider.id}`}>
							<Pencil size={13} /> 编辑
						</Button>
						<Button size="sm" variant="ghost" className="text-red-600" disabled={busy} onClick={() => void unbind()} data-testid={`image-adapter-unbind-${provider.id}`}>
							解除绑定
						</Button>
					</>
				)}
			</div>
			{err && <div className="text-[11px] text-red-600">{err}</div>}
		</div>
	);
}

interface AsrDeclaration {
	provider: string;
	model: string;
	protocol?: string;
	name?: string;
	language?: string;
}
interface AsrProvidersData {
	protocols: string[];
	providers: AsrDeclaration[];
}

/**
 * 语音识别（ASR）适配：复用本服务的地址 / Key，只声明「这个模型走语音转写」，不新建第二套 Key。
 * 本地 SenseVoice 由 runtime 上报（在「本地模型」里），不走这里。
 */
function AsrAdapterSection({ provider, onReload }: { provider: RegistryProvider; onReload: () => void }) {
	const [data, setData] = useState<AsrProvidersData | null>(null);
	const [model, setModel] = useState("");
	const [protocol, setProtocol] = useState("openai-audio-transcriptions");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const load = () =>
		api<AsrProvidersData>("/api/audio/asr/providers")
			.then(setData)
			.catch(() => setData(null));
	useEffect(() => {
		void load();
	}, []);
	if (provider.kind === "local" || provider.kind === "imagegen") return null;
	const mine = (data?.providers ?? []).filter((d) => d.provider === provider.id);
	const cloudProtocols = (data?.protocols ?? ["openai-audio-transcriptions"]).filter((p) => p !== "local-asr-http");
	const options = provider.models.map((m) => ({ value: m.id, label: m.type === "chat" ? m.id : `${m.id}（${TYPE_LABEL[m.type]}）` }));
	const save = async () => {
		const id = model.trim();
		if (!id) return;
		setBusy(true);
		setErr("");
		try {
			setData(await api<AsrProvidersData>("/api/audio/asr/providers", { method: "POST", json: { provider: provider.id, model: id, protocol, name: provider.name } }));
			setModel("");
			onReload();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	const remove = async (m: string) => {
		setBusy(true);
		setErr("");
		try {
			setData(await api<AsrProvidersData>(`/api/audio/asr/providers/${encodeURIComponent(provider.id)}/${encodeURIComponent(m)}`, { method: "DELETE" }));
			onReload();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="space-y-1.5 rounded-lg border border-line p-2.5" data-testid={`asr-adapter-section-${provider.id}`} data-bound={String(mine.length > 0)}>
			<div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
				语音识别（ASR）声明
				<Help>只声明能力，不等于启用：真正用哪个在「设置 › 语音配置」里选。声明复用这里的地址和 Key，不新建第二套 Key。录音会先传到本机服务，再由本服务转发（音频会离开本机）。</Help>
			</div>
			{mine.length ? (
				<div className="space-y-1">
					{mine.map((d) => (
						<div key={d.model} className="flex items-center gap-2 text-xs" data-testid={`asr-bound-${provider.id}-${d.model}`}>
							<Badge tone="accent">语音</Badge>
							<span className="min-w-0 flex-1 truncate font-mono">{d.model}</span>
							<span className="text-[11px] text-mut2">{d.protocol ?? "openai-audio-transcriptions"}</span>
							<button className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-red-600 hover:bg-hover" disabled={busy} onClick={() => void remove(d.model)} data-testid={`asr-unbind-${provider.id}-${d.model}`}>
								解除
							</button>
						</div>
					))}
				</div>
			) : (
				<div className="text-[11px] text-mut2">尚未添加语音模型</div>
			)}
			<div className="flex flex-wrap items-center gap-2">
				{options.length ? (
					<Select value={model} ariaLabel="选择语音识别模型" testId={`asr-model-${provider.id}`} options={[{ value: "", label: "选择模型…" }, ...options]} onChange={setModel} className="min-w-[180px]" />
				) : (
					<Input placeholder="语音模型 id" value={model} onChange={(e) => setModel(e.target.value)} data-testid={`asr-model-input-${provider.id}`} className="min-w-[180px]" />
				)}
				<Select value={protocol} ariaLabel="语音协议" testId={`asr-protocol-${provider.id}`} options={cloudProtocols.map((p) => ({ value: p, label: p === "openai-audio-transcriptions" ? "OpenAI 语音转写" : p }))} onChange={setProtocol} className="min-w-[160px]" />
				<Button size="sm" variant="outline" disabled={busy || !model.trim()} onClick={() => void save()} data-testid={`asr-bind-${provider.id}`}>
					声明为语音识别
				</Button>
			</div>
			{err && <div className="text-[11px] text-red-600">{err}</div>}
		</div>
	);
}

/** 默认图片模型：在统一面板里选一个已注册的生图模型（共享 Select，不用原生 select）。 */
function DefaultImageModel({ images, onReload }: { images: ImageModelsData | null; onReload: () => void }) {
	if (!images || !images.models.length) return null;
	const key = (m: { provider: string; model?: string; id?: string }) => `${m.provider}::${m.model ?? m.id}`;
	const cur = images.default ? key(images.default) : "";
	return (
		<div className="flex flex-wrap items-center gap-2 text-xs" data-testid="default-image-model">
			<span className="font-medium text-zinc-500">默认图片模型</span>
			<div className="min-w-48 flex-1">
				<Select
					value={cur}
					ariaLabel="默认图片模型"
					testId="default-image-model"
					options={images.models.map((m) => ({ value: key(m), label: `${m.providerName} / ${m.id}` }))}
					onChange={(v) => {
						const m = images.models.find((x) => key(x) === v);
						if (m) void api("/api/image-models/default", { method: "PUT", json: { provider: m.provider, model: m.id } }).then(onReload);
					}}
				/>
			</div>
		</div>
	);
}

/** 服务卡：图标 + 名称 / 状态 / 能力标签；展开是模型列表（能力可纠正）+ 测试连接 + 官方登录 / 自定义编辑删除 / 生图适配。 */
function ServiceCard({
	provider,
	official,
	custom,
	images,
	strengths,
	open,
	onToggle,
	onSaveCaps,
	onReload,
	onDelete,
}: {
	provider: RegistryProvider;
	official?: Provider;
	custom?: ReturnType<typeof useCustomProviders>;
	images: ImageModelsData | null;
	strengths: ReturnType<typeof useModelStrengths>;
	open: boolean;
	onToggle: () => void;
	onSaveCaps: (modelId: string, caps: ModelCapability[]) => void;
	onReload: () => void;
	onDelete: () => Promise<void>;
}) {
	const [editing, setEditing] = useState(false);
	const [editImage, setEditImage] = useState(false);
	const [deleteBusy, setDeleteBusy] = useState(false);
	const customMeta = custom?.providers.find((c) => c.id === provider.id);
	const caps = CAPS.filter((c) => provider.models.some((m) => m.capabilities.includes(c)));
	return (
		<div className={cx("rounded-xl border border-line", open && "sm:col-span-2")} data-testid="service-card" data-service={provider.id} data-kind={provider.kind}>
			<button className="flex w-full items-center gap-2.5 p-3 text-left" onClick={onToggle} aria-expanded={open} data-testid={`service-toggle-${provider.id}`}>
				<ServiceIcon provider={provider} />
				<span className="min-w-0 flex-1">
					<span className="flex flex-wrap items-center gap-1.5">
						<span className="min-w-0 truncate text-sm font-medium">{provider.name}</span>
						{provider.configured && <CheckCircle2 size={14} className="shrink-0 text-emerald-500" aria-label="已配置" />}
						{provider.kind === "custom" && <Badge tone="amber">自定义</Badge>}
						{provider.kind === "local" && <Badge tone="accent">本地</Badge>}
						{provider.kind === "imagegen" && <Badge tone="amber">生图</Badge>}
					</span>
					<span className="mt-1 flex flex-wrap items-center gap-1.5">
						<CapabilityChips capabilities={caps} testId={`service-caps-${provider.id}`} />
						<span className="text-[11px] text-zinc-400">{provider.models.length} 个模型</span>
					</span>
				</span>
				<ChevronDown size={14} className={cx("shrink-0 text-mut transition-transform", !open && "-rotate-90")} />
			</button>
			{open && editing && custom && customMeta ? (
				<div className="space-y-3 border-t border-line p-3">
					<Button size="sm" variant="ghost" onClick={() => setEditing(false)} data-testid={`service-edit-back-${provider.id}`}>
						← 返回
					</Button>
					<CustomProviderForm
						initial={customMeta}
						apis={custom.apis}
						classifierProtocols={custom.classifierProtocols}
						onSaved={() => (setEditing(false), onReload())}
						onCancel={() => setEditing(false)}
						onDeleted={() => (setEditing(false), onReload())}
					/>
				</div>
			) : open ? (
				<div className="space-y-3 border-t border-line p-3">
					<div className="space-y-1.5">
						<span className="text-xs font-medium text-zinc-500">模型（{provider.models.length}）</span>
						<div className="max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line" data-testid={`service-models-${provider.id}`}>
							{!provider.models.length && <div className="p-2 text-xs text-mut">还没有载入模型</div>}
							{provider.models.map((m) => (
								<ModelRow key={`${m.type}:${m.id}`} model={m} strengths={strengths} onSave={(c) => onSaveCaps(m.id, c)} />
							))}
						</div>
						<div className="text-[11px] text-mut2">能力来自 Pi 目录 / 用户显式配置 / 服务端 /models 元数据；官方同模型或服务端给了协议会自动标为「分类器」（标「自动识别」），靠名字猜的标「未确认」。不会逐个模型做隐式付费探测。</div>
					</div>
					<TestConnection providerId={provider.id} models={provider.models} />
					<AsrAdapterSection provider={provider} onReload={onReload} />
					<ImageAdapterSection provider={provider} images={images} onReload={onReload} />
					{provider.kind === "custom" && customMeta && (
						<div className="flex flex-wrap gap-2">
							<Button size="sm" variant="outline" onClick={() => setEditing(true)} data-testid={`service-edit-${provider.id}`}>
								<Pencil size={13} /> 编辑渠道（模型 / Key / 请求头）
							</Button>
							<Button
								size="sm"
								variant="ghost"
								className="text-red-600"
								disabled={deleteBusy}
								onClick={async () => {
									setDeleteBusy(true);
									try {
										await onDelete();
									} finally {
										setDeleteBusy(false);
									}
								}}
								data-testid={`service-delete-${provider.id}`}
							>
								{deleteBusy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} 删除
							</Button>
						</div>
					)}
					{provider.kind === "builtin" && official && (
						<div className="rounded-lg border border-line p-2.5" data-testid={`official-setup-${provider.id}`}>
							<div className="mb-1 text-xs font-medium text-zinc-500">{official.configured ? "登录 / 凭据" : "接入官方服务"}</div>
							<ProviderSetup provider={official} onConfigured={onReload} />
						</div>
					)}
					{provider.kind === "imagegen" && images && (
						editImage ? (
							<ImageProviderForm data={images} initial={images.providers.find((p) => p.id === provider.id)} onDone={() => (setEditImage(false), onReload())} onCancel={() => setEditImage(false)} />
						) : (
							<Button size="sm" variant="outline" onClick={() => setEditImage(true)} data-testid={`image-edit-${provider.id}`}>
								<Pencil size={13} /> 编辑生图服务
							</Button>
						)
					)}
				</div>
			) : null}
		</div>
	);
}

/** 添加服务：官方（完整目录，未配置也能接）/ 自定义中转 / 生图。 */
function AddServiceDialog({ open, onClose, official, custom, images, onReload }: { open: boolean; onClose: () => void; official: Provider[]; custom: ReturnType<typeof useCustomProviders>; images: ImageModelsData | null; onReload: () => void }) {
	const [kind, setKind] = useState<"builtin" | "custom" | "image">("builtin");
	const [picked, setPicked] = useState<Provider | null>(null);
	const [q, setQ] = useState("");
	useEffect(() => {
		if (open) {
			setPicked(null);
			setQ("");
		}
	}, [open]);
	const builtins = useMemo(() => official.filter((p) => !p.custom && p.id !== "mock" && (!q || `${p.name} ${p.id}`.toLowerCase().includes(q.toLowerCase()))).sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name)), [official, q]);
	return (
		<Modal open={open} onClose={onClose} title="添加模型服务" testId="add-service" wide>
			<div className="space-y-3 p-5">
				<div className="space-y-1.5">
					<div className="text-xs font-medium">类型</div>
					<Select
						value={kind}
						ariaLabel="服务类型"
						testId="add-service-kind"
						options={[
							{ value: "builtin", label: "官方服务（内置目录，填 Key 登录）" },
							{ value: "custom", label: "自定义 / 中转（填 Base URL + Key）" },
							{ value: "image", label: "生图服务（OpenAI / 百炼 / 方舟 / Gemini / xAI）" },
						]}
						onChange={(v) => (setKind(v as typeof kind), setPicked(null))}
					/>
				</div>
				{kind === "builtin" && !picked && (
					<div className="space-y-2">
						<div className="relative">
							<Search size={15} className="absolute top-2.5 left-2.5 text-zinc-400" />
							<Input placeholder={`搜索 ${official.filter((p) => !p.custom).length} 个官方服务…`} value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" data-testid="add-service-official-search" />
						</div>
						<div className="grid max-h-[46dvh] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2" data-testid="add-service-official-grid">
							{builtins.map((p) => (
								<button key={p.id} onClick={() => setPicked(p)} className="flex items-center gap-2.5 rounded-xl border border-line p-3 text-left hover:border-accent" data-testid={`official-provider-${p.id}`}>
									<ServiceIcon provider={{ id: p.id, name: p.name, kind: "builtin" }} />
									<span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
									{p.configured ? <CheckCircle2 size={14} className="shrink-0 text-emerald-500" /> : <span className="shrink-0 text-[11px] text-mut2">未接入</span>}
								</button>
							))}
							{!builtins.length && <div className="p-2 text-xs text-mut">没有匹配的官方服务</div>}
						</div>
					</div>
				)}
				{kind === "builtin" && picked && (
					<div className="space-y-3">
						<div className="flex items-center gap-2">
							<Button size="sm" variant="ghost" onClick={() => setPicked(null)} data-testid="official-back">
								← 返回
							</Button>
							<ServiceIcon provider={{ id: picked.id, name: picked.name, kind: "builtin" }} />
							<span className="text-sm font-medium">{picked.name}</span>
							<span className="text-[11px] text-mut2">{picked.modelCount} 个模型</span>
						</div>
						<div className="rounded-lg border border-line p-2.5" data-testid={`official-login-${picked.id}`}>
							<ProviderSetup provider={picked} onConfigured={() => (onReload(), onClose())} />
						</div>
						<div className="text-[11px] text-mut2">填入 API Key 或按提示登录后，这个官方服务的模型会自动出现在统一目录里；不做隐式付费探测。</div>
					</div>
				)}
				{kind === "custom" && (
					<div className="space-y-3">
						<CustomProviderForm
							apis={custom.apis}
							classifierProtocols={custom.classifierProtocols}
							onSaved={() => (onReload(), onClose())}
							onCancel={onClose}
						/>
					</div>
				)}
				{kind === "image" && images && (
					<div className="space-y-3">
						<ImageProviderForm data={images} onDone={() => (onReload(), onClose())} onCancel={onClose} />
					</div>
				)}
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={onClose}>
						取消
					</Button>
					{kind === "builtin" && picked && (
						<Button variant="primary" onClick={() => (onReload(), onClose())} data-testid="add-service-submit">
							<Check size={14} /> 完成
						</Button>
					)}
				</div>
			</div>
		</Modal>
	);
}

/**
 * 统一模型服务面板：服务卡片网格 + 添加服务。
 * 数据来自 `/api/models/registry`（统一视图）、`/api/models/providers`（官方完整目录）、
 * `/api/models/custom`（自定义渠道 CRUD）、`/api/image-models`（生图适配）。接口失败显示错误 + 重试，不渲染 demo。
 */
export function ModelServicesPanel() {
	const [registry, setRegistry] = useState<RegistryProvider[]>([]);
	const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
	const [err, setErr] = useState("");
	const { providers: official, reload: reloadOfficial } = useProviders();
	const custom = useCustomProviders();
	const { data: images, reload: reloadImages } = useImageModels();
	const strengths = useModelStrengths();
	const [open, setOpen] = useState<string[]>([]);
	const [q, setQ] = useState("");
	const [addOpen, setAddOpen] = useState(false);
	const [expanded, setExpanded] = useState(true);
	const [, ask] = useConfirm();
	const [confirmUi, askConfirm] = useConfirm();
	const loadRegistry = () =>
		api<{ providers: RegistryProvider[] }>("/api/models/registry")
			.then((r) => (setRegistry(r.providers), setPhase("ready"), setErr("")))
			.catch((e) => (setErr(e instanceof Error ? e.message : String(e)), setPhase("error")));
	useEffect(() => {
		void loadRegistry();
	}, []);
	const reloadAll = () => {
		void loadRegistry();
		void reloadOfficial();
		void custom.reload();
		void reloadImages();
		strengths.reload();
	};
	const saveCaps = (providerId: string, modelId: string, caps: ModelCapability[]) => {
		setRegistry((cur) => cur.map((p) => (p.id !== providerId ? p : { ...p, models: p.models.map((m) => (m.id !== modelId ? m : { ...m, capabilities: caps, inferred: [], confirmed: true, source: "custom" as const })) })));
		void api(`/api/models/registry/${providerId}/models/${modelId}/capabilities`, { method: "PUT", json: { capabilities: caps } }).catch(() => {});
	};
	const deleteCustom = async (p: RegistryProvider) => {
		const impact = custom.providers.find((c) => c.id === p.id)?.references;
		const lines: string[] = [];
		if (impact?.defaultModel) lines.push("默认模型会被清空，需要重新选一个");
		if (impact?.visionModel) lines.push("识图模型会改回自动选择");
		if (impact?.agents.length) lines.push(`${impact.agents.length} 个助理的模型会回落到默认模型`);
		if (impact?.subagentAgents.length) lines.push(`${impact.subagentAgents.length} 个助理的子代理候选池里会去掉这个服务的模型`);
		const ok = await askConfirm({ title: `删除「${p.name}」？`, body: `删除后不能恢复。${lines.length ? `\n\n会影响：${lines.join("；")}` : ""}`, ok: "删除", danger: true });
		if (!ok) return;
		try {
			await api(`/api/models/custom/${p.id}`, { method: "DELETE" });
			reloadAll();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		}
	};
	// 本地语音由语音设置里的管理卡展示，registry 里的条目不重复成卡片
	const services = useMemo(() => registry.filter((s) => s.id !== "local-sensevoice"), [registry]);
	const list = useMemo(() => {
		const f = services.filter((s) => !q || `${s.name} ${s.id}`.toLowerCase().includes(q.toLowerCase()));
		return [...f].sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
	}, [services, q]);
	if (phase === "loading") return <div className="rounded-xl border border-dashed border-line p-4 text-center text-xs text-mut" data-testid="model-services-loading">正在载入模型服务…</div>;
	if (phase === "error")
		return (
			<div className="space-y-2 rounded-xl border border-line p-4 text-center text-xs" data-testid="model-services-error">
				<div className="text-red-600">模型服务载入失败：{err}</div>
				<Button size="sm" variant="outline" onClick={() => void loadRegistry()} data-testid="model-services-retry">
					<RefreshCw size={13} /> 重试
				</Button>
			</div>
		);
	const configured = services.filter((s) => s.configured).length;
	return (
		<Fold testId="model-services" icon={Gauge} title="模型服务" count={services.length} hint={configured ? `已配置 ${configured}` : undefined} desc="一个服务 = 一份地址 + 一份凭据，可同时含对话 / 识图 / 生图 / 分类器（如 Jev）模型（官方目录没有的，也能在这里填 Key 登录）。Jev / 官方同模型会自动识别为分类器，猜的标「未确认」，可手动纠正；生图与分类器模型都在这里选，不再单独配凭据。" open={expanded} onToggle={() => setExpanded((v) => !v)}>
			<div className="space-y-3" data-testid="model-services-panel">
				{confirmUi}
				<DefaultImageModel images={images} onReload={reloadAll} />
				<div className="flex flex-wrap items-center gap-2">
					<div className="relative min-w-40 flex-1">
						<Search size={15} className="absolute top-2.5 left-2.5 text-zinc-400" />
						<Input placeholder={`搜索 ${services.length} 个模型服务…`} value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" data-testid="service-search" />
					</div>
					<Button variant="primary" onClick={() => setAddOpen(true)} data-testid="add-service-open">
						<Plus size={15} /> 添加服务
					</Button>
				</div>
				{!list.length && <div className="rounded-xl border border-dashed border-line p-4 text-center text-xs text-mut">还没有其它模型服务。点「添加服务」选官方 / 自定义。</div>}
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="service-grid">
					{list.map((s) => (
						<ServiceCard
							key={s.id}
							provider={s}
							official={official.find((o) => o.id === s.id)}
							custom={custom}
							images={images}
							strengths={strengths}
							open={open.includes(s.id)}
							onToggle={() => setOpen((l) => (l.includes(s.id) ? l.filter((x) => x !== s.id) : [...l, s.id]))}
							onSaveCaps={(m, c) => saveCaps(s.id, m, c)}
							onReload={reloadAll}
							onDelete={() => deleteCustom(s)}
						/>
					))}
				</div>
			</div>
			<AddServiceDialog open={addOpen} onClose={() => setAddOpen(false)} official={official} custom={custom} images={images} onReload={reloadAll} />
		</Fold>
	);
}
