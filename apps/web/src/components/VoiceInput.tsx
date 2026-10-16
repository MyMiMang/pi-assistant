/**
 * 语音输入按钮（发送键旁，可发现）：点麦克风开始录音，再点停止 → 转写成文字草稿。
 *
 * 独立组件，不改整个 composer：主会话 / 群聊 / 子代理三处都复用它，只加一行。
 * 逻辑与浏览器管线在 `../voice-input.ts` 与 `../hooks/useVoiceInput.ts`；这里只做 UI 与草稿插入。
 *
 * 行为（docs/design/voice-input.md）：不自动发送、不自动重试；结果插到开始录制时的光标锚点并保留用户后续编辑；
 * IME 组合中推迟插入；取消只丢语音、不动草稿与引用；切对话 / 页面隐藏由 hook 停轨道取消。
 *
 * 本地 ASR = **分段增量**（停顿 VAD + 最长窗口，非原生流式）：边说边出字，每段唯一 requestId、单并发、有界队列；
 * 云端保持**整段一次请求**（避免每个分段都算一次最小计费）。录音时展示**真实 PCM 音量**（RMS 平滑 + 限频），
 * 静音近零、不做假循环波形。
 *
 * 入口克制（用户 UI 修正）：idle 只有紧贴发送键的麦克风图标，**不常驻状态行 / 「去设置」**；
 * 没配 ASR 时把说明放在按钮 title。只有用户点了麦克风、hook 回 `asr_not_configured` 时，
 * 才短暂浮现短说明 + 「去设置」；取消、切会话、点「去设置」后都清掉临时提示。
 */
import { Loader2, Mic, RotateCcw, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useVoiceInput } from "../hooks/useVoiceInput";
import { useStore } from "../store";
import { insertAtAnchor, shouldInsert, VoiceDraftAssembler, type VoiceResult, type VoiceSegment } from "../voice-input";

export interface VoiceInputProps {
	agentId?: string;
	conversationId?: string;
	/** 输入框（取光标锚点 / 判断 IME 组合）。 */
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
	/** 当前草稿文本。 */
	value: string;
	/** 插入后回写文本并把光标放到插入末尾。 */
	onChange: (next: string, cursor: number) => void;
	/** 引用回复（msg 引用子任务引入）；语音取消 / 插入都不动它。 */
	replyTo?: string | null;
	disabled?: boolean;
}

/** 真实音量条的格数（每格一段历史 RMS，不循环、不伪装）。 */
const LEVEL_BARS = 24;

