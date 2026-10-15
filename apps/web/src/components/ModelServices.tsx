/**
 * 统一模型服务（原型 → 接 API）。
 * 设计见 docs/design/model-settings-unified.md；契约对齐：
 *  - registry agent：`GET /api/models/registry` → `{ providers: RegistryProvider[] }`（packages/server/src/model-registry.ts）
 *  - benchmark agent：`GET/POST /api/fast-computer/benchmark`、`GET /:id`、`POST /:id/cancel`（fast-computer/benchmark.ts）
 * 一个服务 = 一份 baseUrl + 一份凭据，可同时含 chat / vision / image / classifier；生图与快速操作不再单独配凭据。
 * 能力只按可靠来源；猜出来的标「未确认」。本文件先纯前端原型：接口未就绪时可「预览原型」用示例数据走完整交互。
 */
import { Activity, AlertTriangle, Check, CheckCircle2, ChevronDown, Cpu, Download, Gauge, Loader2, Monitor, Pause, Play, Plus, RotateCcw, Search, ShieldCheck, Square, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { PROVIDER_ICONS } from "./provider-icons";
import type { BenchmarkAvailability, FastBenchmarkResult, LocalRuntimeDto, ModelCapability, ModelType, PhaseDto, RegistryModel, RegistryProvider } from "../types";
import { Badge, Button, cx, Fold, Help, Input, Modal, Select, useConfirm } from "./ui";

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
/** 服务图标：官方用品牌 logo；自定义 / 本地 / 生图 / 未收录品牌用「首字母 + 稳定配色」字母头像。 */
function ServiceIcon({ provider }: { provider: RegistryProvider }) {
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
			{capabilities.map((c) => {
				const guess = inferred.includes(c);
				return (
					<Badge key={c} tone={guess ? "zinc" : CAP_TONE[c]}>
						{CAP_LABEL[c]}
						{guess ? "？" : ""}
					</Badge>
				);
			})}
			{!capabilities.length && <span className="text-[11px] text-mut2">能力未知</span>}
		</span>
	);
}

/** 能力纠正：多选 checkbox，保存后按「用户显式配置」记可靠来源。 */
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
			<div className="text-[11px] text-mut2">不确定时也可以不选：不影响保存，助理不会据此自动决策。保存后来源记为「你手动设置」，覆盖推断结果。</div>
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

