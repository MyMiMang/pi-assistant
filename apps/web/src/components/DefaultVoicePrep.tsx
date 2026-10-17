/**
 * 默认本地语音的**准备状态行**（设置页 & 本地模型详情用）。
 *
 * 只读展示 + 取消 / 重试（都走统一下载组件 `asr:<modelId>` 同一个 job）；**不写 source**、
 * 不加「我同意」勾选、不催用户手动找文件。首次需联网如实写明（未知时绝不说可离线）。
 */
import { Loader2, RotateCcw, Square } from "lucide-react";
import { useDefaultVoicePrep } from "../hooks/useDefaultVoicePrep";
import { canCancelPrepare, canRetryPrepare, firstUseNote, preparePercent, voicePrepareLabel, voicePrepareTone } from "../voice-pref";
import { Badge, Button, Help, cx } from "./ui";

const TONE_CLASS: Record<string, string> = { green: "text-emerald-600", amber: "text-amber-600", red: "text-red-600", zinc: "text-mut" };

export function DefaultVoicePrepPanel({ variant = "full" }: { variant?: "full" | "inline" }) {
	const { prep, loading, busy, error, cancel, retry } = useDefaultVoicePrep();
	if (!prep) return null;
	if (!prep.ok) return null; // 结构不认识：什么都不显示，避免瞎说
	if (prep.state === "not_applicable") {
		if (variant === "inline") return null;
		return (
			<div className="text-[11px] text-mut2" data-testid="default-voice-prep" data-state="not_applicable">
				服务端目录里没有标记为「默认本地语音」的模型（不猜、不回落）。
			</div>
		);
	}

	const pct = preparePercent(prep);
	const indeterminate = pct == null && prep.state === "preparing";
	const note = firstUseNote(prep);
	const tone = voicePrepareTone(prep);
	const showActions = (canCancelPrepare(prep) || canRetryPrepare(prep)) && prep.state !== "ready";
	const label = voicePrepareLabel(prep);

	return (
		<div className={cx("space-y-1.5 rounded-xl border border-line p-2.5", variant === "inline" && "bg-hover/40")} data-testid="default-voice-prep" data-state={prep.state} data-job-id={prep.jobId ?? ""}>
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<span className="font-medium">默认本地语音</span>
				<span data-testid="default-voice-prep-state">
					<Badge tone={tone}>{label}</Badge>
				</span>
				{variant === "full" && (
					<Help>
						首次使用需联网自动准备（权重 + 共享运行时），之后可离线使用；**不随安装包分发该权重**。
						准备过程不需要手动点下载 / 找文件；进度与「下载与组件」是同一个任务，可取消、失败可重试。
						准备 / 预热不会申请麦克风权限。
					</Help>
				)}
				{loading && <Loader2 size={12} className="animate-spin text-mut2" />}
			</div>

			{prep.state === "preparing" && (
				<div className="space-y-1" data-testid="default-voice-prep-progress">
					<div className="flex items-center gap-2 text-[11px] text-mut">
						<span>{prep.phaseLabel ?? prep.phase ?? "准备中"}</span>
						<span className="text-mut2">{pct != null ? `${pct}%` : "总量未知，正在准备"}</span>
					</div>
					<div className={cx("pa-dl-bar", indeterminate && "indet")}>
						<i style={indeterminate ? undefined : { width: `${pct ?? 0}%` }} />
					</div>
				</div>
			)}

			{prep.state === "failed" && prep.error && (
				<div className="text-[11px] text-red-600" data-testid="default-voice-prep-error">
					准备失败：{prep.error}
					{!prep.retryable && "（此错误不建议重试）"}
				</div>
			)}
			{prep.state === "ready" && <div className="text-[11px] text-emerald-600">已准备完成，可以直接用语音输入。</div>}
			{error && (
				<div className="text-[11px] text-red-600" data-testid="default-voice-prep-op-error">
					操作失败：{error}
				</div>
			)}

			{note && (
				<div className={cx("text-[11px]", TONE_CLASS[tone])} data-testid="default-voice-prep-note">
					{note}
				</div>
			)}

			{showActions && (
				<div className="flex flex-wrap gap-2">
					{canCancelPrepare(prep) && (
						<Button size="sm" variant="outline" disabled={busy} onClick={() => void cancel()} data-testid="default-voice-prep-cancel">
							{busy ? <Loader2 size={13} className="animate-spin" /> : <Square size={12} />} 取消准备
						</Button>
					)}
					{canRetryPrepare(prep) && (
						<Button size="sm" variant="primary" disabled={busy} onClick={() => void retry()} data-testid="default-voice-prep-retry">
							{busy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} 重试准备
						</Button>
					)}
				</div>
			)}
		</div>
	);
}
