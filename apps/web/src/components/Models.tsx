/**
 * 模型配置组件：provider 列表、登录流程、默认模型选择与连接测试。
 * 全部数据来自服务端的 Pi provider 目录，Pi 新增 provider/登录方式时这里自动支持。
 */
import { CheckCircle2, Copy, ExternalLink, KeyRound, Loader2, LogOut, Search, Sparkles, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { ModelInfo, Provider } from "../types";
import { Badge, Button, cx, Input } from "./ui";

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
						className={cx("rounded-xl border p-3 text-left transition hover:border-accent", selected === p.id ? "border-accent bg-accent-soft" : "border-zinc-200 dark:border-zinc-800")}
					>
						<div className="flex items-center gap-2">
							<span className="truncate text-sm font-medium">{p.id === "mock" ? "Mock 模型（本地测试）" : p.name}</span>
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

/** 通用登录流程：渲染 Pi 发来的 prompt / auth_url / device_code / progress 事件。 */
export function LoginFlow({ provider, type, onDone }: { provider: Provider; type: "api_key" | "oauth"; onDone: (ok: boolean) => void }) {
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
									<Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(ev.url)}>
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

export function DefaultModelPicker({ providerId, onSaved }: { providerId?: string; onSaved?: () => void }) {
	const system = useStore((s) => s.system);
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [sel, setSel] = useState(system?.defaultModel ? `${system.defaultModel.provider}/${system.defaultModel.id}` : "");
	const [test, setTest] = useState<{ ok: boolean; message: string } | "running" | null>(null);
	useEffect(() => {
		Promise.all([api<Provider[]>("/api/models/providers"), api<ModelInfo[]>(`/api/models${providerId ? `?provider=${providerId}` : ""}`)]).then(([ps, ms]) => {
			const ok = new Set(ps.filter((p) => p.configured).map((p) => p.id));
			const list = ms.filter((m) => ok.has(m.provider));
			setModels(list);
			if (!sel || !list.some((m) => `${m.provider}/${m.id}` === sel)) if (list[0]) setSel(`${list[0].provider}/${list[0].id}`);
		});
	}, [providerId]);
	const split = () => {
		const [provider, ...rest] = sel.split("/");
		return { provider, model: rest.join("/") };
	};
	return (
		<div className="space-y-3">
			<select value={sel} onChange={(e) => (setSel(e.target.value), setTest(null))} className="h-10 w-full rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
				{models.length === 0 && <option value="">（先登录一个模型服务）</option>}
				{models.map((m) => (
					<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
						{m.provider} / {m.name}
					</option>
				))}
			</select>
			<div className="flex flex-wrap items-center gap-2">
				<Button variant="outline" disabled={!sel || test === "running"} onClick={async () => (setTest("running"), setTest(await api("/api/models/test", { method: "POST", json: split() })))}>
					{test === "running" ? <Loader2 size={14} className="animate-spin" /> : null} 测试连接
				</Button>
				<Button variant="primary" disabled={!sel} onClick={async () => (await api("/api/models/default", { method: "PUT", json: split() }), await useStore.getState().loadSystem(), await useStore.getState().loadAgents(), onSaved?.())}>
					设为默认模型
				</Button>
			</div>
			{test && test !== "running" && (
				<div className={cx("flex items-start gap-2 rounded-lg p-2 text-sm", test.ok ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40" : "bg-red-50 text-red-700 dark:bg-red-950/40")}>
					{test.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <XCircle size={16} className="mt-0.5 shrink-0" />}
					<span className="break-all">{test.ok ? `连接成功：${test.message}` : test.message}</span>
				</div>
			)}
		</div>
	);
}
