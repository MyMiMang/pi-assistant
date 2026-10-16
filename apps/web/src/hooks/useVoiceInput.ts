/**
 * 语音输入的浏览器管线（React hook）：真实 `getUserMedia` + `AudioContext`/`AudioWorklet` 采集 16 kHz PCM。
 *
 * 逻辑都在 `../voice-input.ts`（纯逻辑、可单测）；这里只做浏览器接线：
 *  - 优先 `AudioContext({ sampleRate: 16000 })` + `AudioWorkletNode`（无 worklet 时退回 `ScriptProcessorNode`）；
 *  - **校验实际 `ctx.sampleRate`**，不等于 16000 时由纯逻辑真重采样，绝不假装 16000；
 *  - 停止 / 取消 / 切后台立即 `track.stop()`（不偷录）；
 *  - 用哪一源**只读服务端持久化的显式选择**（`/api/audio/asr/source`），未配置就用不了，绝不自动挑第一个云。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { acquireAsrLease, getVoiceSource, onVoiceSourceChanged, releaseAsrLease, transcribeAudio, type VoiceSource, type VoiceSourceOption } from "../api";
import { VoiceInputController, voiceCapability, type VoiceError, type VoiceProgress, type VoiceResult, type VoiceSegment, type VoiceState } from "../voice-input";

const WORKLET_SRC = `class PiaCapture extends AudioWorkletProcessor {
	process(inputs) {
		const ch = inputs[0] && inputs[0][0];
		if (ch && ch.length) this.port.postMessage(new Float32Array(ch));
		return true;
	}
}
registerProcessor("pia-capture", PiaCapture);`;

/** 开始采集：返回实际采样率与停止函数。 */
async function startAudioCapture(stream: MediaStream, onData: (chunk: Float32Array) => void): Promise<{ sampleRate: number; stop: () => void }> {
	const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	if (!Ctor) throw Object.assign(new Error("浏览器不支持音频采集"), { name: "NotSupportedError" });
	let ctx: AudioContext;
	try {
		ctx = new Ctor({ sampleRate: 16_000 });
	} catch {
		ctx = new Ctor();
	}
	await ctx.resume?.().catch(() => {});
	const source = ctx.createMediaStreamSource(stream);
	const cleanups: (() => void)[] = [];
	if (ctx.audioWorklet) {
		const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
		await ctx.audioWorklet.addModule(url);
		URL.revokeObjectURL(url);
		const node = new AudioWorkletNode(ctx, "pia-capture");
		node.port.onmessage = (e) => onData(e.data as Float32Array);
		source.connect(node);
		node.connect(ctx.destination); // 保持处理链活跃（不产生声音）
		cleanups.push(() => {
			node.port.onmessage = null;
			try {
				node.disconnect();
			} catch {
				/* ignore */
			}
		});
	} else {
		// 旧浏览器兜底（已废弃但仍可用）；同样只回传原始 PCM。
		const node = ctx.createScriptProcessor(4096, 1, 1);
		node.onaudioprocess = (e) => onData(new Float32Array(e.inputBuffer.getChannelData(0)));
		source.connect(node);
		node.connect(ctx.destination);
		cleanups.push(() => {
			node.onaudioprocess = null;
			try {
				node.disconnect();
			} catch {
				/* ignore */
			}
		});
	}
	cleanups.push(() => {
		try {
			source.disconnect();
		} catch {
			/* ignore */
		}
		void ctx.close().catch(() => {});
	});
	return {
		sampleRate: ctx.sampleRate,
		stop: () => {
			for (const fn of cleanups.reverse()) fn();
		},
	};
}

/** 当前选中的候选（由后端 `options[].selected` 给出；未配置为 null）。 */
function resolveSelected(view: { options: VoiceSourceOption[] }): VoiceSourceOption | null {
	return view.options.find((o) => o.selected) ?? null;
}

export interface UseVoiceInputOptions {
	agentId?: string;
	conversationId?: string;
	/** 开始录制时取光标锚点。 */
	getAnchor: () => number;
	onResult: (r: VoiceResult) => void;
	/** 增量模式（本地 ASR）下每段确认后回调（按序）。 */
	onSegment?: (s: VoiceSegment) => void;
}

