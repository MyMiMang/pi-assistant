/**
 * 图片生成模型：设置 › 模型 里的「图片生成」小节（添加服务、自动获取 / 识别图片模型、试生成、默认模型），
 * 以及助理设置里的「图片模型」选择（跟随默认 / 指定 / 关闭）。
 */
import { Download, ImageIcon, Loader2, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Button, cx, ErrorBox, Help, Input, useConfirm } from "./ui";

type Kind = "openai" | "dashscope" | "ark" | "gemini" | "xai";
interface KindInfo { kind: Kind; label: string; baseUrl: string; models: string[]; keyUrl?: string; note?: string }
export interface ImgProvider { id: string; name: string; kind: Kind; kindLabel: string; baseUrl: string; models: string[]; keyFrom?: string | null; hasKey: boolean }
interface ImgModel { provider: string; providerName: string; id: string; edit: boolean; cost: string | null }
export interface ImageModelsData { kinds: KindInfo[]; providers: ImgProvider[]; models: ImgModel[]; default: { provider: string; model: string; label: string } | null; reusable: { id: string; name: string; baseUrl: string; api: string }[] }

const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 图片生成目录（服务 / 模型 / 默认模型）。
 * 初版 `void reload()` 没有 catch：目录接口一失败就是未处理拒绝 + 永久 loading，界面只能靠猜。
 * 现在把「这一次还在读」「这一次读失败（带原因）」「最近一次成功的数据」分开；刷新失败保留上次数据，不把已显示的目录清空。
 */
export function useImageModels() {
	const [data, setData] = useState<ImageModelsData | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	// 请求代次：只认最后一次，卸载后不再 setState
	const gen = useRef(0);
	useEffect(() => () => { gen.current++; }, []);
	const reload = useCallback(() => {
		const token = ++gen.current;
		setLoading(true);
		return api<ImageModelsData>("/api/image-models")
			.then((v) => {
				if (token !== gen.current) return;
				setData(v);
				setError("");
			})
			.catch((e) => {
				if (token !== gen.current) return;
				setError(msgOf(e));
			})
			.finally(() => {
				if (token === gen.current) setLoading(false);
			});
	}, []);
	useEffect(() => {
		void reload();
	}, [reload]);
	return { data, reload, loading, error };
}
const key = (m: { provider: string; model?: string; id?: string }) => `${m.provider}::${m.model ?? m.id}`;

/** 按服务分组的图片模型选项（显示“服务名 / 模型”） */
function Options({ models }: { models: ImgModel[] }) {
	const groups = new Map<string, ImgModel[]>();
	for (const m of models) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
	return (
		<>
			{[...groups.values()].map((ms) => (
				<optgroup key={ms[0].provider} label={ms[0].providerName}>
					{ms.map((m) => (
						<option key={key(m)} value={key(m)}>
							{ms[0].providerName} / {m.id}
						</option>
					))}
				</optgroup>
			))}
		</>
	);
}

const selectCls = "h-9 w-full min-w-0 rounded-lg border border-line bg-transparent px-2 text-sm";

