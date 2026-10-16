/**
 * 设置 › 语音配置 › 本地：本地语音识别「多模型」选择器。
 *
 * 数据全部来自 GET /api/local-models/asr/catalog（不写死模型清单）；「安装并使用」= install { intent: install_and_use }，
 * 来源由服务端在装完且选择未变时写（selected）。模型名 + 推荐档位 + 权重大小 + 内存建议精简展示，一键安装；
 * runtime / weights / verify / 配置全在后台。档位与内存是**配置建议、未实测**，允许选更大的模型，不把某档位写成硬门槛。
 * 能力标签（标点 / 多语…）来自 catalog 的 capabilities（真实模型事实），不自己按研究报告臆断。
 * SenseVoice 等存量导入仍由下方旧卡（LocalSenseVoiceCard）保留，许可未确认不新增勾框绕过。
 */
import { AlertTriangle, CheckCircle2, Cpu, Download, HardDrive, Loader2, Play, RefreshCw, RotateCcw, Square, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocalAsrCatalog } from "../hooks/useLocalAsrCatalog";
import { formatBytes, installPercent, isIndeterminate, memoryAdvice, tierLabel } from "../local-asr-intent";
import type { LocalAsrModelView } from "../local-asr-api";
import { Badge, Button, Help, Select, cx } from "./ui";

function StatusBadge({ m }: { m: LocalAsrModelView }) {
	const inst = m.install;
	if (inst.state === "installing") return <Badge tone="amber">{inst.percent != null ? `安装中 ${inst.percent}%` : "安装中"}</Badge>;
	if (inst.state === "failed") return <Badge tone="red">安装失败</Badge>;
	if (!m.installed) return <Badge tone="zinc">未安装</Badge>;
	const rt = m.runtime.state;
	if (rt === "running") return <Badge tone="green">运行中</Badge>;
	if (rt === "starting") return <Badge tone="amber">启动中</Badge>;
	if (rt === "stopping") return <Badge tone="amber">停止中</Badge>;
	if (rt === "crashed") return <Badge tone="red">已崩溃</Badge>;
	return <Badge tone="zinc">已安装 · 未运行</Badge>;
}

