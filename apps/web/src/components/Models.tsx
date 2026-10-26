/**
 * 模型配置组件：provider 列表、登录流程、默认模型选择与连接测试。
 * 全部数据来自服务端的 Pi provider 目录，Pi 新增 provider/登录方式时这里自动支持。
 */
import { ModelOptions, modelLabel } from "./ModelOptions";
import { PROVIDER_ICONS } from "./provider-icons";
import { Brain, CheckCircle2, ChevronDown, Copy, ExternalLink, KeyRound, Loader2, LogOut, Pencil, Plus, Search, Sparkles, XCircle } from "lucide-react";
import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { ModelPickerButton, THINKING_LABEL, useConfiguredModels } from "./ModelPicker";
import { StrengthTags, type StrengthModel, type StrengthTag } from "./ModelStrengths";
import { api } from "../api";
import { copyText } from "../clipboard";
import { LatestWrite } from "../latest-write";
import { useStore } from "../store";
import type { ModelInfo, Provider } from "../types";
import { Badge, Button, cx, Help, Input } from "./ui";

const EMPTY: any[] = [];

export function useProviders() {
	const [providers, setProviders] = useState<Provider[]>([]);
	const reload = () => api<Provider[]>("/api/models/providers").then(setProviders);
	useEffect(() => {
		void reload();
	}, []);
	return { providers, reload };
}