/** 图片生成服务表单：统一模型面板用它编辑 / 新建生图适配器（复用同一个服务 Key 时传 keyFrom）。 */
export function ImageProviderForm({ data, initial, onDone, onCancel }: { data: ImageModelsData; initial?: ImgProvider; onDone: () => void; onCancel: () => void }) {
	const [kind, setKind] = useState<Kind>(initial?.kind ?? "openai");
	const info = data.kinds.find((k) => k.kind === kind)!;
	const [name, setName] = useState(initial?.name ?? "");
	const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? info.baseUrl);
	const [apiKey, setApiKey] = useState("");
	const [keyFrom, setKeyFrom] = useState(initial?.keyFrom ?? "");
	const [models, setModels] = useState<string[]>(initial?.models ?? []);
	const [manual, setManual] = useState("");
	const [fetched, setFetched] = useState<{ image: string[]; all: string[] } | null>(null);
	const [busy, setBusy] = useState("");
	const [err, setErr] = useState("");
	const [test, setTest] = useState<{ model: string; ok: boolean; preview?: string; ms?: number; error?: string } | null>(null);
	const [confirmUi, confirm] = useConfirm();
	// 试生成会先保存；之后再点保存就是更新同一个（不重复创建）
	const [savedId, setSavedId] = useState(initial?.id);
	const pickKind = (k: Kind) => {
		const ni = data.kinds.find((x) => x.kind === k)!;
		setKind(k);
		setBaseUrl(ni.baseUrl);
		setFetched(null);
		if (k !== "openai") setKeyFrom("");
	};
	const reuse = (id: string) => {
		setKeyFrom(id);
		const r = data.reusable.find((x) => x.id === id);
		if (r) (setKind("openai"), setBaseUrl(r.baseUrl), !name && setName(r.name));
	};
	const toggle = (m: string) => setModels((l) => (l.includes(m) ? l.filter((x) => x !== m) : [...l, m]));
	const fetchModels = async () => {
		setBusy("fetch");
		setErr("");
		try {
			const r = await api("/api/image-models/fetch-models", { method: "POST", json: { id: savedId, kind, baseUrl, apiKey: apiKey || undefined, keyFrom: keyFrom || undefined } });
			if (!r.ok) setErr(`${r.error}（可以直接从下面的常用模型里选）\n${r.detail ?? ""}`);
			else {
				setFetched(r);
				// 自动勾上识别出的图片模型（一个都没选时）
				if (!models.length && r.image.length) setModels(r.image.slice(0, 3));
				if (!r.image.length) setErr("没有识别出图片生成模型，可手动输入模型名");
			}
		} finally {
			setBusy("");
		}
	};
	const save = async () => {
		setBusy("save");
		setErr("");
		try {
			const body = { kind, name, baseUrl, apiKey: apiKey || undefined, keyFrom: keyFrom || null, models };
			const p = await api(savedId ? `/api/image-models/providers/${savedId}` : "/api/image-models/providers", { method: savedId ? "PUT" : "POST", json: body });
			setSavedId(p.id);
			return p;
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
			return null;
		} finally {
			setBusy("");
		}
	};
	const runTest = async (model: string) => {
		const p = await save();
		if (!p) return;
		setBusy(`test:${model}`);
		setTest(null);
		try {
			const r = await api("/api/image-models/test", { method: "POST", json: { provider: p.id, model } });
			setTest({ model, ...r, error: r.ok ? undefined : `${r.error}\n${r.detail ?? ""}` });
		} finally {
			setBusy("");
		}
	};
	const remove = async () => {
		if (!initial || !(await confirm({ title: `删除「${initial.name}」？`, body: "助理将不能再用这个服务画图。", ok: "删除", danger: true }))) return;
		await api(`/api/image-models/providers/${initial.id}`, { method: "DELETE" });
		onDone();
	};
	const list = fetched?.image ?? [];
	const presets = info.models.filter((m) => !list.includes(m));
	return (
		<div className="space-y-4" data-testid="image-provider-form">
			{confirmUi}
			<div className="flex items-center gap-2">
				<Button size="sm" variant="ghost" onClick={onCancel}>
					← 返回
				</Button>
				<div className="font-medium">{initial ? "编辑图片生成服务" : "添加图片生成服务"}</div>
			</div>
			<div className="space-y-1.5">
				<div className="text-xs text-mut">服务类型</div>
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
					{data.kinds.map((k) => (
						<button key={k.kind} type="button" data-kind={k.kind} onClick={() => pickKind(k.kind)} className={cx("min-w-0 rounded-xl border p-2.5 text-left text-sm whitespace-normal", kind === k.kind ? "border-accent bg-accent-soft" : "border-line hover:border-accent")}>
							<div className="truncate font-medium">{k.label}</div>
							{k.note && <div className="mt-0.5 text-[11px] text-mut [overflow-wrap:anywhere]">{k.note}</div>}
						</button>
					))}
				</div>
			</div>
			{kind === "openai" && data.reusable.length > 0 && (
				<label className="block space-y-1.5">
					<span className="text-xs text-mut">复用已添加的自定义服务（同一个中转站，不用再填 Key）</span>
					<select className={selectCls} value={keyFrom} onChange={(e) => (e.target.value ? reuse(e.target.value) : setKeyFrom(""))} data-testid="image-reuse">
						<option value="">不复用，单独填写</option>
						{data.reusable.map((r) => (
							<option key={r.id} value={r.id}>
								{r.name}（{r.baseUrl}）
							</option>
						))}
					</select>
				</label>
			)}
			<label className="block space-y-1.5">
				<span className="text-xs text-mut">名称</span>
				<Input value={name} placeholder={info.label.replace(/（.*$/, "")} onChange={(e) => setName(e.target.value)} data-testid="image-name" />
			</label>
			<label className="block space-y-1.5">
				<span className="text-xs text-mut">Base URL</span>
				<Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} data-testid="image-base-url" />
			</label>
			{!keyFrom && (
				<label className="block space-y-1.5">
					<span className="flex items-center gap-2 text-xs text-mut">
						API Key
						{info.keyUrl && (
							<a className="text-accent underline" href={info.keyUrl} target="_blank" rel="noreferrer">
								去获取
							</a>
						)}
					</span>
					<Input type="password" autoComplete="off" value={apiKey} placeholder={initial?.hasKey ? "留空 = 保持原来的 Key" : "粘贴到这里"} onChange={(e) => setApiKey(e.target.value)} data-testid="image-key" />
				</label>
			)}
			<div className="space-y-2">
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-xs text-mut">图片模型</span>
					<Button size="sm" variant="outline" onClick={fetchModels} disabled={!!busy} data-testid="image-fetch">
						{busy === "fetch" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} 自动获取
					</Button>
				</div>
				<div className="flex flex-wrap gap-1.5">
					{[...new Set([...models, ...list, ...presets])].map((m) => (
						<button key={m} type="button" onClick={() => toggle(m)} data-model={m} className={cx("max-w-full truncate rounded-full border px-2.5 py-1 text-xs", models.includes(m) ? "border-accent bg-accent-soft text-accent" : "border-line text-mut hover:border-accent")}>
							{models.includes(m) ? "✓ " : "+ "}
							{m}
						</button>
					))}
				</div>
				<form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), manual.trim() && (toggle(manual.trim()), setManual("")))}>
					<Input value={manual} placeholder="手动输入模型名，回车添加" onChange={(e) => setManual(e.target.value)} data-testid="image-manual" />
				</form>
			</div>
			{models.length > 0 && (
				<div className="space-y-1.5">
					<div className="text-xs text-mut">试生成一张（会真实调用一次，按服务商价格计费）</div>
					<div className="flex flex-wrap gap-1.5">
						{models.map((m) => (
							<Button key={m} size="sm" variant="outline" disabled={!!busy} onClick={() => void runTest(m)} data-testid="image-test">
								{busy === `test:${m}` ? <Loader2 size={14} className="animate-spin" /> : <ImageIcon size={14} />} {m}
							</Button>
						))}
					</div>
					{busy.startsWith("test:") && <div className="text-xs text-mut">正在生成，可能要几十秒…</div>}
					{test?.ok && (
						<div className="flex items-center gap-3 text-xs text-emerald-600" data-testid="image-test-ok">
							<img src={test.preview} alt="测试图片" className="h-20 w-20 rounded-lg border border-line object-cover" />
							<span>
								{test.model} 可以用（{Math.round((test.ms ?? 0) / 100) / 10} 秒）
							</span>
						</div>
					)}
					{test && !test.ok && <ErrorBox text={test.error ?? "失败"} />}
				</div>
			)}
			{err && <ErrorBox text={err} />}
			<div className="flex flex-wrap gap-2">
				<Button
					disabled={!!busy || !models.length}
					onClick={async () => {
						if (await save()) onDone();
					}}
					data-testid="image-save"
				>
					{busy === "save" && <Loader2 size={14} className="animate-spin" />} 保存
				</Button>
				<Button variant="ghost" onClick={onCancel}>
					<X size={14} /> 取消
				</Button>
				{initial && (
					<Button variant="ghost" className="ml-auto text-red-500" onClick={remove} data-testid="image-delete">
						<Trash2 size={14} /> 删除
					</Button>
				)}
			</div>
		</div>
	);
}