export interface UseVoiceInput {
	state: VoiceState;
	error: VoiceError | null;
	/** 浏览器是否支持麦克风（安全上下文 + mediaDevices）。 */
	supported: boolean;
	/** 支持的否定原因，用于按钮提示。 */
	unsupportedReason?: string;
	/** 当前选中的 ASR 选项（未配置为 null）。 */
	asrModel: VoiceSourceOption | null;
	/** 服务端持久化的显式来源（null = 未配置）。 */
	source: VoiceSource | null;
	/** 来源读取失败（接口暂不可用）：按钮按未配置处理，但不伪造选择。 */
	sourceUnavailable: boolean;
	active: boolean;
	/** 真实音量（0..1，已平滑限频）。 */
	level: number;
	/** 分段进度（等待 / 在途 / 失败 / 积压）。 */
	progress: VoiceProgress;
	/** 增量模式下重试失败段（只重发失败的，已完成的绝不重传）。 */
	retryFailed: () => void;
	toggle: () => void;
	start: () => void;
	stop: () => void;
	cancel: () => void;
	/** 清掉 hook 的 error（点「去设置」/取消后要让提示真的消失）。 */
	dismissError: () => void;
	/** 切会话 / 换助理：停止轨道 + 释放租约 + 清错误与临时提示。 */
	resetContext: () => void;
}

