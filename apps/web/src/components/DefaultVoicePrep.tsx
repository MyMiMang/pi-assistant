/**
 * 本地语音识别（**可选模块**，决策 0013）的模块卡：设置 › 语音 › 本地 的最上方。
 *
 * 默认不安装。未安装时**先选再装**：直接给模型选择器（复用 ui.tsx 的 Select + 本地模型目录，预选目录默认），
 * 每项一行「适合什么」+ 大约下载量（共享运行环境只算一次），按钮「安装所选模型」只装这一个模型（+ 首次的运行环境），
 * 装完由服务端设为语音来源（期间改选过就不覆盖，给「设为语音来源」）。安装中显示真实进度 + 取消；失败给原因 + 重试，
 * 也可改选别的模型再装。安装 / 取消走本地语音窄接口，进度与「下载与组件」是同一个 job。
 * 云端语音不依赖本模块。详细说明（体积、许可、标点、麦克风）放「?」。
 */
import { CheckCircle2, Download, Loader2, RotateCcw, Square } from "lucide-react";
import { useDefaultVoicePrep } from "../hooks/useDefaultVoicePrep";
import { formatBytes, localVoiceDownloadBytes, localVoiceOption } from "../local-asr-intent";
import type { LocalAsrModelView, LocalAsrRuntimeEnvView } from "../local-asr-api";
import { canCancelPrepare, canInstallPrepare, firstUseNote, preparePercent, voicePrepareLabel, voicePrepareTone } from "../voice-pref";
import { Badge, Button, Help, Select, cx } from "./ui";

/** 安装前的模型选择（由 LocalAsrModels 传入：同一份目录、同一个下拉状态与 localAsrPick 逻辑）。 */
export interface LocalVoiceChoice {
	models: LocalAsrModelView[];
	runtime: LocalAsrRuntimeEnvView;
	value: string;
	onChange: (id: string) => void;
}