type ImageChoice = { mode: string; provider?: string; model?: string };

/** 助理设置：这个助理用哪个图片模型（收起时显示真实当前选择，展开后保留全部原选项） */
export function AgentImageModel({ agentId }: { agentId: string }) {
	const { data, reload, loading: catalogLoading, error: catalogErr } = useImageModels();
	// 已保存 / 服务端确认过的选择。读取中、读取失败、保存中、保存失败各占一份状态，不共用一个 err 互相盖
	const [choice, setChoice] = useState<ImageChoice | null>(null);
	const [choiceLoading, setChoiceLoading] = useState(true);
	const [loadErr, setLoadErr] = useState("");
	const [saveErr, setSaveErr] = useState("");
	const [saving, setSaving] = useState(false);
	const savingRef = useRef(false);
	// 代次：切助理 / 卸载时作废在飞读写；最近一次操作说了算，晚到的旧响应不覆盖新选择
	const seq = useRef(0);
	const confirmed = useRef<ImageChoice>({ mode: "default" });
	const loadChoice = useCallback(() => {
		const gen = ++seq.current;
		setChoiceLoading(true);
		setLoadErr("");
		void api<{ choice: ImageChoice }>(`/api/agents/${agentId}/image-model`)
			.then((r) => {
				if (gen !== seq.current) return;
				const c = r?.choice ?? { mode: "default" };
				confirmed.current = c;
				setChoice(c);
				setChoiceLoading(false);
			})
			.catch((e) => {
				if (gen !== seq.current) return;
				// 读不到就不拿「跟随默认」冒充真实选择
				setChoice(null);
				setLoadErr(`读取失败：${msgOf(e)}`);
				setChoiceLoading(false);
			});
	}, [agentId]);
	useEffect(() => {
		seq.current++;
		savingRef.current = false;
		setSaving(false);
		setSaveErr("");
		setChoice(null);
		loadChoice();
		return () => {
			seq.current++;
		};
	}, [loadChoice]);
	const retry = () => {
		void reload();
		loadChoice();
	};
	const picked = data && choice?.mode === "model" ? data.models.find((x) => x.provider === choice.provider && x.id === choice.model) : undefined;
	const summary = loadErr
		? "读取失败"
		: !choice || choiceLoading
			? "正在读取…"
			: choice.mode === "off"
				? "不画图"
				: choice.mode === "default"
					? `跟随全局默认${data?.default ? `（${data.default.label}）` : ""}`
					: `${picked?.providerName ?? choice.provider ?? ""} · ${picked?.id ?? choice.model ?? ""}`;
	// 保存中：摘要把「保存中」写在后面，不把乐观值当成已保存的结论
	const shown = saving ? `${summary} · 保存中…` : saveErr ? `${summary} · 保存失败，展开重试` : catalogErr ? `${summary} · 模型列表读取失败` : summary;
	const set = async (v: string) => {
		if (!choice || choiceLoading || savingRef.current) return;
		const m = data?.models.find((x) => key(x) === v);
		const next: ImageChoice = m ? { mode: "model", provider: m.provider, model: m.id } : { mode: v === "off" ? "off" : "default" };
		const gen = ++seq.current;
		savingRef.current = true;
		setSaving(true);
		setSaveErr("");
		setChoice(next); // 乐观，但成功与否以服务端为准
		try {
			await api(`/api/agents/${agentId}/image-model`, { method: "PUT", json: next });
			if (gen !== seq.current) return;
			// 服务端 PUT 只回 {ok:true}：保存后再 GET 一次拿它真正落库的 choice；读回失败不算保存失败
			let real = next;
			try {
				const r = await api<{ choice: ImageChoice }>(`/api/agents/${agentId}/image-model`);
				if (r?.choice) real = r.choice;
			} catch {
				/* 已保存成功，只是读回失败：用刚写入的值，不把成功显示成失败 */
			}
			if (gen !== seq.current) return;
			confirmed.current = real;
			setChoice(real);
		} catch (e) {
			if (gen !== seq.current) return;
			// 失败回滚到服务端确认过的值，错误留在界面上，不用乐观值冒充已保存
			setChoice(confirmed.current);
			setSaveErr(`保存失败，已恢复原选择：${msgOf(e)}`);
		} finally {
			if (gen === seq.current) {
				savingRef.current = false;
				setSaving(false);
			}
		}
	};
	const value = choice?.mode === "model" ? key({ provider: choice.provider!, model: choice.model }) : (choice?.mode ?? "default");
	// 已保存的模型不在当前目录里（服务被删 / 被改名）：仍把真实保存值显示出来，不假装是别的选项
	const savedMissing = choice?.mode === "model" && !picked;
	const canPickModel = !!data && data.models.length > 0;
	return (
		<details className="pa-info-details" data-testid="agent-image-details">
			<summary>
				画图模型
				<small>让它画图时用哪个模型 · {shown}</small>
			</summary>
			<div className="pa-info-details-body">
				<section className="space-y-1.5" data-testid="agent-image-model">
					<div className="flex items-center gap-1.5 text-sm font-semibold">
						图片模型<Help>你让它画图、改图时用这个模型。选「不画图」后这个助理就没有画图工具。</Help>
					</div>
					{loadErr ? (
						<div className="flex flex-wrap items-center gap-2 text-xs text-red-500" data-testid="agent-image-load-error">
							<span className="min-w-0 [overflow-wrap:anywhere]">{loadErr}</span>
							<Button size="sm" variant="outline" onClick={retry} data-testid="agent-image-retry">
								重试
							</Button>
						</div>
					) : !choice || choiceLoading ? (
						<div className="text-xs text-mut" role="status">
							正在读取这个助理的画图设置…
						</div>
					) : (
						<>
							{/* 目录没读出来 / 还没读到时候选项仍保留「跟随默认」「不画图」：已保存 off 的助理能改回跟随 */}
							<select className={selectCls} value={value} onChange={(e) => void set(e.target.value)} disabled={saving} data-testid="agent-image-select" aria-label="画图模型">
								<option value="default">跟随默认{data?.default ? `（${data.default.label}）` : ""}</option>
								{canPickModel && <Options models={data!.models} />}
								{savedMissing && (
									<option value={key({ provider: choice.provider ?? "", model: choice.model })}>
										{choice.provider} / {choice.model}（已保存，当前列表里没有）
									</option>
								)}
								<option value="off">不画图</option>
							</select>
							{catalogErr ? (
								<div className="flex flex-wrap items-center gap-2 text-xs text-red-500" data-testid="agent-image-catalog-error">
									<span className="min-w-0 [overflow-wrap:anywhere]">图片模型列表没读出来：{catalogErr}。仍可先选「跟随默认」或「不画图」。</span>
									<Button size="sm" variant="outline" onClick={() => void reload()}>
										重试
									</Button>
								</div>
							) : catalogLoading && !data ? (
								<div className="text-xs text-mut" role="status">
									正在读取图片模型列表…
								</div>
							) : !canPickModel ? (
								<div className="text-xs text-mut">还没有配置图片模型，去 设置 › 模型 › 图片生成 添加。</div>
							) : null}
						</>
					)}
					{saveErr && (
						<div className="min-w-0 text-xs text-red-500 [overflow-wrap:anywhere]" role="alert" data-testid="agent-image-save-error">
							{saveErr}
						</div>
					)}
				</section>
			</div>
		</details>
	);
}