export function useVoiceInput(opts: UseVoiceInputOptions): UseVoiceInput {
	const [state, setState] = useState<VoiceState>("idle");
	const [error, setError] = useState<VoiceError | null>(null);
	const [source, setSource] = useState<VoiceSource | null>(null);
	const [sourceUnavailable, setSourceUnavailable] = useState(false);
	const [asrModel, setAsrModel] = useState<VoiceSourceOption | null>(null);
	const [capability, setCapability] = useState(() => voiceCapability({ mediaDevices: typeof navigator !== "undefined" ? navigator.mediaDevices : null, isSecureContext: typeof window !== "undefined" ? window.isSecureContext : true }));
	const [level, setLevel] = useState(0);
	const [progress, setProgress] = useState<VoiceProgress>({ pending: 0, inflight: 0, failed: 0, backlog: false });

	const optsRef = useRef(opts);
	optsRef.current = opts;

	// 录音租约（只对本地 ASR）：边录边加载期间持有，避免 idle 卸载把正在录的模型 kill 掉。
	const leaseRef = useRef<{ id: string | null; cancelled: boolean }>({ id: null, cancelled: false });
	const beginLease = (provider: string, model: string) => {
		leaseRef.current = { id: null, cancelled: false };
		void acquireAsrLease(provider, model).then((id) => {
			if (leaseRef.current.cancelled) {
				if (id) void releaseAsrLease(id);
				return;
			}
			leaseRef.current.id = id;
		});
	};
	const endLease = () => {
		const cur = leaseRef.current;
		cur.cancelled = true;
		if (cur.id) {
			void releaseAsrLease(cur.id);
			cur.id = null;
		}
	};

	// 选源：只读后端 `GET /api/audio/asr/source` 的显式选择 + 归一化候选（availability 也来自后端）；未配置 = null。
	useEffect(() => {
		let alive = true;
		const load = async () => {
			try {
				const view = await getVoiceSource();
				if (!alive) return;
				setSource(view.source);
				setAsrModel(resolveSelected(view));
				setSourceUnavailable(false);
			} catch {
				// 接口暂不可用：当作「未配置」，不伪造选择；界面用 title 说明。
				if (!alive) return;
				setSource(null);
				setAsrModel(null);
				setSourceUnavailable(true);
			}
		};
		void load();
		// 「语音配置」保存后刷新选中（同一页/同一会话内即时生效，不轮询）。
		const off = onVoiceSourceChanged(() => void load());
		return () => {
			alive = false;
			off();
		};
	}, []);

	useEffect(() => {
		setCapability(voiceCapability({ mediaDevices: navigator.mediaDevices, isSecureContext: window.isSecureContext }));
	}, []);

	const controller = useMemo(
		() =>
			new VoiceInputController(
				{
					getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
					startCapture: startAudioCapture,
					transcribe: (i) => transcribeAudio({ ...i, agentId: optsRef.current.agentId, conversationId: optsRef.current.conversationId }),
				},
				{
					onState: (s) => {
						setState(s);
						if (s === "recording" || s === "preparing") setError(null);
						// 转写结束 / 出错 / 回到 idle 时释放录音租约。
						if (s === "finish" || s === "error" || s === "idle") endLease();
					},
					onResult: (r) => optsRef.current.onResult(r),
					onSegment: (s) => optsRef.current.onSegment?.(s),
					onError: (e) => setError(e),
					onLevel: (v) => setLevel(v),
					onProgress: (p) => setProgress(p),
					onNoSpeech: () => setError({ code: "asr_no_speech", message: "没有听到声音，请靠近麦克风再说一次" }),
				},
			),
		[],
	);

	// 页面隐藏 / 切后台：停轨道 + 取消（不发送），并释放录音租约。
	useEffect(() => {
		const onHide = () => {
			if (document.hidden) {
				controller.onHidden();
				endLease();
			}
		};
		document.addEventListener("visibilitychange", onHide);
		return () => document.removeEventListener("visibilitychange", onHide);
	}, [controller]);

	// 语音来源被改（另一个页面 / 设置页保存）：正在录音就立即停轨道 + 取消，避免把旧来源的请求串到新会话。
	useEffect(() => {
		const off = onVoiceSourceChanged(() => {
			if (controller.isActive()) {
				controller.cancel();
				endLease();
			}
		});
		return off;
	}, [controller]);

	// 组件卸载：释放麦克风与录音租约。
	useEffect(
		() => () => {
			controller.cancel();
			endLease();
		},
		[controller],
	);

	const start = useCallback(() => {
		setError(null);
		if (!capability.available) {
			setError({ code: capability.reason ?? "no_mediadevices", message: capability.reason === "insecure_context" ? "当前不是安全上下文（请用 HTTPS 隧道或本机 127.0.0.1 打开）" : "当前浏览器不支持麦克风" });
			return;
		}
		if (!source || !asrModel) {
			setError({ code: "asr_not_configured", message: sourceUnavailable ? "语音识别设置暂不可用，请稍后重试或在设置 › 语音配置 里检查" : "请先在设置 › 语音配置 里选择语音识别模型" });
			return;
		}
		// 只有 ready 表示当下可用；本地「已安装但未运行」（not_running）允许：录音租约会按需加载（不在这里起进程）。
		const usable = asrModel.availability === "ready" || (asrModel.location === "local" && asrModel.availability === "not_running");
		if (!usable) {
			setError({ code: asrModel.availability === "not_installed" ? "asr_not_installed" : asrModel.availability === "deleted" ? "asr_deleted" : "asr_unavailable", message: asrModel.reason || "当前选择的语音识别模型不可用，请到设置 › 语音配置 重新选择" });
			return;
		}
		// 本地 ASR：先拿录音租约（边录边加载）；云端不需要。
		if (asrModel.location === "local") beginLease(asrModel.provider, asrModel.model);
		void controller.start({ provider: asrModel.provider, model: asrModel.model, agentId: optsRef.current.agentId, conversationId: optsRef.current.conversationId, anchor: optsRef.current.getAnchor(), incremental: asrModel.location === "local" });
	}, [capability.available, capability.reason, source, asrModel, sourceUnavailable, controller]);

	const dismissError = useCallback(() => setError(null), []);
	const retryFailed = useCallback(() => {
		setError(null);
		void controller.retryFailed();
	}, [controller]);
	const cancel = useCallback(() => {
		controller.cancel();
		endLease();
		setError(null);
	}, [controller]);
	// 切会话 / 换助理：停轨道 + 释放租约 + 清错误（旧的麦克风提示不跟到新对话里）。
	const resetContext = useCallback(() => {
		controller.cancel();
		endLease();
		setError(null);
	}, [controller]);

	return {
		state,
		error,
		supported: capability.available,
		unsupportedReason: capability.reason,
		asrModel,
		source,
		sourceUnavailable,
		active: controller.isActive(),
		level,
		progress,
		retryFailed,
		toggle: () => (controller.isActive() ? void controller.stop() : start()),
		start,
		stop: () => void controller.stop(),
		cancel,
		dismissError,
		resetContext,
	};
}