export function DefaultVoicePrepPanel({ choice }: { choice?: LocalVoiceChoice }) {
	const { prep, loading, busy, error, inUse, moduleSource, cancel, install, adopt } = useDefaultVoicePrep();
	if (!prep || !prep.ok) return null; // 结构不认识：什么都不显示，避免瞎说
	if (prep.state === "not_applicable") return null;

	const pct = preparePercent(prep);
	const indeterminate = pct == null && prep.state === "preparing";
	const tone = voicePrepareTone(prep);
	const failed = prep.state === "failed";
	// 先选再装：未安装 / 失败时给选择器（目录读不到时退回只装默认）。
	const picking = canInstallPrepare(prep) && !!choice && choice.models.length > 0;
	const chosen = picking ? (choice.models.find((m) => m.id === choice.value) ?? null) : null;
	const retrying = failed && (!chosen || chosen.id === prep.modelId);
	const chosenOpt = chosen && choice ? localVoiceOption(chosen, choice.runtime) : null;
	const runtimeOnce = choice && !choice.runtime.present && choice.runtime.downloadBytes ? `，含共享运行环境约 ${formatBytes(choice.runtime.downloadBytes)}，只下载一次` : "";

	return (
		<div className="space-y-2 rounded-xl border border-line p-3" data-testid="default-voice-prep" data-state={prep.state} data-job-id={prep.jobId ?? ""} data-model-id={prep.modelId ?? ""}>
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<span className="text-sm font-medium">本地语音识别</span>
				<Badge tone="zinc">可选模块</Badge>
				<span data-testid="default-voice-prep-state">
					<Badge tone={tone}>{voicePrepareLabel(prep)}</Badge>
				</span>
				<Help>
					本地语音识别不随安装包分发、默认不安装。先选一个模型，点「安装所选模型」才联网下载：只下这一个模型，第一次另下共享运行环境（所有模型共用，只下一次），之后可离线使用；装好就设为语音来源。
					下载进度与「设置 › 下载与组件」是同一个任务，可取消、失败可重试；不想用了可在下方模型详情里删除。大小都是估算。安装和预热不会申请麦克风权限。云端语音不需要安装它。
				</Help>
				{loading && <Loader2 size={12} className="animate-spin text-mut2" />}
			</div>

			<div className="text-xs text-mut">在这台电脑上把语音转成文字，录音不出电脑、不按量计费。</div>

			{picking && choice ? (
				<div className="space-y-1.5" data-testid="default-voice-choice">
					<Select
						value={choice.value}
						ariaLabel="选择要安装的本地语音模型"
						testId="default-voice-model-select"
						className="w-full max-w-[420px]"
						menuMinWidth={320}
						disabled={busy}
						options={choice.models.map((m) => localVoiceOption(m, choice.runtime))}
						onChange={choice.onChange}
					/>
					{chosen && chosenOpt && (
						<div className="text-[11px] text-mut2" data-testid="default-voice-choice-note" data-bytes={localVoiceDownloadBytes(chosen, choice.runtime)}>
							{chosenOpt.desc} · 下载{chosenOpt.hint}（估算{runtimeOnce}），装好后可离线使用
						</div>
					)}
				</div>
			) : (
				prep.state !== "ready" &&
				prep.state !== "preparing" && (
					<div className="text-[11px] text-mut2" data-testid="default-voice-prep-note">
						{firstUseNote(prep)}
					</div>
				)
			)}

			{prep.state === "preparing" && (
				<div className="space-y-1" data-testid="default-voice-prep-progress">
					<div className="flex flex-wrap items-center gap-2 text-[11px] text-mut">
						{prep.modelName && <span className="font-medium text-fg" data-testid="default-voice-prep-model">{prep.modelName}</span>}
						<span>{prep.phaseLabel ?? prep.phase ?? "安装中"}</span>
						<span className="text-mut2">{pct != null ? `${pct}%` : "总量未知，正在下载"}</span>
					</div>
					<div className={cx("pa-dl-bar", indeterminate && "indet")}>
						<i style={indeterminate ? undefined : { width: `${pct ?? 0}%` }} />
					</div>
				</div>
			)}
			{failed && prep.error && (
				<div className="text-[11px] text-red-600" data-testid="default-voice-prep-error">
					{prep.modelName ? `${prep.modelName} ` : ""}安装失败：{prep.error}
				</div>
			)}
			{error && (
				<div className="text-[11px] text-red-600" data-testid="default-voice-prep-op-error">
					操作失败：{error}
				</div>
			)}

			<div className="flex flex-wrap items-center gap-2">
				{canInstallPrepare(prep) && (
					<Button
						size="sm"
						variant="primary"
						disabled={busy || (!!chosen && !chosen.available)}
						title={chosen && !chosen.available ? (chosen.unavailableReason ?? undefined) : undefined}
						onClick={() => void install(retrying ? undefined : (chosen?.id ?? undefined))}
						data-testid={retrying ? "default-voice-prep-retry" : "default-voice-prep-install"}
					>
						{busy ? <Loader2 size={13} className="animate-spin" /> : retrying ? <RotateCcw size={13} /> : <Download size={13} />} {retrying ? "重试安装" : chosen ? "安装所选模型" : "安装本地语音"}
					</Button>
				)}
				{canCancelPrepare(prep) && (
					<Button size="sm" variant="outline" disabled={busy} onClick={() => void cancel()} data-testid="default-voice-prep-cancel">
						{busy ? <Loader2 size={13} className="animate-spin" /> : <Square size={12} />} 取消安装
					</Button>
				)}
				{prep.state === "ready" && prep.modelName && <span className="text-[11px] text-mut" data-testid="default-voice-prep-model">已装：{prep.modelName}</span>}
				{prep.state === "ready" &&
					(inUse ? (
						<span className="inline-flex items-center gap-1 text-[11px] text-emerald-600" data-testid="default-voice-in-use">
							<CheckCircle2 size={13} /> 正在作为语音来源
						</span>
					) : (
						moduleSource && (
							<Button size="sm" variant="primary" disabled={busy} onClick={() => void adopt()} data-testid="default-voice-adopt">
								{busy ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} 设为语音来源
							</Button>
						)
					))}
			</div>
		</div>
	);
}
