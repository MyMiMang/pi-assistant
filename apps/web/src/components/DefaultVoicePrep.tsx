/**
 * 本地语音识别（**可选模块**，决策 0013）的状态卡：设置 › 语音 › 本地，以及本地模型详情里的就地状态。
 *
 * 默认不安装：未安装时一行说明 + 「安装本地语音」；安装中显示真实进度 + 取消；失败给原因 + 重试；
 * 装好后若还不是语音来源，给「设为语音来源」。安装 / 取消走默认语音窄接口，进度与「下载与组件」是同一个 job。
 * 云端语音不依赖本模块。详细说明（体积、许可、无标点、麦克风）放「?」。
 */
import { CheckCircle2, Download, Loader2, RotateCcw, Square } from "lucide-react";
import { useDefaultVoicePrep } from "../hooks/useDefaultVoicePrep";
import { canCancelPrepare, canInstallPrepare, firstUseNote, preparePercent, voicePrepareLabel, voicePrepareTone } from "../voice-pref";
import { Badge, Button, Help, cx } from "./ui";

export function DefaultVoicePrepPanel({ variant = "full" }: { variant?: "full" | "inline" }) {
	const { prep, loading, busy, error, inUse, defaultSource, cancel, install, adopt } = useDefaultVoicePrep();
	if (!prep || !prep.ok) return null; // 结构不认识：什么都不显示，避免瞎说
	if (prep.state === "not_applicable") return null;

	const pct = preparePercent(prep);
	const indeterminate = pct == null && prep.state === "preparing";
	const tone = voicePrepareTone(prep);
	const full = variant === "full";

	return (
		<div className={cx("space-y-2 rounded-xl border border-line p-3", !full && "bg-hover/40 p-2.5")} data-testid="default-voice-prep" data-state={prep.state} data-job-id={prep.jobId ?? ""}>
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<span className={cx("font-medium", full && "text-sm")}>本地语音识别</span>
				<Badge tone="zinc">可选模块</Badge>
				<span data-testid="default-voice-prep-state">
					<Badge tone={tone}>{voicePrepareLabel(prep)}</Badge>
				</span>
				{full && (
					<Help>
						本地语音识别不随安装包分发、默认不安装；点「安装」后才联网下载运行环境和默认模型（中英双语、边说边出字），之后可离线使用。
						下载进度与「设置 › 下载与组件」是同一个任务，可取消、失败可重试；不想用了可在下方模型详情里删除。
						默认流式模型输出没有标点。安装和预热不会申请麦克风权限。云端语音不需要安装它。
					</Help>
				)}
				{loading && <Loader2 size={12} className="animate-spin text-mut2" />}
			</div>

			{full && <div className="text-xs text-mut">在这台电脑上把语音转成文字，录音不出电脑、不按量计费。</div>}
			{prep.state !== "ready" && (
				<div className="text-[11px] text-mut2" data-testid="default-voice-prep-note">
					{firstUseNote(prep)}
				</div>
			)}

			{prep.state === "preparing" && (
				<div className="space-y-1" data-testid="default-voice-prep-progress">
					<div className="flex items-center gap-2 text-[11px] text-mut">
						<span>{prep.phaseLabel ?? prep.phase ?? "安装中"}</span>
						<span className="text-mut2">{pct != null ? `${pct}%` : "总量未知，正在下载"}</span>
					</div>
					<div className={cx("pa-dl-bar", indeterminate && "indet")}>
						<i style={indeterminate ? undefined : { width: `${pct ?? 0}%` }} />
					</div>
				</div>
			)}
			{prep.state === "failed" && prep.error && (
				<div className="text-[11px] text-red-600" data-testid="default-voice-prep-error">
					安装失败：{prep.error}
				</div>
			)}
			{error && (
				<div className="text-[11px] text-red-600" data-testid="default-voice-prep-op-error">
					操作失败：{error}
				</div>
			)}

			<div className="flex flex-wrap items-center gap-2">
				{canInstallPrepare(prep) && (
					<Button size="sm" variant="primary" disabled={busy} onClick={() => void install()} data-testid={prep.state === "failed" ? "default-voice-prep-retry" : "default-voice-prep-install"}>
						{busy ? <Loader2 size={13} className="animate-spin" /> : prep.state === "failed" ? <RotateCcw size={13} /> : <Download size={13} />} {prep.state === "failed" ? "重试安装" : "安装本地语音"}
					</Button>
				)}
				{canCancelPrepare(prep) && (
					<Button size="sm" variant="outline" disabled={busy} onClick={() => void cancel()} data-testid="default-voice-prep-cancel">
						{busy ? <Loader2 size={13} className="animate-spin" /> : <Square size={12} />} 取消安装
					</Button>
				)}
				{prep.state === "ready" &&
					(inUse ? (
						<span className="inline-flex items-center gap-1 text-[11px] text-emerald-600" data-testid="default-voice-in-use">
							<CheckCircle2 size={13} /> 正在作为语音来源
						</span>
					) : (
						defaultSource && (
							<Button size="sm" variant="primary" disabled={busy} onClick={() => void adopt()} data-testid="default-voice-adopt">
								{busy ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} 设为语音来源
							</Button>
						)
					))}
			</div>
		</div>
	);
}