export function VoiceInput({ agentId, conversationId, textareaRef, value, onChange, replyTo = null, disabled = false }: VoiceInputProps) {
	const valueRef = useRef(value);
	valueRef.current = value;
	const composing = useRef(false);
	const pending = useRef<string | null>(null);
	const anchorRef = useRef(0);
	const assembler = useRef<VoiceDraftAssembler | null>(null);
	const pendingSegs = useRef<string[]>([]);
	const [notice, setNotice] = useState("");
	const [levels, setLevels] = useState<number[]>(() => new Array(LEVEL_BARS).fill(0));

	// 批量（云端）结果：插到锚点。
	const apply = (text: string) => {
		const r = insertAtAnchor({ text: valueRef.current, anchor: anchorRef.current, replyTo }, text, { composing: composing.current });
		if (r.deferred) {
			pending.current = text;
			return;
		}
		valueRef.current = r.draft.text;
		onChange(r.draft.text, r.cursor);
	};

	// 增量（本地）结果：按序追加到语音块末尾，保留用户在别处的编辑。
	const appendSegments = (segs: string[]) => {
		const a = assembler.current;
		if (!a) return;
		let text = valueRef.current;
		let cursor = a.cursor;
		for (const s of segs) {
			const r = a.append(text, s);
			text = r.text;
			cursor = r.cursor;
		}
		valueRef.current = text;
		onChange(text, cursor);
	};

	const onResult = (r: VoiceResult) => {
		if (!shouldInsert({ agentId: r.agentId, conversationId: r.conversationId }, { agentId, conversationId })) return; // 切了会话：不插入
		anchorRef.current = r.anchor;
		setNotice("");
		apply(r.text);
	};

	const onSegment = (s: VoiceSegment) => {
		if (!shouldInsert({ agentId: s.agentId, conversationId: s.conversationId }, { agentId, conversationId })) return; // 切了会话：不插入
		if (!assembler.current) assembler.current = new VoiceDraftAssembler(s.anchor, valueRef.current);
		setNotice("");
		if (composing.current) {
			pendingSegs.current.push(s.text);
			return;
		}
		appendSegments([s.text]);
	};

	const voice = useVoiceInput({ agentId, conversationId, getAnchor: () => textareaRef.current?.selectionStart ?? valueRef.current.length, onResult, onSegment });
	const openSettings = useStore((s) => s.set);

	// 真实音量历史：只在录音时滚动更新；停止立即清零（不残留假波形）。
	useEffect(() => {
		if (voice.state !== "recording") {
			setLevels((prev) => (prev.every((v) => v === 0) ? prev : new Array(LEVEL_BARS).fill(0)));
			return;
		}
		setLevels((prev) => [...prev.slice(1), voice.level]);
	}, [voice.level, voice.state]);

	// IME 组合状态：组合中不插入（推迟到 compositionend），不打断候选。
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		const onStart = () => {
			composing.current = true;
		};
		const onEnd = () => {
			composing.current = false;
			if (pending.current !== null) {
				const text = pending.current;
				pending.current = null;
				apply(text);
			}
			if (pendingSegs.current.length) {
				const segs = pendingSegs.current;
				pendingSegs.current = [];
				appendSegments(segs);
			}
		};
		el.addEventListener("compositionstart", onStart);
		el.addEventListener("compositionend", onEnd);
		return () => {
			el.removeEventListener("compositionstart", onStart);
			el.removeEventListener("compositionend", onEnd);
		};
	}, [textareaRef]);

	useEffect(() => {
		setNotice(voice.error?.message ?? "");
	}, [voice.error]);
	// 切会话 / 换助理：停轨道 + 释放租约 + 清掉 hook 错误与临时提示（旧的麦克风错误不留到新对话里）。
	useEffect(() => {
		setNotice("");
		assembler.current = null;
		pendingSegs.current = [];
		voice.resetContext();
	}, [agentId, conversationId, voice.resetContext]);

	const recording = voice.state === "recording";
	const busy = voice.state === "preparing" || voice.state === "transcribing";
	const label = !voice.supported ? (voice.unsupportedReason === "insecure_context" ? "需要 HTTPS 或本机地址才能用麦克风" : "当前浏览器不支持麦克风") : !voice.asrModel ? "未配置语音识别模型（设置 › 语音配置）" : recording ? "停止录音并转写" : "语音输入";
	// 只有「用户点了麦克风、hook 回了语音来源类错误」才浮现设置入口；
	// idle 不常驻状态行、不常驻「去设置」——没配 ASR 时的说明放在按钮 title 里。
	const asrSetupCodes = new Set(["asr_not_configured", "asr_unavailable", "asr_not_installed", "asr_deleted"]);
	const needSetup = !!voice.error && asrSetupCodes.has(voice.error.code) && !recording;
	const failed = voice.progress.failed;
	const pendingCount = voice.progress.pending + voice.progress.inflight;
	// notice 只在「点过麦克风之后」才有值：其它错误也只在这时短暂提示，不常驻。
	const hint =
		notice ||
		(recording
			? voice.progress.backlog
				? "转写跟不上，仍在录音（不会丢音频）"
				: pendingCount > 0
					? `正在听…（${pendingCount} 段转写中）`
					: "正在听…（点停止）"
			: busy
				? "转写中…"
				: "");
	const showSettings = needSetup;
	const showRetry = failed > 0 && !recording && !busy;

	// 开始新一次录音前清掉上一轮的增量装配状态（不把上一段顺序带进来）。
	const startFresh = () => {
		assembler.current = null;
		pendingSegs.current = [];
		setNotice("");
		voice.start();
	};

	// 结构约定（用户 UI 修正）：麦克风 / 停止 / 取消固定贴在发送键左侧，包在 .pa-voice-ctl 里不换行、不挤压右组；
	// 提示文字与「去设置」放进 .pa-voice-status（CSS order:1 + flex-basis:100%），单独占一行，不动发送键。
	return (
		<>
			<span className="pa-voice-ctl">
				{recording ? (
					<>
						{/* 真实音量（aria-hidden：状态由下方文字传达） */}
						<span className="pa-voice-level" data-testid="voice-level" aria-hidden="true">
							{levels.map((v, i) => (
								<i key={i} data-level={v.toFixed(2)} style={{ height: `${Math.round(3 + v * 15)}px` }} />
							))}
						</span>
						<button type="button" className="pa-icon-btn ghost pa-voice-rec" data-testid="voice-stop" aria-label="停止录音并转写" title="停止录音并转写" onClick={voice.stop}>
							<Square size={13} fill="currentColor" />
						</button>
						<button type="button" className="pa-icon-btn ghost" data-testid="voice-cancel" aria-label="取消语音输入" title="取消（不发送）" onClick={() => { setNotice(""); assembler.current = null; pendingSegs.current = []; voice.cancel(); }}>
							<X className="pa-ic" />
						</button>
					</>
				) : (
					<button
						type="button"
						className="pa-icon-btn ghost"
						data-testid="voice-mic"
						aria-label={label}
						aria-pressed={false}
						title={hint || label}
						disabled={disabled || busy}
						onClick={startFresh}
					>
						{busy ? <Loader2 className="pa-ic animate-spin" /> : <Mic className="pa-ic" />}
					</button>
				)}
			</span>
			{(hint || showSettings || showRetry) && (
				<div className="pa-voice-status" data-testid="voice-status">
					{hint && <span className="pa-voice-hint max-w-[180px] truncate text-[11px] text-mut2" data-testid="voice-hint" title={hint}>{hint}</span>}
					{showRetry && (
						<button type="button" className="shrink-0 text-[11px] text-accent underline" data-testid="voice-retry" onClick={() => { setNotice(""); voice.retryFailed(); }}>
							重试这段
						</button>
					)}
					{showSettings && (
						<button type="button" className="shrink-0 text-[11px] text-accent underline" data-testid="voice-open-settings" onClick={() => { setNotice(""); voice.dismissError(); openSettings({ settings: "voice" }); }}>
							去设置
						</button>
					)}
				</div>
			)}
		</>
	);
}
