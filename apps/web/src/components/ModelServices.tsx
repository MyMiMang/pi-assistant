/**
 * 统一模型服务（原型 → 接 API）。
 * 设计见 docs/design/model-settings-unified.md；契约对齐（唯一事实来源）：
 *  - registry agent：`GET /api/models/registry` → `{ providers: RegistryProvider[] }`（packages/server/src/model-registry.ts）
 *  - benchmark agent：`GET/POST /api/fast-computer/benchmark`、`GET /:id`、`POST /:id/cancel`（fast-computer/benchmark.ts）
 *  - laya agent：`/api/local-models/laya/{status,platform,source,logs,install,cancel,start,stop,update}`（docs/design/local-laya-api.md）
 * 一个服务 = 一份 baseUrl + 一份凭据，可同时含 chat / vision / image / classifier；生图与快速操作不再单独配凭据。
 * 能力只按可靠来源；猜出来的标「未确认」。接口未就绪时面板默认不渲染（保持旧界面），可用 `?unified=1` 预览原型。
 */
import { Activity, AlertTriangle, Check, CheckCircle2, ChevronDown, Download, Gauge, Loader2, Monitor, Play, Plus, RefreshCw, RotateCcw, Search, ShieldCheck, Square, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { PROVIDER_ICONS } from "./provider-icons";
import type { BenchmarkAvailability, FastBenchmarkResult, LayaStatus, ModelCapability, ModelType, RegistryModel, RegistryProvider } from "../types";
import { Badge, Button, cx, Fold, Help, Input, Modal, Select, useConfirm } from "./ui";

const CAPS: ModelCapability[] = ["chat", "vision", "image", "classifier"];
const CAP_LABEL: Record<ModelCapability, string> = { chat: "对话", vision: "识图", image: "生图", classifier: "分类器" };
const CAP_TONE: Record<ModelCapability, "accent" | "green" | "amber" | "zinc"> = { chat: "accent", vision: "green", image: "amber", classifier: "zinc" };
const TYPE_LABEL: Record<ModelType, string> = { chat: "对话", image: "生图", classifier: "分类器" };
const PHASE_LABEL: Record<string, string> = { preflight: "预检", uv: "环境", venv: "虚拟环境", torch: "框架", laya: "Laya", weights: "权重", verify: "校验", activate: "启用", rollback: "回滚", done: "完成" };
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
function ServiceIcon({ provider }: { provider: RegistryProvider }) {
	const brand = provider.kind === "builtin" && provider.id !== "local-laya" ? PROVIDER_ICONS[provider.id] : undefined;
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

/** 本地 Laya 安装管理卡：按 local-laya-runtime 冻结契约接线；始终可见（source=local），停进程也不删条目。 */
function LocalLayaCard({ demo, onBenchmark }: { demo: boolean; onBenchmark: (provider: RegistryProvider, model: RegistryModel) => void }) {
	const [st, setSt] = useState<LayaStatus | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [dlg, ask] = useConfirm();
	const load = () =>
		api<LayaStatus>("/api/local-models/laya/status")
			.then(setSt)
			.catch(() => setSt((cur) => cur ?? (demo ? DEMO_LAYA : null)));
	useEffect(() => {
		void load();
	}, []);
	// 安装 / 启动中轮询（契约：安装中建议 1s）；WS 事件由服务端推送，原型先轮询
	useEffect(() => {
		if (!st || (st.install.state !== "installing" && st.runtime.state !== "starting" && st.runtime.state !== "stopping")) return;
		const t = setInterval(load, 1000);
		return () => clearInterval(t);
	}, [st?.install.state, st?.runtime.state]);
	if (!st) return null;
	const post = async (path: string, body?: unknown) => {
		setBusy(path);
		try {
			const r = await api<{ ok: boolean; status?: LayaStatus; error?: string }>(`/api/local-models/laya${path}`, { method: "POST", json: body });
			if (r.status) setSt(r.status);
			else await load();
		} catch {
			/* 原型：接口未就绪时忽略 */
		} finally {
			setBusy(null);
		}
	};
	const uninstall = async () => {
		if (!(await ask({ title: "卸载本地 Laya？", body: "会停止 sidecar 并删除自己下载的环境与权重，之后需要重新安装。不影响你的其它模型服务与设置。", ok: "卸载", danger: true }))) return;
		setBusy("uninstall");
		try {
			await api("/api/local-models/laya", { method: "DELETE", json: { confirm: true } });
			await load();
		} catch {
			/* ignore */
		} finally {
			setBusy(null);
		}
	};
	const p = st.platform;
	const installing = st.install.state === "installing";
	const installed = st.install.state === "installed";
	const running = st.runtime.state === "running";
	const percent = st.install.total ? Math.round((st.install.received / st.install.total) * 100) : null;
	const unsupported = p.support === "unsupported";
	const model: RegistryModel = { provider: "local-laya", id: st.registered?.modelId ?? "multilingual", name: st.registered?.modelId ?? "multilingual", type: "classifier", capabilities: ["classifier"], protocol: st.registered?.protocol ?? "typesafe-system-one", confirmed: true, inferred: [], source: "pi-catalog", configured: true };
	return (
		<div className="space-y-3 rounded-xl border border-line p-3" data-testid="local-laya-card" data-install-state={st.install.state} data-runtime-state={st.runtime.state} data-source="local">
			{dlg}
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<ServiceIcon provider={{ id: "local-laya", name: "本地 Laya", kind: "local", configured: true, protocols: [], models: [] }} />
				<span className="text-sm font-medium">本地 Laya</span>
				<Badge tone="accent">本地</Badge>
				<span data-testid="laya-install-state">
					<Badge tone={installing ? "amber" : installed ? "green" : st.install.state === "failed" ? "red" : "zinc"}>
						{st.install.state === "not_installed" ? "未安装" : installing ? "安装中" : installed ? "已安装" : "安装失败"}
					</Badge>
				</span>
				<span data-testid="laya-runtime-state">
					<Badge tone={running ? "green" : st.runtime.state === "crashed" ? "red" : "zinc"}>
						{running ? "运行中" : st.runtime.state === "starting" ? "启动中" : st.runtime.state === "stopping" ? "停止中" : st.runtime.state === "crashed" ? "已崩溃" : "未运行"}
					</Badge>
				</span>
			</div>
			<div className="flex flex-wrap items-center gap-2 text-[11px] text-mut">
				<span data-testid="laya-platform" data-support={p.support}>
					平台：{p.os} / {p.arch} · {p.support === "supported" ? "支持" : p.support === "conditional" ? "有条件支持" : p.support === "experimental" ? "实验性" : "不支持"}（安装意图 {p.accelerator}）
				</span>
				{unsupported && (
					<span className="flex items-center gap-1 text-amber-600" data-testid="laya-platform-reason">
						<AlertTriangle size={12} /> {p.reason || "此平台暂不支持，不假装成功"}
					</span>
				)}
			</div>
			{installing && (
				<div className="space-y-1.5 text-[11px]" data-testid="laya-progress">
					<div className="flex items-center gap-2">
						<span className="w-14 shrink-0 text-mut">{PHASE_LABEL[st.install.phase] ?? st.install.phase}</span>
						<div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-hover">
							<div className="h-full rounded-full bg-accent transition-all" style={{ width: `${percent ?? 8}%` }} />
						</div>
						<span className="w-24 shrink-0 text-right text-mut2">{percent != null ? `${percent}%` : "进行中"}</span>
					</div>
					{st.install.error && <div className="text-red-600">{st.install.error}</div>}
				</div>
			)}
			{st.install.state === "failed" && st.install.error && <div className="text-[11px] text-red-600" data-testid="laya-error">{st.install.error}</div>}
			{installed && st.health && (
				<div className="flex flex-wrap items-center gap-2 text-[11px] text-mut" data-testid="laya-health">
					<span className="flex items-center gap-1" data-testid="laya-device">
						<Gauge size={12} /> 实际设备：{st.health.device ?? "未知"}
					</span>
					{st.health.cpuFallbacks && st.health.cpuFallbacks.count > 0 && (
						<span className="flex items-center gap-1 text-amber-600" data-testid="laya-cpu-fallback">
							<AlertTriangle size={12} /> CPU 回退 {st.health.cpuFallbacks.count} 次{st.health.cpuFallbacks.lastReason ? `：${st.health.cpuFallbacks.lastReason}` : ""}
						</span>
					)}
					{st.health.revisions && Object.keys(st.health.revisions).length > 0 && <span className="text-mut2">revision：{Object.values(st.health.revisions).join(", ").slice(0, 12)}</span>}
				</div>
			)}
			<div className="flex flex-wrap items-center gap-2 text-[11px] text-mut2" data-testid="laya-source">
				来源：{st.source.project} {st.source.version} · 代码 {st.source.codeLicense} / 权重 {st.source.weightsLicense}
			</div>
			{/* 分类器模型：注册进目录后可选 + 实际操作测试；未运行显示未就绪，而不是删掉配置 */}
			<div className="rounded-lg border border-line" data-testid="laya-model-row" data-registered={String(!!st.registered)}>
				<div className="flex flex-wrap items-center gap-2 px-2.5 py-1.5 text-xs">
					<span className="rounded bg-hover px-1.5 py-0.5 text-[11px] text-mut">分类器</span>
					<span className="min-w-0 flex-1 truncate font-mono">local-laya / {model.id}</span>
					<CapabilityChips capabilities={["classifier"]} testId="laya-model-caps" />
					{!st.registered && <span className="text-[11px] text-amber-600">未就绪（启动后自动注册，不删配置）</span>}
				</div>
				{st.registered && (
					<div className="px-2.5 pb-2">
						<Button size="sm" variant="outline" onClick={() => onBenchmark({ id: "local-laya", name: "本地 Laya", kind: "local", configured: true, protocols: [], models: [] }, model)} data-testid="benchmark-open-multilingual">
							<Monitor size={13} /> 实际操作测试
						</Button>
					</div>
				)}
			</div>
			<div className="flex flex-wrap gap-2">
				{!installed && !installing && (
					<Button size="sm" variant="primary" disabled={busy !== null || unsupported} onClick={() => void post("/install")} data-testid="laya-install">
						<Download size={14} /> 一键安装（自动地址，无需填 Key）
					</Button>
				)}
				{installing && (
					<Button size="sm" variant="outline" onClick={() => void post("/cancel")} data-testid="laya-cancel">
						<Square size={13} /> 取消
					</Button>
				)}
				{st.install.state === "failed" && (
					<Button size="sm" variant="primary" onClick={() => void post("/install")} data-testid="laya-retry">
						<RotateCcw size={13} /> 重试安装
					</Button>
				)}
				{installed && !running && (
					<Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void post("/start")} data-testid="laya-start">
						<Play size={13} /> 启动
					</Button>
				)}
				{running && (
					<Button size="sm" variant="outline" onClick={() => void post("/stop")} data-testid="laya-stop">
						<Square size={13} /> 停止
					</Button>
				)}
				{installed && (
					<>
						<Button size="sm" variant="outline" onClick={() => void post("/update")} data-testid="laya-update">
							<RefreshCw size={13} /> 更新
						</Button>
						<Button size="sm" variant="ghost" onClick={() => void uninstall()} data-testid="laya-uninstall">
							<Trash2 size={13} /> 卸载
						</Button>
					</>
				)}
			</div>
			<div className="text-[11px] text-mut2" data-testid="laya-unverified-note">
				本地 Laya 的下载 / 启动尚未在本机实机验证（后端测试为 fake / 环回 HTTP，未真下载 venv、未启动 Laya、未跑 GPU）；状态以实际 health 为准。
			</div>
		</div>
	);
}

/** 实际操作测试：真实受控 CUA 任务（不是 API 延迟）。渲染 FastBenchmarkResult，不另定义结果结构。 */
function BenchmarkDialog({ open, onClose, provider, model }: { open: boolean; onClose: () => void; provider: RegistryProvider; model: RegistryModel }) {
	const [target, setTarget] = useState<"hostpc" | "computer">("computer");
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
					真实执行未验证：本轮开发未在真实桌面打开测试窗口、也未运行 CUA；开发 / CI 用假 driver，<b>不等于 CUA 成功</b>。下面结果只作参考，样本少时结论有限。
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
									{ value: "computer", label: "助理电脑（虚拟机）" },
									{ value: "hostpc", label: "用户电脑（这台 Mac，需先开启「操作这台电脑」）" },
								]}
								onChange={(v) => setTarget(v as "hostpc" | "computer")}
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
								<Metric label="冷启动（单次）" value={run.coldStartMs == null ? "—" : `${run.coldStartMs}ms`} />
								<Metric label="任务成功率" value={run.samples ? `${Math.round(run.successRatio * 100)}%` : "—"} />
								<Metric label="总用时" value={totalMs(run) == null ? "—" : `${(totalMs(run)! / 1000).toFixed(1)}s`} />
								<Metric label="步骤延迟 p50（诊断）" value={run.p50Ms == null ? "—" : `${run.p50Ms}ms`} />
								<Metric label="步骤 p95" value={run.p95Ms == null ? "—" : `${run.p95Ms}ms${run.p95Approx ? "（粗略）" : ""}`} />
								<Metric label="有效样本" value={String(run.samples)} />
								<Metric label="动作 / 重试" value={`${run.actions} / ${run.retries}`} />
								<Metric label="弃权" value={String(run.abstains)} />
								<Metric label="超时 / 错误" value={`${run.timeouts} / ${run.errors}`} />
								<Metric label="基准任务正确率" value={run.correctness == null ? "—" : `${Math.round(run.correctness * 100)}%`} />
								<Metric label="回退（本轮不执行主模型回退，恒 0）" value={String(run.fallbackCount)} />
							</div>
							{run.note && <div className="text-[11px] text-mut2" data-testid="actual-task-accuracy-note">{run.note}</div>}
							<div className="text-[11px] text-mut2">
								目标：{run.target.prefix === "hostpc" ? "用户电脑" : "助理电脑"} · 模型版本：{run.modelVersion}（未知不编造） · p50 只是步骤诊断，<b>不代表整个 CUA 速度</b>；只针对本轮受控任务，不代表普遍准确。
							</div>
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
/** 总用时：从开始到结束（仅取合约里的 startedAt / finishedAt，不编造其它耗时）。 */
function totalMs(run: FastBenchmarkResult): number | null {
	if (!run.startedAt || !run.finishedAt) return null;
	const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
	return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** 服务卡：图标 + 名称 / 状态 / 能力标签；展开是模型列表（能力可纠正）。 */
function ServiceCard({ provider, open, onToggle, onSaveCaps, onBenchmark }: { provider: RegistryProvider; open: boolean; onToggle: () => void; onSaveCaps: (modelId: string, caps: ModelCapability[]) => void; onBenchmark: (m: RegistryModel) => void }) {
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
								<ModelRow key={`${m.type}:${m.id}`} model={m} onSave={(c) => onSaveCaps(m.id, c)} onBenchmark={onBenchmark} />
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
	const [kind, setKind] = useState<"builtin" | "custom">("builtin");
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [key, setKey] = useState("");
	const submit = () => {
		const id = `demo-${Date.now()}`;
		onAdd({ id, name: name.trim() || (kind === "builtin" ? "OpenAI" : "我的中转"), kind, baseUrl: kind === "builtin" ? undefined : baseUrl.trim() || undefined, configured: !!key, protocols: [], models: [] });
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
						]}
						onChange={(v) => setKind(v as "builtin" | "custom")}
					/>
					<div className="text-[11px] text-mut2">本地模型（Laya）在上面「本地 Laya」卡里一键安装，不在这里添加。</div>
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
				{kind !== "builtin" && (
					<label className="block space-y-1.5 text-xs">
						<span className="font-medium">API Key</span>
						<Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="粘贴 Key（加密保存在本机）" data-testid="add-service-key" />
					</label>
				)}
				<div className="text-[11px] text-mut2">保存后点「载入模型」按对端元数据 / 官方目录识别能力；不做隐式付费探测。</div>
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

/** 原型示例数据（`?unified=1` 且接口未就绪时用）。 */
const DEMO_LAYA: LayaStatus = {
	platform: { key: "darwin-arm64", os: "macOS", arch: "arm64", accelerator: "mps", support: "supported", torchBackend: "default", pins: [], reason: "" },
	install: { state: "installed", phase: "done", received: 0, total: null, error: null, installedAt: Date.now() },
	runtime: { state: "running", pid: 4242, port: 51789, host: "127.0.0.1" },
	health: { ok: true, device: "mps", checkpointDevices: { multilingual: "mps" }, cpuFallbacks: { count: 0, lastReason: null }, revisions: { laya: "abc1234" }, loaded: ["multilingual"] },
	registered: { provider: "local-laya", modelId: "multilingual", protocol: "typesafe-system-one" },
	source: { project: "Laya", repoUrl: "https://example.invalid/laya", weightsOrg: "Laya", codeLicense: "Apache-2.0", weightsLicense: "see repo", version: "v1", reviewedRevisions: {} },
};
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
];