export function ProviderList({ providers, onPick, selected }: { providers: Provider[]; onPick: (p: Provider) => void; selected?: string }) {
	const [q, setQ] = useState("");
	const list = useMemo(() => {
		const f = providers.filter((p) => !q || `${p.name} ${p.id}`.toLowerCase().includes(q.toLowerCase()));
		return f.sort((a, b) => Number(b.id === "mock") - Number(a.id === "mock") || Number(!!b.custom) - Number(!!a.custom) || Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
	}, [providers, q]);
	return (
		<div className="space-y-3">
			<div className="relative">
				<Search size={15} className="absolute top-2.5 left-2.5 text-zinc-400" />
				<Input placeholder={`搜索 ${providers.length} 个模型服务…`} value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
			</div>
			<div className="grid max-h-[46dvh] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
				{list.map((p) => (
					<button
						key={p.id}
						onClick={() => onPick(p)}
						className={cx("rounded-xl border p-3 text-left transition hover:border-accent", selected === p.id ? "border-accent bg-accent-soft" : "border-line")}
					>
						<div className="flex items-center gap-2.5">
							<ProviderAvatar provider={p} />
							<span className="min-w-0 flex-1 truncate text-sm font-medium">{providerName(p)}</span>
							{p.configured && <CheckCircle2 size={14} className="shrink-0 text-emerald-500" />}
						</div>
						<div className="mt-1.5 flex flex-wrap gap-1">
							{p.id === "mock" ? <Badge tone="amber">无需 Key</Badge> : null}
							{p.custom && <Badge tone="amber">自定义</Badge>}
							{p.apiKey && p.id !== "mock" && !p.custom && <Badge>API Key</Badge>}
							{p.oauth && <Badge tone="accent">{p.oauth.isSubscription ? "订阅登录" : "OAuth 登录"}</Badge>}
							<span className="text-[11px] text-zinc-400">{p.modelCount} 个模型</span>
						</div>
					</button>
				))}
			</div>
		</div>
	);
}

/** 服务显示名：Mock 用固定中文名，其余用 provider 目录 / 用户起的名字。 */
const providerName = (p: Provider) => (p.id === "mock" ? "Mock 模型（本地测试）" : p.name);

/** 字母头像配色：内置服务用品牌 logo；自定义渠道、以及图标库里没有的品牌用「首字母 + 稳定配色」的字母头像兜底。 */
const AVATAR_TONES = [
	"bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
	"bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
	"bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
	"bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
	"bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
	"bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300",
	"bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-500/15 dark:text-fuchsia-300",
	"bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300",
	"bg-lime-100 text-lime-700 dark:bg-lime-500/15 dark:text-lime-300",
	"bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300",
	"bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300",
	"bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300",
];
function providerInitials(name: string) {
	const t = name.trim();
	const ascii = t.match(/[A-Za-z0-9]+/g) ?? [];
	if (ascii.length >= 2) return ((ascii[0]?.charAt(0) ?? "") + (ascii[ascii.length - 1]?.charAt(0) ?? "")).toUpperCase(); // Amazon Bedrock → AB；Xiaomi Token Plan AMS/CN/SGP → XA/XC/XS
	const one = ascii[0];
	if (one && one.length >= 2) return one.slice(0, 2).toUpperCase(); // Anthropic → AN / Mock… → MO
	// 其余（中文名，或只有一个字母/数字）：首字符 + 末尾可识别字符，保证「渠道1…6」这种也能区分
	const chars = [...t].filter((c) => c.trim());
	const first = chars[0] ?? "";
	const last = chars[chars.length - 1] ?? "";
	return (first + (/[A-Za-z0-9]/.test(last) ? last : "")).toUpperCase();
}
/** 服务图标：内置服务用品牌 logo（来自 @lobehub/icons-static-svg，MIT，见 provider-icons.ts）；
 *  自定义渠道和未收录品牌用「首字母 + 稳定配色」的字母头像，每个服务靠字母 + 颜色区分。 */
function ProviderAvatar({ provider }: { provider: Provider }) {
	const brand = provider.custom ? undefined : PROVIDER_ICONS[provider.id];
	if (brand) {
		return (
			<span
				aria-hidden
				className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-white text-zinc-700 [&>svg]:size-5 dark:bg-zinc-800 dark:text-zinc-200"
				data-testid="provider-icon"
				data-provider-icon={provider.id}
				data-provider-icon-kind="brand"
				dangerouslySetInnerHTML={{ __html: brand }}
			/>
		);
	}
	let h = 0;
	for (const c of provider.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	const tone = AVATAR_TONES[h % AVATAR_TONES.length];
	return (
		<span aria-hidden className={cx("flex size-9 shrink-0 items-center justify-center rounded-lg text-xs font-semibold", tone)} data-testid="provider-icon" data-provider-icon={provider.id} data-provider-icon-kind="letter">
			{providerInitials(providerName(provider))}
		</span>
	);
}

/** 设置 › 模型 › 模型服务：内置服务和用户添加的渠道分组，每组是带服务图标的卡片网格；
 *  点卡片展开这个服务支持的模型和登录 / 编辑配置，每个模型行里再展开「能力」改擅长标签。 */
export function ProviderAccordion({ providers, onEditCustom, onConfigured, strengths }: { providers: Provider[]; onEditCustom: (id: string) => void; onConfigured: () => void; strengths: ReturnType<typeof import("./ModelStrengths").useModelStrengths> }) {
	const [q, setQ] = useState("");
	const [open, setOpen] = useState<string[]>([]);
	const list = useMemo(() => {
		const f = providers.filter((p) => !q || `${p.name} ${p.id}`.toLowerCase().includes(q.toLowerCase()));
		return f.sort((a, b) => Number(b.id === "mock") - Number(a.id === "mock") || Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
	}, [providers, q]);
	const groups: { key: string; title: string; items: Provider[] }[] = [
		{ key: "builtin", title: "内置服务", items: list.filter((p) => !p.custom) },
		{ key: "mine", title: "我的渠道", items: list.filter((p) => p.custom) },
	];
	return (
		<div className="space-y-3" data-testid="provider-accordion">
			<div className="relative">
				<Search size={15} className="absolute top-2.5 left-2.5 text-zinc-400" />
				<Input placeholder={`搜索 ${providers.length} 个模型服务…`} value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
			</div>
			{groups.map((g) =>
				g.items.length ? (
					<div key={g.key} className="space-y-2">
						<div className="text-xs font-semibold text-mut" data-testid={`provider-group-${g.key}`}>
							{g.title}（{g.items.length}）
						</div>
						<div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid={`provider-grid-${g.key}`}>
							{g.items.map((p) => (
								<ProviderRow key={p.id} provider={p} open={open.includes(p.id)} onToggle={() => setOpen((l) => (l.includes(p.id) ? l.filter((x) => x !== p.id) : [...l, p.id]))} onEditCustom={onEditCustom} onConfigured={onConfigured} strengths={strengths} />
							))}
						</div>
					</div>
				) : null,
			)}
		</div>
	);
}

const SOURCE_LABEL: Record<string, string> = { stored: "已保存凭据", models_json_key: "写在 models.json 的 Key", runtime: "运行时登录", env: "环境变量", environment: "环境变量" };

/** 渠道卡片：图标 + 名称 / 状态 / 模型数；展开后（跨两列）是该服务支持的模型（含能力标签编辑）和登录 / 编辑配置 */
function ProviderRow({ provider, open, onToggle, onEditCustom, onConfigured, strengths }: { provider: Provider; open: boolean; onToggle: () => void; onEditCustom: (id: string) => void; onConfigured: () => void; strengths: ReturnType<typeof import("./ModelStrengths").useModelStrengths> }) {
	const [models, setModels] = useState<ModelInfo[] | null>(null);
	const [mq, setMq] = useState("");
	useEffect(() => {
		if (!open || models) return;
		void api<ModelInfo[]>(`/api/models?provider=${encodeURIComponent(provider.id)}`)
			.then(setModels)
			.catch(() => setModels([]));
	}, [open, models, provider.id]);
	const shown = (models ?? []).filter((m) => !mq || `${m.name} ${m.id}`.toLowerCase().includes(mq.toLowerCase()));
	const labels: StrengthTag[] = strengths.data?.labels ?? [];
	return (
		<div className={cx("rounded-xl border border-line", open && "sm:col-span-2")} data-testid="provider-row" data-provider={provider.id}>
			<button className="flex w-full items-center gap-2.5 p-3 text-left" onClick={onToggle} aria-expanded={open} data-testid={`provider-toggle-${provider.id}`}>
				<ProviderAvatar provider={provider} />
				<span className="min-w-0 flex-1">
					<span className="flex items-center gap-1.5">
						<span className="min-w-0 truncate text-sm font-medium">{providerName(provider)}</span>
						{provider.configured && <CheckCircle2 size={14} className="shrink-0 text-emerald-500" aria-label="已配置" />}
						{provider.custom && <Badge tone="amber">自定义</Badge>}
					</span>
					<span className="mt-1 flex flex-wrap items-center gap-1">
						{provider.id === "mock" ? <Badge tone="amber">无需 Key</Badge> : null}
						{provider.apiKey && provider.id !== "mock" && !provider.custom && <Badge>API Key</Badge>}
						{provider.oauth && <Badge tone="accent">{provider.oauth.isSubscription ? "订阅登录" : "OAuth 登录"}</Badge>}
						<span className="text-[11px] text-zinc-400">{provider.modelCount} 个模型</span>
					</span>
				</span>
				<ChevronDown size={14} className={cx("shrink-0 text-mut transition-transform", !open && "-rotate-90")} />
			</button>
			{open && (
				<div className="space-y-3 border-t border-line p-3">
					{provider.configured && (
						<div className="flex flex-wrap gap-1">
							<Badge tone="accent">已配置{provider.source && SOURCE_LABEL[provider.source] ? `（${SOURCE_LABEL[provider.source]}）` : ""}</Badge>
						</div>
					)}
					<div className="space-y-1.5">
						<div className="flex items-center justify-between gap-2">
							<span className="text-xs font-medium text-zinc-500">支持的模型（{provider.modelCount}）</span>
							{provider.modelCount > 12 && <Input placeholder="筛选模型…" value={mq} onChange={(e) => setMq(e.target.value)} className="!h-7 !w-40 !px-2 !text-xs" />}
						</div>
						<div className="max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line" data-testid={`provider-models-${provider.id}`}>
							{models === null && <div className="p-2 text-xs text-mut">加载中…</div>}
							{models !== null && !shown.length && <div className="p-2 text-xs text-mut">{mq ? "没有匹配的模型" : "这个服务没有列出模型"}</div>}
							{shown.map((m) => (
								<ProviderModelRow key={m.id} provider={provider.id} m={m} labels={labels} strength={strengths.byModel.get(`${provider.id}/${m.id}`)} onPut={(tags) => void strengths.put(provider.id, m.id, tags)} />
							))}
						</div>
						<div className="text-[11px] text-mut2">点模型行的「能力」可以改它擅长的方向（建群时按这个挑模型）。</div>
					</div>
					{provider.custom ? (
						<Button size="sm" variant="outline" onClick={() => onEditCustom(provider.id)} data-testid={`provider-edit-${provider.id}`}>
							<Pencil size={14} /> 编辑渠道（模型 / Key / 请求头）
						</Button>
					) : (
						<ProviderSetup provider={provider} onConfigured={onConfigured} />
					)}
				</div>
			)}
		</div>
	);
}

/** 渠道里的一个模型：一行显示模型 id / 名称 / 推理标记；有擅长标签时展开「能力」编辑 */
function ProviderModelRow({ provider, m, labels, strength, onPut }: { provider: string; m: ModelInfo; labels: StrengthTag[]; strength?: StrengthModel; onPut: (tags: string[] | null) => void }) {
	const [open, setOpen] = useState(false);
	return (
		<div data-testid="provider-model" data-model={`${provider}/${m.id}`}>
			<div className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
				<span className="min-w-0 flex-1 truncate font-mono" title={m.id}>
					{m.id}
				</span>
				{m.name && m.name !== m.id && <span className="max-w-[45%] shrink-0 truncate text-mut">{m.name}</span>}
				{m.reasoning && <Brain size={11} className="shrink-0 text-mut" aria-label="支持推理" />}
				{strength && labels.length > 0 && (
					<button className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-mut2 hover:bg-hover hover:text-fg" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="model-strength-toggle">
						能力{strength.tags.length ? ` ${strength.tags.length}` : ""}
					</button>
				)}
			</div>
			{open && strength && (
				<div className="px-2.5 pb-2">
					<StrengthTags labels={labels} model={strength} onPut={onPut} />
				</div>
			)}
		</div>
	);
}

/** 通用登录流程：渲染 Pi 发来的 prompt / auth_url / device_code / progress 事件。 */export function LoginFlow({ provider, type, onDone }: { provider: Provider; type: "api_key" | "oauth"; onDone: (ok: boolean) => void }) {
	const [flowId, setFlowId] = useState<string | null>(null);
	const events = useStore((s) => (flowId ? s.loginEvents[flowId] : undefined)) ?? EMPTY;
	const [value, setValue] = useState("");
	useEffect(() => {
		let id: string | null = null;
		api("/api/models/login", { method: "POST", json: { provider: provider.id, type } }).then((r) => setFlowId((id = r.flowId)));
		return () => {
			if (id) void api(`/api/models/login/${id}`, { method: "DELETE" }).catch(() => {});
		};
	}, [provider.id, type]);
	const done = events.find((e) => e.kind === "done");
	useEffect(() => {
		if (done) onDone(done.ok);
	}, [!!done]);
	const prompts = events.filter((e) => e.kind === "prompt");
	const answered = new Set(events.filter((e) => e.kind === "answered").map((e) => e.promptId));
	const prompt = done ? null : [...prompts].reverse().find((p) => !answered.has(p.promptId));
	const answer = async (v: string) => {
		if (!flowId || !prompt) return;
		useStore.getState().handle({ type: "login.event", flowId, event: { kind: "answered", promptId: prompt.promptId } });
		setValue("");
		await api(`/api/models/login/${flowId}`, { method: "POST", json: { promptId: prompt.promptId, value: v } });
	};
	return (
		<div className="space-y-3">
			{!flowId && (
				<div className="flex items-center gap-2 text-sm text-zinc-500">
					<Loader2 size={14} className="animate-spin" /> 正在准备登录…
				</div>
			)}
			{events
				.filter((e) => e.kind === "notify")
				.map((e, i) => {
					const ev = e.event;
					if (ev.type === "auth_url")
						return (
							<div key={i} className="rounded-xl border border-zinc-200 p-3 text-sm dark:border-zinc-800">
								<div className="mb-2">{ev.instructions ?? "在浏览器中完成登录授权："}</div>
								<div className="flex gap-2">
									<a href={ev.url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1 rounded-lg bg-accent px-3 text-sm font-medium text-white">
										<ExternalLink size={14} /> 打开登录页面
									</a>
									<Button size="sm" variant="outline" onClick={() => void copyText(ev.url)}>
										<Copy size={14} /> 复制链接
									</Button>
								</div>
							</div>
						);
					if (ev.type === "device_code")
						return (
							<div key={i} className="rounded-xl border border-zinc-200 p-3 text-sm dark:border-zinc-800">
								打开 <a className="text-accent underline" href={ev.verificationUri} target="_blank" rel="noreferrer">{ev.verificationUri}</a> 并输入验证码：
								<div className="mt-2 font-mono text-2xl font-bold tracking-widest">{ev.userCode}</div>
							</div>
						);
					return (
						<div key={i} className="text-xs text-zinc-500">
							{ev.message}
							{ev.links?.map((l: { url: string; label?: string }) => (
								<a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="ml-2 text-accent underline">
									{l.label ?? l.url}
								</a>
							))}
						</div>
					);
				})}
			{prompt && (
				<div className="space-y-2">
					<div className="text-sm font-medium">{prompt.prompt.message}</div>
					{prompt.prompt.type === "select" ? (
						<div className="flex flex-col gap-1.5">
							{prompt.prompt.options.map((o: { id: string; label: string; description?: string }) => (
								<button key={o.id} onClick={() => answer(o.id)} className="rounded-lg border border-zinc-200 px-3 py-2 text-left text-sm hover:border-accent dark:border-zinc-700">
									{o.label}
									{o.description && <div className="text-xs text-zinc-500">{o.description}</div>}
								</button>
							))}
						</div>
					) : (
						<form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), value && answer(value))}>
							<Input
								autoFocus
								type={prompt.prompt.type === "secret" ? "password" : "text"}
								placeholder={prompt.prompt.placeholder ?? (prompt.prompt.type === "secret" ? "粘贴到这里" : "")}
								value={value}
								onChange={(e) => setValue(e.target.value)}
								autoComplete="off"
							/>
							<Button variant="primary" type="submit">
								确定
							</Button>
						</form>
					)}
					{prompt.prompt.type === "secret" && <div className="text-xs text-zinc-500">凭据加密保存在这台电脑上，不会上传到任何服务器。</div>}
				</div>
			)}
			{done && (
				<div className={cx("flex items-center gap-2 text-sm", done.ok ? "text-emerald-600" : "text-red-600")}>
					{done.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />} {done.ok ? "登录成功" : `登录失败：${done.error}`}
				</div>
			)}
		</div>
	);
}

export function ProviderSetup({ provider, onConfigured }: { provider: Provider; onConfigured: () => void }) {
	const [method, setMethod] = useState<"api_key" | "oauth" | null>(null);
	const [nonce, setNonce] = useState(0);
	if (provider.id === "mock")
		return (
			<div className="flex items-center gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
				<Sparkles size={16} /> Mock 模型无需登录，仅用于本地测试。
			</div>
		);
	return (
		<div className="space-y-3">
			{provider.configured && (
				<div className="flex items-center gap-2 text-sm text-emerald-600">
					<CheckCircle2 size={16} /> 已配置（{provider.source === "stored" ? "已保存的凭据" : (provider.source ?? "环境")}）
					<Button size="sm" variant="ghost" className="ml-auto" onClick={async () => (await api("/api/models/logout", { method: "POST", json: { provider: provider.id } }), onConfigured())}>
						<LogOut size={14} /> 退出登录
					</Button>
				</div>
			)}
			<div className="flex flex-wrap gap-2">
				{provider.apiKey && (
					<Button variant={method === "api_key" ? "primary" : "outline"} onClick={() => (setMethod("api_key"), setNonce(nonce + 1))}>
						<KeyRound size={15} /> {provider.apiKey.name}
					</Button>
				)}
				{provider.oauth && (
					<Button variant={method === "oauth" ? "primary" : "outline"} onClick={() => (setMethod("oauth"), setNonce(nonce + 1))}>
						<Sparkles size={15} /> {provider.oauth.loginLabel ?? `使用 ${provider.oauth.name} 登录`}
					</Button>
				)}
			</div>
			{method && <LoginFlow key={nonce} provider={provider} type={method} onDone={(ok) => ok && onConfigured()} />}
		</div>
	);
}

/** 默认使用：一个按钮同时设「默认模型」和「新助理的思考强度」，复用输入栏同一个模型菜单（搜索 / 常用 / 按渠道折叠） */
export function DefaultModelPicker({ providerId, onSaved, compact }: { providerId?: string; onSaved?: () => void; compact?: boolean }) {
	const system = useStore((s) => s.system);
	const d = useConfiguredModels();
	const [thinking, setThinking] = useState<string | null>(null);
	const [test, setTest] = useState<{ ok: boolean; message: string; detail?: string } | "running" | null>(null);
	// 「最后一次为准」守卫：A→B 连点时 A 的迟到失败不把 B 的新选择回滚；卸载 / 切走时作废在飞响应。
	const saves = useRef(new LatestWrite());
	// 回读服务端真值：只有仍是最新一次才落地（失败回滚也落到它，不用未确认的乐观值当真相）。
	const readThinking = useCallback(async () => {
		const id = saves.current.begin();
		try {
			const x = await api<{ thinking: string }>("/api/models/defaults");
			if (!saves.current.isCurrent(id)) return;
			saves.current.confirm(id, x.thinking);
			setThinking(x.thinking);
		} catch {
			// 读不到就维持现状（不改动界面），下次保存 / 进来再对齐
		}
	}, []);
	useEffect(() => {
		void readThinking();
		const guard = saves.current;
		return () => guard.invalidate();
	}, [readThinking]);
	const cur = system?.defaultModel ?? null;
	const models = (d?.models ?? []).filter((m) => !providerId || m.provider === providerId);
	const entry = models.find((m) => m.provider === cur?.provider && m.id === cur?.id);
	const levels = entry?.thinking ?? [];
	const curThinking = thinking && levels.includes(thinking) ? thinking : levels[0];
	const saveModel = async (m: { provider: string; id: string }) => {
		await api("/api/models/default", { method: "PUT", json: { provider: m.provider, model: m.id } });
		await useStore.getState().loadSystem();
		await useStore.getState().loadAgents();
		onSaved?.();
	};
	const saveThinking = async (l: string) => {
		const id = saves.current.begin();
		setThinking(l);
		try {
			await api("/api/models/default", { method: "PUT", json: { thinking: l } });
			saves.current.confirm(id, l);
		} catch {
			// 迟到的失败：用户已经又选了别的，不回滚、不覆盖新选择（旧 success 也不会盖新失败）
			const r = saves.current.fail(id);
			if (!r.rollback) return;
			// 仍是最新一次：先回落到服务端确认过的值（不留假值），再回读一次服务端真值
			setThinking(r.value);
			await readThinking();
		}
	};
	const text = `${entry ? modelLabel(entry) : cur ? `${cur.provider} / ${cur.id}` : "选择默认模型"}${levels.length > 1 ? ` · ${THINKING_LABEL[curThinking] ?? curThinking}` : ""}`;
	return (
		<div className="space-y-2" data-testid="default-model">
			<div className="flex flex-wrap items-center gap-2">
				<ModelPickerButton
					testid="default-model-picker"
					id="default-model"
					models={models}
					providers={d?.providers ?? []}
					value={cur}
					thinking={levels.length > 1 ? { levels, current: curThinking, onPick: (l) => { if (l) void saveThinking(l); } } : null}
					onPick={(m) => void saveModel(m)}
					text={text}
					placement="down"
					onOpen={d.reload}
					loading={d.loading}
					buttonClass="max-w-full"
					title="选择默认模型和新助理的思考强度"
					ariaLabel={`默认使用：${text}`}
				/>
				<Button variant="outline" size="sm" disabled={!cur || test === "running"} onClick={async () => (setTest("running"), setTest(await api("/api/models/test", { method: "POST", json: { provider: cur!.provider, model: cur!.id } })))}>
					{test === "running" ? <Loader2 size={14} className="animate-spin" /> : null} 测试连接
				</Button>
			</div>
			{!compact && <div className="text-xs text-mut">{cur ? `当前：${modelLabel(cur)}${levels.length > 1 ? ` · 思考 ${THINKING_LABEL[curThinking] ?? curThinking}` : ""}` : "还没有设置默认模型"}</div>}
			{!compact && <div className="text-xs text-mut">模型不支持的思考档位会自动就近调整；每个助理可以在输入框下方单独切换。</div>}
			{test && test !== "running" && (
				<div className={cx("flex items-start gap-2 rounded-lg p-2 text-sm", test.ok ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40" : "bg-red-50 text-red-700 dark:bg-red-950/40")}>
					{test.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <XCircle size={16} className="mt-0.5 shrink-0" />}
					<span className="break-all">{test.ok ? `连接成功：${test.message}` : test.message}{!test.ok && (test.detail ? <Help className="ml-1">服务返回的原文：{test.detail}</Help> : null)}</span>
				</div>
			)}
		</div>
	);
}