/** 模型行：id + 类型 + 能力标签 + 「能力」纠正；分类器行带「实际操作测试」。 */
function ModelRow({ model, onSave, onBenchmark }: { model: RegistryModel; onSave: (caps: ModelCapability[]) => void; onBenchmark?: (m: RegistryModel) => void }) {
	const [edit, setEdit] = useState(false);
	return (
		<div className="px-2.5 py-1.5" data-testid="service-model" data-model={model.id} data-type={model.type}>
			<div className="flex items-center gap-2 text-xs">
				<span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-[11px] text-mut">{TYPE_LABEL[model.type]}</span>
				<span className="min-w-0 flex-1 truncate font-mono" title={model.id}>
					{model.id}
				</span>
				<CapabilityChips capabilities={model.capabilities} inferred={model.inferred} testId="model-caps" />
				<button className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-mut2 hover:bg-hover hover:text-fg" onClick={() => setEdit(!edit)} aria-expanded={edit} data-testid="model-capability-toggle">
					能力
				</button>
			</div>
			{model.type === "image" && (
				<div className="mt-1 flex flex-wrap gap-1 text-[11px] text-mut2">
					{model.imageAdapter && <span data-testid="image-adapter">生图适配：{model.imageAdapter.kind} · {model.imageAdapter.edit ? "支持改图" : "不支持改图"}</span>}
					{model.costNote && <span>· {model.costNote}</span>}
				</div>
			)}
			{model.type === "classifier" && onBenchmark && (
				<div className="mt-1.5">
					<Button size="sm" variant="outline" onClick={() => onBenchmark(model)} data-testid={`benchmark-open-${model.id}`}>
						<Monitor size={13} /> 实际操作测试
					</Button>
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

const PHASE_LABEL: Record<string, string> = { env: "环境", weights: "权重", verify: "校验" };
function PhaseBar({ name, phase }: { name: string; phase: PhaseDto }) {
	const done = phase.state === "done";
	return (
		<div className="flex items-center gap-2 text-[11px]" data-testid={`phase-${name}`} data-phase-state={phase.state}>
			<span className="w-8 shrink-0 text-mut">{PHASE_LABEL[name]}</span>
			<div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-hover">
				<div className={cx("h-full rounded-full transition-all", phase.state === "error" ? "bg-red-500" : done ? "bg-emerald-500" : "bg-accent")} style={{ width: `${Math.max(0, Math.min(100, phase.percent))}%` }} />
			</div>
			<span className="w-24 shrink-0 text-right text-mut2">{done ? "完成" : phase.state === "error" ? phase.error ?? "失败" : `${Math.round(phase.percent)}%`}</span>
		</div>
	);
}

/** 本地运行时（Laya）：安装进度 / cancel / resume / retry / stop / 卸载确认；health 用实际探测标签，不是安装时猜。 */
function LocalRuntimeCard({ provider, onChange }: { provider: RegistryProvider; onChange: (r: LocalRuntimeDto) => void }) {
	const local = provider.local;
	const [dlg, ask] = useConfirm();
	const [busy, setBusy] = useState<string | null>(null);
	if (!local) return null;
	const p = local.platform;
	const call = async (path: string, method = "POST") => {
		setBusy(path);
		try {
			onChange(await api<LocalRuntimeDto>(`/api/model-services/${provider.id}/local${path}`, { method }));
		} catch {
			/* 原型：接口未就绪时忽略，状态由父级 demo 逻辑推进 */
		} finally {
			setBusy(null);
		}
	};
	const uninstall = async () => {
		if (!(await ask({ title: "卸载本地 Laya？", body: "会删除已下载的环境与权重，之后需要重新下载。不影响你的模型服务与其它设置。", ok: "卸载", danger: true }))) return;
		await call("", "DELETE");
	};
	const installing = local.ready === "installing";
	return (
		<div className="space-y-3 rounded-xl border border-line p-3" data-testid="local-runtime" data-ready={local.ready}>
			{dlg}
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<span data-testid="local-ready">
					<Badge tone={local.ready === "offline_ready" || local.ready === "ready" ? "green" : local.ready === "error" ? "red" : "zinc"}>
						{local.ready === "not_installed" ? "未安装" : local.ready === "installing" ? "安装中" : local.ready === "offline_ready" ? "离线可用" : local.ready === "ready" ? "就绪" : local.ready === "error" ? "出错" : "已停止"}
					</Badge>
				</span>
				<span className="text-mut" data-testid="platform-support" data-support={p.support}>
					平台：{p.os} / {p.arch} · {p.support === "baseline" ? "支持" : p.support === "conditional" ? "有条件支持" : p.support === "experimental" ? "实验性" : "不支持"}
				</span>
				{p.support === "unsupported" && (
					<span className="flex items-center gap-1 text-amber-600" data-testid="platform-note">
						<AlertTriangle size={12} /> {p.note || "此平台暂不支持本地 Laya，不假装成功"}
					</span>
				)}
			</div>
			{(installing || local.phases.env.state !== "idle") && (
				<div className="space-y-1.5">
					<PhaseBar name="env" phase={local.phases.env} />
					<PhaseBar name="weights" phase={local.phases.weights} />
					<PhaseBar name="verify" phase={local.phases.verify} />
				</div>
			)}
			{local.health && (
				<div className="flex flex-wrap items-center gap-2 text-[11px] text-mut" data-testid="local-health">
					<span className="flex items-center gap-1">
						<Cpu size={12} /> CPU：{local.health.cpu.label}（基线）
					</span>
					<span className="flex items-center gap-1" data-testid="local-gpu" data-gpu-backend={local.health.gpu.backend} data-gpu-available={String(local.health.gpu.available)}>
						<Gauge size={12} /> GPU：{local.health.gpu.available ? local.health.gpu.label : "不可用"}（实际探测）
					</span>
					<span className="text-mut2">检测于 {new Date(local.health.checkedAt).toLocaleTimeString("zh-CN")}</span>
				</div>
			)}
			<div className="flex flex-wrap gap-2">
				{local.ready === "not_installed" && (
					<Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void call("/install")} data-testid="local-install">
						<Download size={14} /> 一键下载（自动地址，无需填 Key）
					</Button>
				)}
				{installing && (
					<>
						<Button size="sm" variant="outline" onClick={() => void call(`/install/${local.taskId}/cancel`)} data-testid="local-cancel">
							<Square size={13} /> 取消
						</Button>
						<Button size="sm" variant="outline" onClick={() => void call(`/install/${local.taskId}/stop`)} data-testid="local-stop">
							<Pause size={13} /> 停止
						</Button>
					</>
				)}
				{local.ready === "stopped" && (
					<Button size="sm" variant="primary" onClick={() => void call(`/install/${local.taskId}/resume`)} data-testid="local-resume">
						<Play size={13} /> 继续下载
					</Button>
				)}
				{local.ready === "error" && (
					<Button size="sm" variant="primary" onClick={() => void call(`/install/${local.taskId}/retry`)} data-testid="local-retry">
						<RotateCcw size={13} /> 重试
					</Button>
				)}
				{(local.ready === "ready" || local.ready === "offline_ready") && (
					<>
						<Button size="sm" variant="outline" onClick={() => void call("/health", "GET")} data-testid="local-health-refresh">
							<Activity size={13} /> 重新检测
						</Button>
						<Button size="sm" variant="ghost" onClick={() => void uninstall()} data-testid="local-uninstall">
							<Trash2 size={13} /> 卸载
						</Button>
					</>
				)}
			</div>
		</div>
	);
}

/** 实际操作测试：真实受控 CUA 任务（不是 API 延迟）。渲染 FastBenchmarkResult，不另定义结果结构。 */
function BenchmarkDialog({ open, onClose, provider, model }: { open: boolean; onClose: () => void; provider: RegistryProvider; model: RegistryModel }) {
	const [target, setTarget] = useState<"assistant" | "host">("assistant");
	const [ack, setAck] = useState(false);
	const [availability, setAvailability] = useState<BenchmarkAvailability | null>(null);
	const [run, setRun] = useState<FastBenchmarkResult | null>(null);
	const [running, setRunning] = useState(false);
	const [blocked, setBlocked] = useState<string[]>([]);
	const cloud = provider.kind !== "local";
	const costNote = cloud ? "云端分类器：这次测试会产生真实模型调用，可能少量计费。" : "本地运行，无额外费用。";
	useEffect(() => {
		if (!open) return;
		void api<{ availability: BenchmarkAvailability; runs: FastBenchmarkResult[] }>("/api/fast-computer/benchmark")
			.then((r) => {
				setAvailability(r.availability);
				setRun(r.runs?.[0] ?? null);
			})
			.catch(() => {});
	}, [open]);
	const start = async () => {
		setRunning(true);
		setBlocked([]);
		try {
			const r = await api<{ ok: boolean; run: FastBenchmarkResult }>("/api/fast-computer/benchmark", { method: "POST", json: { provider: provider.id, model: model.id, target } });
			setRun(r.run);
			const poll = async (): Promise<FastBenchmarkResult> => {
				const d = await api<FastBenchmarkResult>(`/api/fast-computer/benchmark/${r.run.id}`);
				return d.status === "running" ? (await new Promise((x) => setTimeout(x, 400)), poll()) : d;
			};
			setRun(await poll());
		} catch (e) {
			if (e instanceof ApiError && e.status === 409) setBlocked(["测试环境尚未就绪，先看下面的原因。"]);
			else setBlocked([e instanceof Error ? e.message : "启动失败"]);
		} finally {
			setRunning(false);
		}
	};
	const cancel = () => {
		if (run) void api(`/api/fast-computer/benchmark/${run.id}/cancel`, { method: "POST" }).catch(() => {});
		setRunning(false);
	};
	const adv = run?.advisory;
	const verdictTone = adv?.verdict === "ok" ? "green" : adv?.verdict === "slow" ? "amber" : "red";
	const verdictLabel = adv?.verdict === "ok" ? "建议使用" : adv?.verdict === "slow" ? "偏慢，仍可继续用" : adv?.verdict === "unstable" ? "不稳定，建议排查" : adv?.verdict === "blocked" ? "被阻塞" : "尚未运行";
	return (
		<Modal open={open} onClose={onClose} title="实际操作测试" testId="actual-task-test">
			<div className="space-y-4 p-5">
				<div className="text-sm text-mut">
					这不是测 API 延迟，而是让这个快速模型在<b className="text-fg">专用隔离测试窗口</b>里真实走一遍受控操控（观察 → 候选 → 分类 → 重新点击 → 校验），评估它适不适用。
				</div>
				<div className="rounded-lg bg-hover p-3 text-xs text-mut" data-testid="actual-task-preflight">
					<div className="flex items-center gap-1.5">
						<ShieldCheck size={13} /> 前置条件（启动前校验，不偷偷开）：
					</div>
					<div>· 需要屏幕 / 辅助功能权限、虚拟机或用户电脑就绪，都会先检查并让你确认。</div>
					<div>· 只在专用测试窗口里动作，绝不碰你的真实数据；窗口失焦会中止。</div>
					<div className="flex items-start gap-1.5 text-amber-600">
						<AlertTriangle size={13} className="mt-0.5 shrink-0" /> {costNote}
					</div>
					{availability && (
						<div className="mt-1" data-testid="benchmark-availability">
							就绪状态：CUA {availability.cuaReady ? "✓" : "✗"} · 模型 {availability.modelReady ? "✓" : "✗"} · 测试窗口 {availability.fixtureReady ? "✓" : "✗"}
							{availability.reasons?.length ? <div className="text-amber-600">· {availability.reasons.join("；")}</div> : null}
						</div>
					)}
				</div>
				<div className="rounded-lg border border-dashed border-line p-2.5 text-[11px] text-mut2" data-testid="benchmark-unverified-note">
					真实执行尚未验证：开发环境的 runner 是 fake，<b>不等于 CUA 成功</b>；下面结果只作参考，样本少时结论有限。
				</div>
				{!running && (
					<>
						<div className="space-y-1.5">
							<div className="text-xs font-medium">测试电脑</div>
							<Select
								value={target}
								ariaLabel="测试电脑"
								testId="actual-task-target"
								options={[
									{ value: "assistant", label: "助理电脑（虚拟机）" },
									{ value: "host", label: "用户电脑（这台 Mac）" },
								]}
								onChange={(v) => setTarget(v as "assistant" | "host")}
							/>
						</div>
						<label className="flex items-center gap-2 text-xs">
							<input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="actual-task-ack" />
							我知道会打开专用测试窗口，并同意在选定电脑上运行受控任务。
						</label>
						{blocked.length > 0 && <div className="rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300" data-testid="benchmark-blocked">{blocked.join("；")}</div>}
						<div className="flex justify-end gap-2">
							<Button variant="ghost" onClick={onClose}>
								取消
							</Button>
							<Button variant="primary" disabled={!ack || running || availability?.cuaReady === false || availability?.modelReady === false || availability?.fixtureReady === false} onClick={() => void start()} data-testid="actual-task-start">
								{running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} 开始测试
							</Button>
						</div>
					</>
				)}
				{running && (
					<div className="flex items-center justify-between rounded-lg border border-line p-3 text-sm" data-testid="actual-task-running">
						<span className="flex items-center gap-2">
							<Loader2 size={14} className="animate-spin" /> 测试进行中（可取消，取消只释放本次测试资源）
						</span>
						<Button size="sm" variant="outline" onClick={cancel} data-testid="actual-task-cancel">
							取消
						</Button>
					</div>
				)}
				<div className="space-y-3" data-testid="actual-task-result">
					<div className="flex flex-wrap items-center gap-2">
						<span data-testid="actual-task-verdict">
							<Badge tone={run ? verdictTone : "zinc"}>{verdictLabel}</Badge>
						</span>
						{run?.status === "blocked" && <span className="text-xs text-red-600">{run.reason}</span>}
						{adv?.message && <span className="text-xs text-mut">{adv.message}</span>}
					</div>
					{run ? (
						<>
							<div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
								<Metric label="有效样本" value={String(run.samples)} />
								<Metric label="成功率" value={run.successRatio == null ? "—" : `${Math.round(run.successRatio * 100)}%`} />
								<Metric label="p50" value={run.p50Ms == null ? "—" : `${run.p50Ms}ms`} />
								<Metric label="p95" value={run.p95Ms == null ? "—" : `${run.p95Ms}ms${run.p95Approx ? "（粗略）" : ""}`} />
								<Metric label="冷启动" value={run.coldStartMs == null ? "—" : `${run.coldStartMs}ms`} />
								<Metric label="动作 / 重试" value={`${run.actions} / ${run.retries}`} />
								<Metric label="回退 / 弃权" value={`${run.fallbackCount} / ${run.abstains}`} />
								<Metric label="超时 / 错误" value={`${run.timeouts} / ${run.errors}`} />
							</div>
							{run.note && <div className="text-[11px] text-mut2" data-testid="actual-task-accuracy-note">{run.note}</div>}
							<div className="text-[11px] text-mut2">模型版本：{run.modelVersion}（未知不编造） · 只针对本次受控任务，不代表普遍准确，也不等于整个 CUA 速度。</div>
						</>
					) : (
						<div className="text-[11px] text-mut2" data-testid="actual-task-accuracy-note">还没有跑过测试。点「开始测试」会真实执行一次受控任务。</div>
					)}
					<div className="flex justify-end gap-2">
						<Button variant="ghost" onClick={onClose}>
							关闭
						</Button>
						<Button variant="outline" onClick={onClose} data-testid="actual-task-use-anyway">
							仍然使用这个模型
						</Button>
					</div>
				</div>
			</div>
		</Modal>
	);
}
function Metric({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-lg border border-line p-2">
			<div className="text-[11px] text-mut">{label}</div>
			<div className="font-medium">{value}</div>
		</div>
	);
}

/** 服务卡：图标 + 名称 / 状态 / 能力标签；展开是模型列表（能力可纠正）与配置 / 本地运行时。 */
function ServiceCard({ provider, open, onToggle, onSaveCaps, onChangeLocal, onBenchmark }: { provider: RegistryProvider; open: boolean; onToggle: () => void; onSaveCaps: (modelId: string, caps: ModelCapability[]) => void; onChangeLocal: (r: LocalRuntimeDto) => void; onBenchmark: (m: RegistryModel) => void }) {
	const [test, setTest] = useState(false);
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
						{provider.kind === "imagegen" && <Badge tone="amber">生图（迁移中）</Badge>}
					</span>
					<span className="mt-1 flex flex-wrap items-center gap-1.5">
						<CapabilityChips capabilities={caps} testId={`service-caps-${provider.id}`} />
						<span className="text-[11px] text-zinc-400">{provider.models.length} 个模型</span>
					</span>
				</span>
				<ChevronDown size={14} className={cx("shrink-0 text-mut transition-transform", !open && "-rotate-90")} />
			</button>
			{open && (
				<div className="space-y-3 border-t border-line p-3">
					{provider.kind === "local" && <LocalRuntimeCard provider={provider} onChange={onChangeLocal} />}
					<div className="space-y-1.5">
						<div className="flex items-center justify-between gap-2">
							<span className="text-xs font-medium text-zinc-500">模型（{provider.models.length}）</span>
							<Button size="sm" variant="outline" disabled={test} onClick={() => setTest(true)} data-testid={`service-test-${provider.id}`}>
								{test ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />} 测试连接
							</Button>
						</div>
						<div className="max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line" data-testid={`service-models-${provider.id}`}>
							{!provider.models.length && <div className="p-2 text-xs text-mut">还没有载入模型</div>}
							{provider.models.map((m) => (
								<ModelRow key={`${m.type}:${m.id}`} model={m} onSave={(c) => onSaveCaps(m.id, c)} onBenchmark={provider.kind === "local" || provider.kind === "custom" || provider.kind === "builtin" ? onBenchmark : undefined} />
							))}
						</div>
						<div className="text-[11px] text-mut2">能力来自 Pi 目录 / 用户显式配置 / 服务端 /models 元数据；靠 models.dev 或名字猜的标「未确认」。不会逐个模型做隐式付费探测。</div>
					</div>
				</div>
			)}
		</div>
	);
}

/** 添加服务：官方 / 自定义 / 本地（Select 选类型，不用原生 select）。 */
function AddServiceDialog({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (p: RegistryProvider) => void }) {
	const [kind, setKind] = useState<"builtin" | "custom" | "local">("builtin");
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [key, setKey] = useState("");
	const submit = () => {
		const id = `demo-${Date.now()}`;
		onAdd({ id, name: name.trim() || (kind === "builtin" ? "OpenAI" : kind === "custom" ? "我的中转" : "本地 Laya"), kind, baseUrl: kind === "builtin" ? undefined : baseUrl.trim() || undefined, configured: !!key || kind === "local", protocols: [], models: [], local: kind === "local" ? demoLocal("not_installed") : undefined });
		onClose();
	};
	return (
		<Modal open={open} onClose={onClose} title="添加模型服务" testId="add-service">
			<div className="space-y-3 p-5">
				<div className="space-y-1.5">
					<div className="text-xs font-medium">类型</div>
					<Select
						value={kind}
						ariaLabel="服务类型"
						testId="add-service-kind"
						options={[
							{ value: "builtin", label: "官方服务（内置目录）" },
							{ value: "custom", label: "自定义 / 中转（填 Base URL + Key）" },
							{ value: "local", label: "本地模型（Laya，一键下载）" },
						]}
						onChange={(v) => setKind(v as "builtin" | "custom" | "local")}
					/>
				</div>
				{kind !== "builtin" && (
					<>
						<label className="block space-y-1.5 text-xs">
							<span className="font-medium">名称</span>
							<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：我的中转站" data-testid="add-service-name" />
						</label>
						<label className="block space-y-1.5 text-xs">
							<span className="font-medium">Base URL</span>
							<Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" data-testid="add-service-baseurl" />
						</label>
					</>
				)}
				{kind !== "local" && (
					<label className="block space-y-1.5 text-xs">
						<span className="font-medium">API Key</span>
						<Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="粘贴 Key（加密保存在本机）" data-testid="add-service-key" />
					</label>
				)}
				<div className="text-[11px] text-mut2">{kind === "local" ? "本地模型无需填 Key：一键下载会自动获取地址与凭据。" : "保存后点「载入模型」按对端元数据 / 官方目录识别能力；不做隐式付费探测。"}</div>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={onClose}>
						取消
					</Button>
					<Button variant="primary" onClick={submit} data-testid="add-service-submit">
						<Plus size={14} /> 添加
					</Button>
				</div>
			</div>
		</Modal>
	);
}

function demoLocal(ready: LocalRuntimeDto["ready"]): LocalRuntimeDto {
	const idle: PhaseDto = { state: "idle", percent: 0 };
	return {
		installed: ready === "ready" || ready === "offline_ready",
		ready,
		offlineReady: ready === "offline_ready" || ready === "ready",
		phases: { env: idle, weights: idle, verify: idle },
		health: ready === "ready" || ready === "offline_ready" ? { status: "ok", checkedAt: Date.now(), cpu: { label: "Apple M2 Pro", cores: 12, baseline: true }, gpu: { vendor: "apple", backend: "mps", available: true, label: "Apple MPS", source: "probe" } } : undefined,
		platform: { os: "macOS", arch: "arm64", support: "baseline", note: "" },
	};
}

/** 原型示例数据（接口未就绪时可点「预览原型」查看完整交互）。 */
export const DEMO_PROVIDERS: RegistryProvider[] = [
	{
		id: "openai", name: "OpenAI", kind: "builtin", configured: true, protocols: ["openai-completions"],
		models: [
			{ provider: "openai", id: "gpt-4o", name: "GPT-4o", type: "chat", capabilities: ["chat", "vision"], protocol: "openai-completions", confirmed: true, inferred: [], source: "pi-catalog", configured: true },
			{ provider: "openai", id: "gpt-image-1", name: "gpt-image-1", type: "image", capabilities: ["image"], protocol: "openai", confirmed: true, inferred: [], source: "pi-catalog", configured: true, imageAdapter: { kind: "openai", baseUrl: "https://api.openai.com/v1", edit: true }, costNote: "约 $0.04/张" },
		],
	},
	{
		id: "custom-relay", name: "我的中转站", kind: "custom", baseUrl: "https://relay.example.com/v1", configured: true, protocols: ["openai-completions"],
		models: [
			{ provider: "custom-relay", id: "deepseek-v3", name: "deepseek-v3", type: "chat", capabilities: ["chat"], protocol: "openai-completions", confirmed: true, inferred: [], source: "custom", configured: true },
			{ provider: "custom-relay", id: "mystery-model", name: "mystery-model", type: "chat", capabilities: ["chat", "vision"], protocol: "openai-completions", confirmed: false, inferred: ["vision"], source: "custom", configured: true },
		],
	},
	{
		id: "laya-local", name: "本地 Laya", kind: "local", configured: true, protocols: ["llama-cpp-classify"],
		models: [{ provider: "laya-local", id: "laya-fast", name: "laya-fast", type: "classifier", capabilities: ["classifier"], protocol: "llama-cpp-classify", confirmed: true, inferred: [], source: "custom", configured: true }],
		local: demoLocal("offline_ready"),
	},
];

/**
 * 统一模型服务面板：真实接口 `/api/models/registry` 就绪时优先真实数据；未就绪时可「预览原型」用示例数据看完整交互。
 * 默认 chat 紧凑区在 ModelsTab 里，不随折叠隐藏。
 */
export function ModelServicesPanel({ providers: initial, demo = false, onChange }: { providers?: RegistryProvider[]; demo?: boolean; onChange?: (p: RegistryProvider[]) => void }) {
	const [providers, setProviders] = useState<RegistryProvider[]>(initial ?? []);
	const [isDemo, setIsDemo] = useState(demo || !!initial);
	const [open, setOpen] = useState<string[]>([]);
	const [q, setQ] = useState("");
	const [addOpen, setAddOpen] = useState(false);
	const [expanded, setExpanded] = useState(true);
	const [bench, setBench] = useState<{ provider: RegistryProvider; model: RegistryModel } | null>(null);
	useEffect(() => {
		if (initial) return;
		let alive = true;
		void api<{ providers: RegistryProvider[] }>("/api/models/registry")
			.then((r) => alive && setProviders(r.providers))
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [initial]);
	const apply = (next: RegistryProvider[]) => {
		setProviders(next);
		onChange?.(next);
	};
	const saveCaps = (providerId: string, modelId: string, caps: ModelCapability[]) => {
		apply(providers.map((p) => (p.id !== providerId ? p : { ...p, models: p.models.map((m) => (m.id !== modelId ? m : { ...m, capabilities: caps, inferred: [], confirmed: true, source: "custom" as const })) })));
		void api(`/api/models/registry/${providerId}/models/${modelId}/capabilities`, { method: "PUT", json: { capabilities: caps } }).catch(() => {});
	};
	const changeLocal = (providerId: string, r: LocalRuntimeDto) => apply(providers.map((p) => (p.id === providerId ? { ...p, local: r, configured: r.installed } : p)));
	const list = useMemo(() => {
		const f = providers.filter((s) => !q || `${s.name} ${s.id}`.toLowerCase().includes(q.toLowerCase()));
		return [...f].sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
	}, [providers, q]);
	const configured = providers.filter((s) => s.configured).length;
	return (
		<Fold testId="model-services" icon={Gauge} title="模型服务" count={providers.length} hint={configured ? `已配置 ${configured}` : undefined} desc="一个服务 = 一份地址 + 一份凭据，可同时含对话 / 识图 / 生图 / 分类器模型。能力按 Pi 目录或对端元数据识别，猜的标「未确认」，可手动纠正。" open={expanded} onToggle={() => setExpanded((v) => !v)}>
			<div className="space-y-3" data-testid="model-services-panel" data-demo={String(isDemo)}>
				<div className="flex flex-wrap items-center gap-2">
					<div className="relative min-w-40 flex-1">
						<Search size={15} className="absolute top-2.5 left-2.5 text-zinc-400" />
						<Input placeholder={`搜索 ${providers.length} 个模型服务…`} value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" data-testid="service-search" />
					</div>
					<Button variant="primary" onClick={() => setAddOpen(true)} data-testid="add-service-open">
						<Plus size={15} /> 添加服务
					</Button>
					{!isDemo && !initial && (
						<Button
							variant="outline"
							onClick={() => {
								setProviders(DEMO_PROVIDERS);
								setIsDemo(true);
							}}
							data-testid="service-preview-demo"
						>
							预览原型
						</Button>
					)}
				</div>
				{!list.length && <div className="rounded-xl border border-dashed border-line p-4 text-center text-xs text-mut">还没有模型服务。点「添加服务」选官方 / 自定义 / 本地。</div>}
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="service-grid">
					{list.map((s) => (
						<ServiceCard key={s.id} provider={s} open={open.includes(s.id)} onToggle={() => setOpen((l) => (l.includes(s.id) ? l.filter((x) => x !== s.id) : [...l, s.id]))} onSaveCaps={(m, c) => saveCaps(s.id, m, c)} onChangeLocal={(r) => changeLocal(s.id, r)} onBenchmark={(m) => setBench({ provider: s, model: m })} />
					))}
				</div>
				<div className="flex items-center gap-1.5 text-[11px] text-mut2">
					<Help>官方服务来自 Pi 内置目录；自定义 / 中转填地址与 Key。能力多标签：对话 / 识图 / 生图 / 分类器。生图与快速操作模型都从这里的能力里选，不再单独配凭据。</Help>
					生图与快速操作模型统一在这里，不再有独立配置区。
				</div>
			</div>
			<AddServiceDialog open={addOpen} onClose={() => setAddOpen(false)} onAdd={(p) => apply([...providers, p])} />
			{bench && <BenchmarkDialog open onClose={() => setBench(null)} provider={bench.provider} model={bench.model} />}
		</Fold>
	);
}
