/**
 * 语音输入按钮（发送键旁，可发现）：点麦克风开始录音，再点停止 → 转写成文字草稿。
 *
 * 独立组件，不改整个 composer：主会话 / 群聊 / 子代理三处都复用它，只加一行。
 * 逻辑与浏览器管线在 `../voice-input.ts` 与 `../hooks/useVoiceInput.ts`；这里只做 UI 与草稿插入。
 *
 * 行为（docs/design/voice-input.md）：不自动发送、不自动重试；结果插到开始录制时的光标锚点并保留用户后续编辑；
 * IME 组合中推迟插入；取消只丢语音、不动草稿与引用；切对话 / 页面隐藏由 hook 停轨道取消。
 *
 * 入口克制（用户 UI 修正）：idle 只有紧贴发送键的麦克风图标，**不常驻状态行 / 「去设置」**；
 * 没配 ASR 时把说明放在按钮 title。只有用户点了麦克风、hook 回 `asr_not_configured` 时，
 * 才短暂浮现短说明 + 「去设置」；取消、切会话、点「去设置」后都清掉临时提示。
 */
import { Loader2, Mic, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useVoiceInput } from "../hooks/useVoiceInput";
import { useStore } from "../store";
import { insertAtAnchor, shouldInsert, type VoiceResult } from "../voice-input";

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

export function VoiceInput({ agentId, conversationId, textareaRef, value, onChange, replyTo = null, disabled = false }: VoiceInputProps) {
	const valueRef = useRef(value);
	valueRef.current = value;
	const composing = useRef(false);
	const pending = useRef<string | null>(null);
	const anchorRef = useRef(0);
	const [notice, setNotice] = useState("");

	const apply = (text: string) => {
		const r = insertAtAnchor({ text: valueRef.current, anchor: anchorRef.current, replyTo }, text, { composing: composing.current });
		if (r.deferred) {
			pending.current = text;
			return;
		}
		valueRef.current = r.draft.text;
		onChange(r.draft.text, r.cursor);
	};

	const onResult = (r: VoiceResult) => {
		if (!shouldInsert({ agentId: r.agentId, conversationId: r.conversationId }, { agentId, conversationId })) return; // 切了会话：不插入
		anchorRef.current = r.anchor;
		setNotice("");
		apply(r.text);
	};

	const voice = useVoiceInput({ agentId, conversationId, getAnchor: () => textareaRef.current?.selectionStart ?? valueRef.current.length, onResult });
	const openSettings = useStore((s) => s.set);

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
	// 切会话 / 换助理：临时提示不跟着走（旧的麦克风错误不留到新对话里）。
	useEffect(() => {
		setNotice("");
	}, [agentId, conversationId]);

	const recording = voice.state === "recording";
	const busy = voice.state === "preparing" || voice.state === "transcribing";
	const label = !voice.supported ? (voice.unsupportedReason === "insecure_context" ? "需要 HTTPS 或本机地址才能用麦克风" : "当前浏览器不支持麦克风") : !voice.asrModel ? "未配置语音识别模型" : recording ? "停止录音并转写" : "语音输入";
	// 只有「用户点了麦克风、hook 回 asr_not_configured」才浮现设置入口；
	// idle 不常驻状态行、不常驻「去设置」——没配 ASR 时的说明放在按钮 title 里。
	const needSetup = voice.error?.code === "asr_not_configured" && !recording;
	// notice 只在「点过麦克风之后」才有值：其它错误也只在这时短暂提示，不常驻。
	const hint = notice || (recording ? "正在听…（点停止）" : busy ? "转写中…" : "");
	const showSettings = needSetup;

	// 结构约定（用户 UI 修正）：麦克风 / 停止 / 取消固定贴在发送键左侧，包在 .pa-voice-ctl 里不换行、不挤压右组；
	// 提示文字与「去设置」放进 .pa-voice-status（CSS order:1 + flex-basis:100%），单独占一行，不动发送键。
	return (
		<>
			<span className="pa-voice-ctl">
				{recording ? (
					<>
						<button type="button" className="pa-icon-btn ghost pa-voice-rec" data-testid="voice-stop" aria-label="停止录音并转写" title="停止录音并转写" onClick={voice.stop}>
							<Square size={13} fill="currentColor" />
						</button>
						<button type="button" className="pa-icon-btn ghost" data-testid="voice-cancel" aria-label="取消语音输入" title="取消（不发送）" onClick={() => { setNotice(""); voice.cancel(); }}>
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
						onClick={voice.start}
					>
						{busy ? <Loader2 className="pa-ic animate-spin" /> : <Mic className="pa-ic" />}
					</button>
				)}
			</span>
			{(hint || showSettings) && (
				<div className="pa-voice-status" data-testid="voice-status">
					{hint && <span className="pa-voice-hint max-w-[180px] truncate text-[11px] text-mut2" data-testid="voice-hint" title={hint}>{hint}</span>}
					{showSettings && (
						<button type="button" className="shrink-0 text-[11px] text-accent underline" data-testid="voice-open-settings" onClick={() => { setNotice(""); openSettings({ settings: "models" }); }}>
							去设置
						</button>
					)}
				</div>
			)}
		</>
	);
}