/**
 * 统一模型服务面板。
 * 接口未就绪（`/api/models/registry` 失败）时**默认不渲染**，保持旧界面，避免影响现有 e2e；
 * `?unified=1` 时强制显示并用示例数据预览原型。registry 就绪后由它接管（S5 再接真实生图 / Laya）。
 */
export function ModelServicesPanel({ providers: initial, demo = false, onChange }: { providers?: RegistryProvider[]; demo?: boolean; onChange?: (p: RegistryProvider[]) => void }) {
	const forced = demo || (typeof location !== "undefined" && new URLSearchParams(location.search).has("unified"));
	const [providers, setProviders] = useState<RegistryProvider[]>(initial ?? (forced ? DEMO_PROVIDERS : []));
	const [phase, setPhase] = useState<"loading" | "ready" | "hidden">(initial || forced ? "ready" : "loading");
	const [open, setOpen] = useState<string[]>([]);
	const [q, setQ] = useState("");
	const [addOpen, setAddOpen] = useState(false);
	const [expanded, setExpanded] = useState(true);
	const [bench, setBench] = useState<{ provider: RegistryProvider; model: RegistryModel } | null>(null);
	useEffect(() => {
		if (initial) return;
		let alive = true;
		void api<{ providers: RegistryProvider[] }>("/api/models/registry")
			.then((r) => {
				if (!alive) return;
				setProviders(r.providers);
				setPhase("ready");
			})
			.catch(() => alive && setPhase(forced ? "ready" : "hidden"));
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
	const list = useMemo(() => {
		// 本地 Laya 由管理卡统一展示，registry 里的 local-laya 条目不重复成卡片
		const f = providers.filter((s) => s.id !== "local-laya" && (!q || `${s.name} ${s.id}`.toLowerCase().includes(q.toLowerCase())));
		return [...f].sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
	}, [providers, q]);
	if (phase !== "ready") return null;
	const configured = providers.filter((s) => s.configured).length;
	return (
		<Fold testId="model-services" icon={Gauge} title="模型服务" count={providers.length + 1} hint={configured ? `已配置 ${configured}` : undefined} desc="一个服务 = 一份地址 + 一份凭据，可同时含对话 / 识图 / 生图 / 分类器模型。能力按 Pi 目录或对端元数据识别，猜的标「未确认」，可手动纠正。" open={expanded} onToggle={() => setExpanded((v) => !v)}>
			<div className="space-y-3" data-testid="model-services-panel">
				<LocalLayaCard demo={forced} onBenchmark={(p, m) => setBench({ provider: p, model: m })} />
				<div className="flex flex-wrap items-center gap-2">
					<div className="relative min-w-40 flex-1">
						<Search size={15} className="absolute top-2.5 left-2.5 text-zinc-400" />
						<Input placeholder={`搜索 ${providers.length} 个模型服务…`} value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" data-testid="service-search" />
					</div>
					<Button variant="primary" onClick={() => setAddOpen(true)} data-testid="add-service-open">
						<Plus size={15} /> 添加服务
					</Button>
				</div>
				{!list.length && <div className="rounded-xl border border-dashed border-line p-4 text-center text-xs text-mut">还没有其它模型服务。点「添加服务」选官方 / 自定义。</div>}
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="service-grid">
					{list.map((s) => (
						<ServiceCard key={s.id} provider={s} open={open.includes(s.id)} onToggle={() => setOpen((l) => (l.includes(s.id) ? l.filter((x) => x !== s.id) : [...l, s.id]))} onSaveCaps={(m, c) => saveCaps(s.id, m, c)} onBenchmark={(m) => setBench({ provider: s, model: m })} />
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