export function LocalAsrModels() {
	const { catalog, loading, error, opError, busy, reload, installUse, use, cancel, start, stop, update, remove, clearOpError } = useLocalAsrCatalog();
	const [selectedId, setSelectedId] = useState("");
	const [showDetails, setShowDetails] = useState(false);

	const models = catalog.models;
	// 默认选中：后端推荐的 → 已安装的 → 第一个。用户选择优先，不覆盖。
	useEffect(() => {
		if (selectedId && models.some((m) => m.id === selectedId)) return;
		const next = catalog.recommendedId && models.some((m) => m.id === catalog.recommendedId) ? catalog.recommendedId : (models.find((m) => m.installed)?.id ?? models[0]?.id ?? "");
		setSelectedId(next);
	}, [models, catalog.recommendedId, selectedId]);

	const selected = models.find((m) => m.id === selectedId) ?? null;

	if (loading && !catalog.ok && models.length === 0) {
		return (
			<div className="flex items-center gap-2 rounded-xl border border-dashed border-line p-3 text-xs text-mut" data-testid="local-asr-loading">
				<Loader2 size={14} className="animate-spin" /> 正在读取本地语音模型目录…
			</div>
		);
	}
	if (!catalog.ok) {
		return (
			<div className="space-y-2 rounded-xl border border-dashed border-line p-3 text-xs text-mut" data-testid="local-asr-error">
				<div className="flex flex-wrap items-center gap-2">
					<AlertTriangle size={14} className="shrink-0 text-amber-500" />
					<span className="min-w-0 flex-1">本地语音模型目录暂不可用{error ? `：${error}` : ""}。可用下方既有 SenseVoice 导入，或稍后重试。</span>
					<Button size="sm" variant="outline" onClick={() => void reload()} data-testid="local-asr-reload">
						<RefreshCw size={13} /> 重试
					</Button>
				</div>
			</div>
		);
	}

	const pct = selected ? installPercent(selected.install.received, selected.install.total) : null;
	const indeterminate = selected ? isIndeterminate(selected.install.total) : false;
	const license = selected?.license;
	const licenseBlocked = !!license && license.decision !== "cleared";

	return (
		<div className="space-y-3 rounded-xl border border-line p-3" data-testid="local-asr-models" data-models={models.length}>
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<HardDrive size={14} className="text-mut" />
				<span className="text-sm font-medium">本地语音识别模型</span>
				<Help>
					在本机离线转写，不上传录音、不按量计费。模型全部由服务端目录给出，体积 / 内存是<b>配置建议（估算，未实测）</b>；安装 runtime、权重、校验和配置都在后台完成。「安装并使用」装好后由服务端把语音来源切到它；期间你改选云端 / 另一个模型，先前安装完成不会反过来覆盖你的新选择。
				</Help>
				{models.length > 0 && (
					<span className="ml-auto flex items-center gap-1 text-mut2" data-testid="local-asr-hardware" data-tier={catalog.hardware.tier}>
						<Cpu size={13} /> 这台电脑：{tierLabel(catalog.hardware.tier)}
					</span>
				)}
			</div>
			{catalog.hardware.tierNote && (
				<div className="text-[11px] text-mut2" data-testid="local-asr-tier-note">
					配置建议，未实测。<Help className="ml-1">{catalog.hardware.tierNote}</Help>
				</div>
			)}

			{models.length === 0 ? (
				<div className="rounded-lg border border-dashed border-line p-3 text-xs text-mut" data-testid="local-asr-empty">
					服务端没有返回可选的本地模型（不是前端写死了清单）。可先用下方 SenseVoice 导入，或稍后重试。
				</div>
			) : (
				<>
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-sm text-mut">选择模型</span>
						<Select
							value={selectedId}
							ariaLabel="本地语音识别模型"
							testId="local-asr-model-select"
							className="min-w-[240px]"
							placeholder="选择模型…"
							options={models.map((m) => ({ value: m.id, label: `${m.name}${m.tier !== "unknown" ? `（${tierLabel(m.tier)}）` : ""}`, hint: m.weightsBytes ? formatBytes(m.weightsBytes) : undefined }))}
							onChange={(v) => {
								setSelectedId(v);
								setShowDetails(false);
								clearOpError();
							}}
						/>
					</div>

					{selected && (
						<div className="space-y-2.5 rounded-xl border border-line bg-hover/40 p-3" data-testid="local-asr-detail" data-model-id={selected.id} data-install-state={selected.install.state} data-installed={String(selected.installed)} data-selected={String(selected.selected)}>
							<div className="flex flex-wrap items-center gap-2 text-xs">
								<span className="text-sm font-medium">{selected.name}</span>
								<StatusBadge m={selected} />
								{selected.recommended && (
									<Badge tone="accent">
										推荐
										<Help className="ml-0.5">
											按本机内存档位给出的<b>推荐建议</b>，不是实测跑分。你可以选更大的模型，只是这台机器上可能更慢、更占内存。
										</Help>
									</Badge>
								)}
								{selected.selected && <Badge tone="green">当前使用中</Badge>}
							</div>

							<div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="local-asr-tags">
								{selected.tier !== "unknown" && (
									<span className="rounded-full bg-hover px-2 py-0.5 text-mut" title="推荐档位（建议，非实测）">
										{tierLabel(selected.tier)}
									</span>
								)}
								{selected.capabilities.map((c) => (
									<span key={c} className="rounded-full bg-hover px-2 py-0.5 text-mut">
										{c}
									</span>
								))}
							</div>

							{selected.note && <div className="text-[11px] text-mut">{selected.note}</div>}
							{selected.recommended && selected.recommendationReason && <div className="text-[11px] text-accent" data-testid="local-asr-reason">{selected.recommendationReason}</div>}

							<div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-mut" data-testid="local-asr-sizes">
								<span data-testid="local-asr-weights">权重 {formatBytes(selected.weightsBytes)}</span>
								{selected.depsBytes != null && <span>运行环境另计 {formatBytes(selected.depsBytes)}</span>}
								{selected.depsBytes == null && selected.depsNote && <span>另需运行环境</span>}
								<span data-testid="local-asr-memory">{memoryAdvice(selected.suggestedMemoryBytes, "")}<Help className="ml-1">{selected.memoryNote}</Help></span>
							</div>

							{license && (
								<div className="text-[11px] text-mut2" data-testid="local-asr-license" data-decision={license.decision}>
									许可：{license.decision === "cleared" ? `已确认（${license.licenseName}）` : license.decision === "prohibited" ? `禁止使用（${license.licenseName}）` : `${license.licenseName}·适用范围未最终确认`}
									{licenseBlocked && license.reason && <span className="text-amber-600"> · {license.reason}</span>}
								</div>
							)}

							{/* 安装 / 使用控制 */}
							{selected.install.state === "installing" ? (
								<div className="space-y-1.5 text-[11px]" data-testid="local-asr-progress">
									<div className="flex flex-wrap items-center gap-2 text-mut">
										<span>{selected.install.phaseLabel ?? selected.install.phase ?? "安装中"}</span>
										<span className="text-mut2">{indeterminate ? "总量未知，正在下载" : pct != null ? `${pct}%` : "进行中"}</span>
									</div>
									<div className={cx("pa-dl-bar", indeterminate && "indet")}>
										<i style={indeterminate ? undefined : { width: `${pct ?? 0}%` }} />
									</div>
									<Button size="sm" variant="outline" disabled={busy === selected.id} onClick={() => void cancel(selected)} data-testid="local-asr-cancel">
										<Square size={13} /> 取消
									</Button>
								</div>
							) : selected.install.state === "failed" ? (
								<div className="space-y-1.5">
									<div className="text-[11px] text-red-600" data-testid="local-asr-install-error">
										安装失败：{selected.install.error ?? "未知原因"}
									</div>
									<div className="flex flex-wrap gap-2">
										<Button size="sm" variant="primary" disabled={!!busy || licenseBlocked} onClick={() => void installUse(selected)} data-testid="local-asr-retry">
											{busy === selected.id ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} 重试安装并使用
										</Button>
									</div>
								</div>
							) : !selected.installed ? (
								<div className="flex flex-wrap items-center gap-2">
									<Button size="sm" variant="primary" disabled={!!busy || licenseBlocked || !selected.available} title={!selected.available ? selected.unavailableReason ?? "此平台不支持" : licenseBlocked ? license?.reason : undefined} onClick={() => void installUse(selected)} data-testid="local-asr-install-use">
										{busy === selected.id ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} 安装并使用
									</Button>
									{!selected.available && <span className="text-[11px] text-amber-600" data-testid="local-asr-unavailable">{selected.unavailableReason ?? "此平台暂不支持"}</span>}
									{licenseBlocked && <span className="text-[11px] text-amber-600" data-testid="local-asr-license-blocked">许可未确认，暂不提供下载</span>}
								</div>
							) : selected.selected ? (
								<div className="flex items-center gap-2 text-[11px] text-emerald-600" data-testid="local-asr-in-use">
									<CheckCircle2 size={13} /> 已设为语音来源
								</div>
							) : (
								<div className="flex flex-wrap gap-2">
									<Button size="sm" variant="primary" disabled={!!busy} onClick={() => void use(selected)} data-testid="local-asr-use">
										{busy === selected.id ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} 使用这个模型
									</Button>
								</div>
							)}

							{opError && (
								<div className="text-[11px] text-red-600" data-testid="local-asr-op-error">
									{opError}
								</div>
							)}

							{/* 详情：来源 / 运行态 / 启动停止 / 删除，按需展开 */}
							<div className="text-[11px]">
								<button type="button" className="text-mut2 underline underline-offset-2" aria-expanded={showDetails} onClick={() => setShowDetails((v) => !v)} data-testid="local-asr-details-toggle">
									{showDetails ? "收起详情" : "详情"}
								</button>
								{showDetails && (
									<div className="mt-1 space-y-1.5 text-mut2" data-testid="local-asr-details">
										{selected.nameEn && <div>模型：{selected.nameEn}</div>}
										{selected.languages.length > 0 && <div>语言：{selected.languages.join(" / ")}</div>}
										{catalog.runtime.version && (
											<div data-testid="local-asr-engine">
												共享运行环境：{catalog.runtime.engine} {catalog.runtime.version}
												{catalog.runtime.python ? ` · Python ${catalog.runtime.python}` : ""}
												{catalog.runtime.depsNote ? ` · ${catalog.runtime.depsNote}` : ""}
											</div>
										)}
										{selected.source.project && (
											<div data-testid="local-asr-source">
												来源：{selected.source.project}
												{selected.source.revision ? ` @ ${selected.source.revision.slice(0, 10)}` : ""}
												{selected.source.files.length > 0 ? ` · ${selected.source.files.length} 个权重文件已固定 SHA256` : ""}
												{selected.source.weightsLicense ? ` · 权重许可 ${selected.source.weightsLicense}` : ""}
											</div>
										)}
										<div data-testid="local-asr-runtime">
											运行态：{selected.runtime.state}
											{selected.runtime.restarts > 0 ? ` · 重启 ${selected.runtime.restarts} 次` : ""}
											{selected.runtime.lastError ? ` · ${selected.runtime.lastError}` : ""}
										</div>
										{selected.install.jobId && <div data-testid="local-asr-job">下载组件 id：{selected.downloadId}{selected.install.attempt != null ? ` · 第 ${selected.install.attempt} 次尝试` : ""}</div>}
										{selected.install.installedAt && <div>安装时间：{new Date(selected.install.installedAt).toLocaleString("zh-CN")}</div>}
										{selected.installed && (
											<div className="flex flex-wrap gap-2 pt-0.5">
												{selected.runtime.state === "running" ? (
													<Button size="sm" variant="outline" disabled={!!busy} onClick={() => void stop(selected)} data-testid="local-asr-stop">
														<Square size={12} /> 停止
													</Button>
												) : (
													<Button size="sm" variant="outline" disabled={!!busy} onClick={() => void start(selected)} data-testid="local-asr-start">
														<Play size={12} /> 启动
													</Button>
												)}
												<Button size="sm" variant="outline" disabled={!!busy} onClick={() => void update(selected)} data-testid="local-asr-update">
													<RefreshCw size={12} /> 更新
												</Button>
												<Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void remove(selected)} data-testid="local-asr-remove">
													<Trash2 size={12} /> 删除
												</Button>
											</div>
										)}
										{catalog.notes.length > 0 && (
											<ul className="list-disc space-y-0.5 pl-4" data-testid="local-asr-notes">
												{catalog.notes.map((n) => (
													<li key={n}>{n}</li>
												))}
											</ul>
										)}
									</div>
								)}
							</div>
						</div>
					)}
				</>
			)}
		</div>
	);
}
