/**
 * 统一模型服务（原型 → 接 API）。
 * 设计见 docs/design/model-settings-unified.md：一个服务 = 一份 baseURL + 一份凭据，可含 chat / vision / image / classifier。
 * 交互：默认 chat 紧凑区（在 ModelsTab 里）+ 统一服务卡片网格 + 添加服务（官方/自定义/本地）；
 * 能力按「可信元数据 / 官方目录」识别，不确定灰态可用户纠正；不靠名字含 Jev 判协议；不逐个隐式付费 probe。
 * 本文件先做纯前端原型：真实接口 `/api/model-services*` 未就绪时用 DEMO_SERVICES 走完整交互；
 * 接口就绪后由 ModelsTab 优先渲染真实数据（S5 去 demo 开关）。
 */
import { Activity, AlertTriangle, Check, CheckCircle2, ChevronDown, Cpu, Download, Gauge, Loader2, Monitor, Pause, Pencil, Play, Plus, RotateCcw, Search, ShieldCheck, Square, Trash2, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { PROVIDER_ICONS } from "./provider-icons";
import type { ActualTaskTestDto, CapabilitySource, LocalRuntimeDto, ModelCapability, ModelEntryDto, ModelServiceDto, PhaseDto } from "../types";
import { Badge, Button, cx, Fold, Help, Input, Modal, Select, useConfirm } from "./ui";

const CAPS: ModelCapability[] = ["chat", "vision", "image", "classifier"];
const CAP_LABEL: Record<ModelCapability, string> = { chat: "对话", vision: "识图", image: "生图", classifier: "分类器" };
const CAP_TONE: Record<ModelCapability, "accent" | "green" | "amber" | "zinc"> = { chat: "accent", vision: "green", image: "amber", classifier: "zinc" };
const SOURCE_LABEL: Record<CapabilitySource, string> = { metadata: "对端元数据", catalog: "官方目录", user: "你手动设置", unknown: "未知（可纠正）" };
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
/** 服务图标：官方用品牌 logo；自定义 / 本地 / 未收录品牌用「首字母 + 稳定配色」字母头像。 */
function ServiceIcon({ service }: { service: ModelServiceDto }) {
	const brand = service.kind === "official" ? PROVIDER_ICONS[service.icon ?? service.id] : undefined;
	if (brand)
		return <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-white text-zinc-700 [&>svg]:size-5 dark:bg-zinc-800 dark:text-zinc-200" data-testid="service-icon" data-service-icon={service.id} data-service-icon-kind="brand" dangerouslySetInnerHTML={{ __html: brand }} />;
	let h = 0;
	for (const c of service.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return (
		<span aria-hidden className={cx("flex size-9 shrink-0 items-center justify-center rounded-lg text-xs font-semibold", AVATAR_TONES[h % AVATAR_TONES.length])} data-testid="service-icon" data-service-icon={service.id} data-service-icon-kind={service.kind}>
			{initials(service.name)}
		</span>
	);
}

/** 能力标签行：source=unknown 用灰态并注明「可纠正」。 */
function CapabilityChips({ caps, testId }: { caps: { capability: ModelCapability; source: CapabilitySource }[]; testId?: string }) {
	return (
		<span className="flex flex-wrap items-center gap-1" data-testid={testId}>
			{caps.map((c) => (
				<Badge key={c.capability} tone={c.source === "unknown" ? "zinc" : CAP_TONE[c.capability]}>
					{CAP_LABEL[c.capability]}
					{c.source === "unknown" ? "？" : ""}
				</Badge>
			))}
			{!caps.length && <span className="text-[11px] text-mut2">能力未知</span>}
		</span>
	);
}

/** 能力纠正：多选 checkbox，来源记 user（最高优先，覆盖 metadata / catalog）。 */
function CapabilityEditor({ entry, onSave, onCancel }: { entry: ModelEntryDto; onSave: (caps: ModelCapability[]) => void; onCancel: () => void }) {
	const [picked, setPicked] = useState<ModelCapability[]>(entry.capabilities.map((c) => c.capability));
	const toggle = (c: ModelCapability) => setPicked((l) => (l.includes(c) ? l.filter((x) => x !== c) : [...l, c]));
	return (
		<div className="space-y-2 rounded-lg border border-line p-2.5" data-testid="capability-editor" data-model={entry.id}>
			<div className="text-xs font-medium">设置「{entry.name || entry.id}」的能力（可多选）</div>
			<div className="flex flex-wrap gap-2">
				{CAPS.map((c) => (
					<label key={c} className="flex items-center gap-1.5 text-xs">
						<input type="checkbox" checked={picked.includes(c)} onChange={() => toggle(c)} data-testid={`cap-${c}`} />
						{CAP_LABEL[c]}
					</label>
				))}
			</div>
			<div className="text-[11px] text-mut2">不确定时选「未知」也行：不影响保存，助理不会据此自动决策。识别来源会记为「你手动设置」。</div>
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

/** 模型行：id + 能力标签 + 「能力」纠正入口。 */
function ModelRow({ entry, onSave }: { entry: ModelEntryDto; onSave: (caps: ModelCapability[]) => void }) {
	const [edit, setEdit] = useState(false);
	return (
		<div className="px-2.5 py-1.5" data-testid="service-model" data-model={entry.id}>
			<div className="flex items-center gap-2 text-xs">
				<span className="min-w-0 flex-1 truncate font-mono" title={entry.id}>
					{entry.id}
				</span>
				<CapabilityChips caps={entry.capabilities} testId="model-caps" />
				<button className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-mut2 hover:bg-hover hover:text-fg" onClick={() => setEdit(!edit)} aria-expanded={edit} data-testid="model-capability-toggle">
					能力
				</button>
			</div>
			{edit && (
				<div className="mt-2">
					<CapabilityEditor entry={entry} onSave={(c) => (onSave(c), setEdit(false))} onCancel={() => setEdit(false)} />
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
function LocalRuntimeCard({ service, onChange }: { service: ModelServiceDto; onChange: (r: LocalRuntimeDto) => void }) {
	const local = service.local;
	const [dlg, ask] = useConfirm();
	const [busy, setBusy] = useState<string | null>(null);
	if (!local) return null;
	const p = local.platform;
	const call = async (path: string, method = "POST") => {
		setBusy(path);
		try {
			const r = await api<LocalRuntimeDto>(`/api/model-services/${service.id}/local${path}`, { method });
			onChange(r);
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
				<Badge tone={local.ready === "offline_ready" || local.ready === "ready" ? "green" : local.ready === "error" ? "red" : "zinc"} data-testid="local-ready">
					{local.ready === "not_installed" ? "未安装" : local.ready === "installing" ? "安装中" : local.ready === "offline_ready" ? "离线可用" : local.ready === "ready" ? "就绪" : local.ready === "error" ? "出错" : "已停止"}
				</Badge>
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

/** 实际操作测试：真实受控 CUA 任务（不是 API 延迟）。先选测试电脑、看前置条件与费用，用户确认才启动。 */
function ActualTaskTestDialog({ open, onClose, service }: { open: boolean; onClose: () => void; service: ModelServiceDto }) {
	const [target, setTarget] = useState<"assistant" | "host">("assistant");
	const [ack, setAck] = useState(false);
	const [result, setResult] = useState<ActualTaskTestDto | null>(null);
	const [running, setRunning] = useState(false);
	const costNote = service.kind === "local" ? "本地运行，无额外费用。" : "云端模型：这次测试会产生真实模型调用，可能计费。";
	const start = async () => {
		setRunning(true);
		try {
			const r = await api<{ taskId: string }>("/api/actual-task-test/start", { method: "POST", json: { target, serviceId: service.id } });
			const poll = async (): Promise<ActualTaskTestDto> => {
				const d = await api<ActualTaskTestDto>(`/api/actual-task-test/${r.taskId}`);
				return d.status === "done" || d.status === "error" ? d : (await new Promise((x) => setTimeout(x, 400)), poll());
			};
			setResult(await poll());
		} catch {
			// 原型：接口未就绪时走本地演示（纯前端，不碰真实电脑 / appdata）
			const demo = await simulateActualTaskTest(target);
			setResult(demo);
		} finally {
			setRunning(false);
		}
	};
	const cancel = () => {
		setRunning(false);
		onClose();
	};
	const verdictTone = result?.verdict.level === "recommended" ? "green" : result?.verdict.level === "caution" ? "amber" : "red";
	return (
		<Modal open={open} onClose={onClose} title="实际操作测试" testId="actual-task-test">
			<div className="space-y-4 p-5">
				<div className="text-sm text-mut">
					这不是测 API 延迟，而是<b className="text-fg">打开一个专用测试窗口</b>，经 CUA 正式链路（观察 → 候选 → 分类 → 重新点击 → 校验）跑一次受控任务，评估这个模型能不能真的操作电脑。
				</div>
				{!result && (
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
						<div className="space-y-1 rounded-lg bg-hover p-3 text-xs text-mut" data-testid="actual-task-preflight">
							<div className="flex items-center gap-1.5">
								<ShieldCheck size={13} /> 前置条件（启动前校验，不偷偷开）：
							</div>
							<div>· 屏幕 / 辅助功能权限、虚拟机是否就绪，都会先检查并让你确认。</div>
							<div>· 全程不碰你的真实数据；测试窗口失焦会立即中止。</div>
							<div className="flex items-start gap-1.5 text-amber-600">
								<AlertTriangle size={13} className="mt-0.5 shrink-0" /> {costNote}
							</div>
						</div>
						<label className="flex items-center gap-2 text-xs">
							<input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="actual-task-ack" />
							我知道会打开专用测试窗口，并同意在选定电脑上运行受控任务。
						</label>
						<div className="flex justify-end gap-2">
							<Button variant="ghost" onClick={onClose}>
								取消
							</Button>
							<Button variant="primary" disabled={!ack || running} onClick={() => void start()} data-testid="actual-task-start">
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
				{result && (
					<div className="space-y-3" data-testid="actual-task-result">
						<div className="flex items-center gap-2">
							<Badge tone={verdictTone} data-testid="actual-task-verdict">
								{result.verdict.level === "recommended" ? "建议使用" : result.verdict.level === "caution" ? "谨慎使用" : "不建议使用"}
							</Badge>
							<span className="text-xs text-mut">{result.verdict.reason}</span>
						</div>
						<div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
							<Metric label="成功" value={result.success ? "是" : "否"} />
							<Metric label="总时长" value={`${(result.totalMs / 1000).toFixed(1)}s`} />
							<Metric label="重试" value={String(result.retries)} />
							<Metric label="回退主模型" value={String(result.mainFallback)} />
							<Metric label="错误" value={String(result.errors.length)} />
							<Metric label="样本" value={String(result.samples)} />
						</div>
						{result.errors.length > 0 && (
							<div className="rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
								{result.errors.map((e, i) => (
									<div key={i}>· {e.step}：{e.message}</div>
								))}
							</div>
						)}
						<div className="text-[11px] text-mut2" data-testid="actual-task-accuracy-note">
							{result.verdict.accuracyNote}
						</div>
						{result.apiLatency && <div className="text-[11px] text-mut2">API 延迟（仅诊断，不代表操作速度）：p50 {result.apiLatency.p50}ms / p95 {result.apiLatency.p95}ms</div>}
						<div className="flex justify-end gap-2">
							<Button variant="ghost" onClick={onClose}>
								关闭
							</Button>
							<Button variant="outline" onClick={onClose} data-testid="actual-task-use-anyway">
								仍然使用这个模型
							</Button>
						</div>
					</div>
				)}
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
/** 原型用本地演示：不碰真实电脑 / appdata，仅按步骤推进（接口未就绪时的 fallback）。 */
async function simulateActualTaskTest(target: "assistant" | "host"): Promise<ActualTaskTestDto> {
	const steps = ["observe", "candidate", "classify", "fresh-click", "verify"].map((id) => ({ id, label: { observe: "观察", candidate: "候选", classify: "分类", "fresh-click": "重新点击", verify: "校验" }[id]!, state: "pending" as const }));
	await new Promise((r) => setTimeout(r, 300));
	return {
		kind: "controlled-cua-task",
		target,
		status: "done",
		steps: steps.map((s) => ({ ...s, state: "done" })),
		success: true,
		totalMs: 8420,
		errors: [],
		retries: 1,
		mainFallback: 0,
		preflight: { permissionsOk: true, vmReady: true, confirmedByUser: true },
		samples: 3,
		verdict: { level: "caution", advisory: true, reason: "成功率尚可，但样本只有 3 次，建议先在低风险任务上试用。", accuracyNote: "样本有限，不代表普遍准确；结论仅针对本次受控任务。" },
		apiLatency: { p50: 640, p95: 1180 },
	};
}

/** 服务卡：图标 + 名称 / 状态 / 能力标签；展开是模型列表（能力可纠正）与配置 / 本地运行时。 */
function ServiceCard({ service, open, onToggle, onSaveCaps, onChangeLocal }: { service: ModelServiceDto; open: boolean; onToggle: () => void; onSaveCaps: (modelId: string, caps: ModelCapability[]) => void; onChangeLocal: (r: LocalRuntimeDto) => void }) {
	const [test, setTest] = useState(false);
	return (
		<div className={cx("rounded-xl border border-line", open && "sm:col-span-2")} data-testid="service-card" data-service={service.id} data-kind={service.kind}>
			<button className="flex w-full items-center gap-2.5 p-3 text-left" onClick={onToggle} aria-expanded={open} data-testid={`service-toggle-${service.id}`}>
				<ServiceIcon service={service} />
				<span className="min-w-0 flex-1">
					<span className="flex flex-wrap items-center gap-1.5">
						<span className="min-w-0 truncate text-sm font-medium">{service.name}</span>
						{service.configured && <CheckCircle2 size={14} className="shrink-0 text-emerald-500" aria-label="已配置" />}
						{service.kind === "custom" && <Badge tone="amber">自定义</Badge>}
						{service.kind === "local" && <Badge tone="accent">本地</Badge>}
					</span>
					<span className="mt-1 flex flex-wrap items-center gap-1.5">
						<CapabilityChips caps={CAPS.filter((c) => service.counts[c] > 0).map((c) => ({ capability: c, source: "metadata" as CapabilitySource }))} testId={`service-caps-${service.id}`} />
						<span className="text-[11px] text-zinc-400">{service.models.length} 个模型</span>
					</span>
				</span>
				<ChevronDown size={14} className={cx("shrink-0 text-mut transition-transform", !open && "-rotate-90")} />
			</button>
			{open && (
				<div className="space-y-3 border-t border-line p-3">
					{service.kind === "local" && <LocalRuntimeCard service={service} onChange={onChangeLocal} />}
					<div className="space-y-1.5">
						<div className="flex items-center justify-between gap-2">
							<span className="text-xs font-medium text-zinc-500">模型（{service.models.length}）</span>
							<Button size="sm" variant="outline" disabled={test} onClick={() => setTest(true)} data-testid={`service-test-${service.id}`}>
								{test ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />} 测试连接
							</Button>
						</div>
						<div className="max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line" data-testid={`service-models-${service.id}`}>
							{!service.models.length && <div className="p-2 text-xs text-mut">还没有载入模型</div>}
							{service.models.map((m) => (
								<ModelRow key={m.id} entry={m} onSave={(c) => onSaveCaps(m.id, c)} />
							))}
						</div>
						<div className="text-[11px] text-mut2">能力来自对端元数据 / 官方目录；不确定的显示灰态，可点「能力」手动纠正。不会逐个模型做隐式付费探测。</div>
					</div>
					{service.kind === "local" && service.local && (service.local.ready === "ready" || service.local.ready === "offline_ready") && (
						<ActualTaskTestButton service={service} />
					)}
				</div>
			)}
		</div>
	);
}
/** 「实际操作测试」入口按钮（本地 Laya / 云端都从这里进，云端会提示可能计费）。 */
function ActualTaskTestButton({ service }: { service: ModelServiceDto }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button size="sm" variant="primary" onClick={() => setOpen(true)} data-testid={`actual-task-open-${service.id}`}>
				<Monitor size={14} /> 实际操作测试
			</Button>
			<ActualTaskTestDialog open={open} onClose={() => setOpen(false)} service={service} />
		</>
	);
}

/** 添加服务：官方 / 自定义 / 本地（Select 选类型，不用原生 select）。 */
function AddServiceDialog({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (s: ModelServiceDto) => void }) {
	const [kind, setKind] = useState<"official" | "custom" | "local">("official");
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [key, setKey] = useState("");
	const submit = () => {
		const id = `demo-${Date.now()}`;
		onAdd({ id, name: name.trim() || (kind === "official" ? "OpenAI" : kind === "custom" ? "我的中转" : "本地 Laya"), kind, baseUrl: kind === "official" ? undefined : baseUrl.trim() || undefined, configured: !!key || kind === "local", models: [], counts: { chat: 0, vision: 0, image: 0, classifier: 0 }, local: kind === "local" ? demoLocal("not_installed") : undefined });
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
							{ value: "official", label: "官方服务（内置目录）" },
							{ value: "custom", label: "自定义 / 中转（填 Base URL + Key）" },
							{ value: "local", label: "本地模型（Laya，一键下载）" },
						]}
						onChange={(v) => setKind(v as "official" | "custom" | "local")}
					/>
				</div>
				{kind !== "official" && (
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
				<div className="text-[11px] text-mut2">
					{kind === "local" ? "本地模型无需填 Key：一键下载会自动获取地址与凭据。" : "保存后点「载入模型」按对端元数据 / 官方目录识别能力；不做隐式付费探测。"}
				</div>
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
		health:
			ready === "ready" || ready === "offline_ready"
				? { status: "ok", checkedAt: Date.now(), cpu: { label: "Apple M2 Pro", cores: 12, baseline: true }, gpu: { vendor: "apple", backend: "mps", available: true, label: "Apple MPS", source: "probe" } }
				: undefined,
		platform: { os: "macOS", arch: "arm64", support: "baseline", note: "" },
	};
}

/** 原型示例数据（接口未就绪时可点「预览原型」查看完整交互）。 */
export const DEMO_SERVICES: ModelServiceDto[] = [
	{
		id: "openai",
		name: "OpenAI",
		kind: "official",
		configured: true,
		models: [
			{ id: "gpt-4o", name: "GPT-4o", capabilities: [{ capability: "chat", source: "catalog", confidence: "high" }, { capability: "vision", source: "catalog", confidence: "high" }] },
			{ id: "gpt-image-1", capabilities: [{ capability: "image", source: "catalog", confidence: "high" }] },
		],
		counts: { chat: 1, vision: 1, image: 1, classifier: 0 },
	},
	{
		id: "custom-relay",
		name: "我的中转站",
		kind: "custom",
		baseUrl: "https://relay.example.com/v1",
		configured: true,
		models: [
			{ id: "deepseek-v3", capabilities: [{ capability: "chat", source: "metadata", confidence: "high" }] },
			{ id: "qwen-vl-max", capabilities: [{ capability: "chat", source: "metadata", confidence: "high" }, { capability: "vision", source: "metadata", confidence: "high" }] },
			{ id: "mystery-model", capabilities: [{ capability: "chat", source: "unknown", confidence: "low" }] },
		],
		counts: { chat: 3, vision: 1, image: 0, classifier: 0 },
	},
	{ id: "laya-local", name: "本地 Laya", kind: "local", configured: true, models: [{ id: "laya-fast", capabilities: [{ capability: "classifier", source: "catalog", confidence: "medium" }] }], counts: { chat: 0, vision: 0, image: 0, classifier: 1 }, local: demoLocal("offline_ready") },
];

/**
 * 统一模型服务面板：真实接口就绪时优先真实数据；未就绪时可「预览原型」用示例数据看完整交互。
 * 折叠整块（父级 Fold）；默认 chat 紧凑区在 ModelsTab 里，不随折叠隐藏。
 */
export function ModelServicesPanel({ services: initial, demo = false, onChange }: { services?: ModelServiceDto[]; demo?: boolean; onChange?: (s: ModelServiceDto[]) => void }) {
	const [services, setServices] = useState<ModelServiceDto[]>(initial ?? []);
	const [isDemo, setIsDemo] = useState(demo || !!initial);
	const [open, setOpen] = useState<string[]>([]);
	const [q, setQ] = useState("");
	const [addOpen, setAddOpen] = useState(false);
	const [expanded, setExpanded] = useState(true);
	useEffect(() => {
		if (initial) return;
		let alive = true;
		void api<{ services: ModelServiceDto[] }>("/api/model-services")
			.then((r) => alive && setServices(r.services))
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [initial]);
	const apply = (next: ModelServiceDto[]) => {
		setServices(next);
		onChange?.(next);
	};
	const saveCaps = (serviceId: string, modelId: string, caps: ModelCapability[]) => {
		apply(services.map((s) => (s.id !== serviceId ? s : { ...s, models: s.models.map((m) => (m.id !== modelId ? m : { ...m, capabilities: caps.map((c) => ({ capability: c, source: "user" as CapabilitySource, confidence: "high" as const })) })) })));
		void api(`/api/model-services/${serviceId}/models/${modelId}/capabilities`, { method: "PUT", json: { capabilities: caps } }).catch(() => {});
	};
	const changeLocal = (serviceId: string, r: LocalRuntimeDto) => apply(services.map((s) => (s.id === serviceId ? { ...s, local: r, configured: r.installed } : s)));
	const list = useMemo(() => {
		const f = services.filter((s) => !q || `${s.name} ${s.id}`.toLowerCase().includes(q.toLowerCase()));
		return [...f].sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
	}, [services, q]);
	const configured = services.filter((s) => s.configured).length;
	return (
		<Fold testId="model-services" icon={Gauge} title="模型服务" count={services.length} hint={configured ? `已配置 ${configured}` : undefined} desc="一个服务 = 一份地址 + 一份凭据，可同时含对话 / 识图 / 生图 / 分类器模型。能力按对端元数据或官方目录识别，不确定可手动纠正。" open={expanded} onToggle={() => setExpanded((v) => !v)}>
			<div className="space-y-3" data-testid="model-services-panel" data-demo={String(isDemo)}>
				<div className="flex flex-wrap items-center gap-2">
					<div className="relative min-w-40 flex-1">
						<Search size={15} className="absolute top-2.5 left-2.5 text-zinc-400" />
						<Input placeholder={`搜索 ${services.length} 个模型服务…`} value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" data-testid="service-search" />
					</div>
					<Button variant="primary" onClick={() => setAddOpen(true)} data-testid="add-service-open">
						<Plus size={15} /> 添加服务
					</Button>
					{!isDemo && !initial && (
						<Button
							variant="outline"
							onClick={() => {
								setServices(DEMO_SERVICES);
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
						<ServiceCard key={s.id} service={s} open={open.includes(s.id)} onToggle={() => setOpen((l) => (l.includes(s.id) ? l.filter((x) => x !== s.id) : [...l, s.id]))} onSaveCaps={(m, c) => saveCaps(s.id, m, c)} onChangeLocal={(r) => changeLocal(s.id, r)} />
					))}
				</div>
				<div className="flex items-center gap-1.5 text-[11px] text-mut2">
					<Help>官方服务来自 Pi 内置目录；自定义 / 中转填地址与 Key。载入模型只读免费目录，不逐个模型做付费探测。生图与快速操作模型都从这里的服务能力里选，不再单独配凭据。</Help>
					能力多标签：对话 / 识图 / 生图 / 分类器。
				</div>
			</div>
			<AddServiceDialog
				open={addOpen}
				onClose={() => setAddOpen(false)}
				onAdd={(s) => apply([...services, s])}
			/>
		</Fold>
	);
}
