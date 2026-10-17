/**
 * 语音输入的浏览器管线（React hook）：真实 `getUserMedia` + `AudioContext`/`AudioWorklet` 采集 16 kHz PCM。
 *
 * 逻辑都在纯逻辑层：`../voice-input.ts`（整段批量 + 停顿分段增量）与 `../voice-stream.ts`（原生流式会话）。
 * 这里只做浏览器接线 + 两条发送路径的**同一套来源 / 租约 / 采集**：
 *  - 优先 `AudioContext({ sampleRate: 16000 })` + `AudioWorkletNode`（无 worklet 时退回 `ScriptProcessorNode`）；
 *  - **校验实际 `ctx.sampleRate`**，不等于 16000 时由纯逻辑真重采样，绝不假装 16000；
 *  - 停止 / 取消 / 切后台立即 `track.stop()`（不偷录）；
 *  - 用哪一源**只读服务端持久化的显式选择**（`/api/audio/asr/source`），未配置就用不了，绝不自动挑第一个云；
 *  - **原生流式只在「服务端模型能力声明流式 + 契约提供了 `openStream`」时启用**（不凭模型名字里带 online 就伪流式）；
 *    缺任一项都回落到既有分段增量 / 整段批量，行为不变。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { acquireAsrLease, cancelDefaultVoicePrepare, getVoiceSource, isStreamingSource, onVoiceSourceChanged, releaseAsrLease, retryDefaultVoicePrepare, transcribeAudio, type VoiceSource, type VoiceSourceOption } from "../api";
import type { LiveDownloadLike } from "../local-asr-intent";
import { useStore } from "../store";
import { mergePrepareDownload, normalizeVoicePrepareView, type VoicePrepareView } from "../voice-pref";
import { VoiceInputController, AsrLeaseManager, voiceCapability, type VoiceError, type VoiceProgress, type VoiceResult, type VoiceSegment, type VoiceState } from "../voice-input";
import { NativeVoiceController, type VoiceStreamOpen } from "../voice-stream";

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
	/** 原生流式下未确认尾部预览（就地状态行用；final 后为空）。 */
	onTentative?: (text: string) => void;
	/**
	 * 原生流式会话的打开函数（由后端契约接线：有界 seq 追加 + chunked 事件解析）。
	 * **缺省 = 不启用原生流式**，回落既有分段增量 / 整段批量；不伪造流式。
	 */
	openStream?: VoiceStreamOpen;
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
	/** 本机 / 服务端是否具备原生流式条件（能力声明 + 已接线；不凭模型名猜）。 */
	nativeCapable: boolean;
	/** 本次会话是否为原生流式（`transcribing` 期间仍为 true）。 */
	streaming: boolean;
	/** 原生流式的未确认尾部预览（就地显示，不写进草稿）。 */
	tentative: string;
	/** 默认本地语音的准备状态（同一份 `GET source` 的 `defaultVoice`；无则 null）。 */
	prep: VoicePrepareView | null;
	/** 取消默认本地语音的准备（走统一下载组件同一 job）。 */
	cancelPrepare: () => void;
	/** 重试默认本地语音的准备（走统一下载组件同一 job）。 */
	retryPrepare: () => void;
	/** 真实音量（0..1，已平滑限频）。 */
	level: number;
	/** 分段 / 流式进度（等待 / 在途 / 失败 / 积压）。 */
	progress: VoiceProgress;
	/** 增量模式下重试失败段（只重发失败的，已完成的绝不重传）。原生流式不保留音频，重试 = 重新录音。 */
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
	const [tentative, setTentative] = useState("");
	const [native, setNative] = useState(false);
	const [prep, setPrep] = useState<VoicePrepareView | null>(null);
	const [progress, setProgress] = useState<VoiceProgress>({ pending: 0, inflight: 0, failed: 0, backlog: false, held: 0 });
	// 默认本地语音准备的实时进度（统一下载注册表，同一个 `asr:<modelId>` job）。
	const downloads = useStore((s) => s.downloads) as Record<string, LiveDownloadLike> | undefined;
	const prepView = useMemo(() => (prep ? mergePrepareDownload(prep, prep.jobId ? downloads?.[prep.jobId] : undefined) : null), [prep, downloads]);

	const optsRef = useRef(opts);
	optsRef.current = opts;
	// 当前选中源（供重试时按需补租约；不在重试里切源 / 换模型）。
	const asrModelRef = useRef<VoiceSourceOption | null>(null);
	asrModelRef.current = asrModel;
	// 默认本地语音准备状态（供取消 / 重试回调读最新值，避免闭包过期）。
	const prepRef = useRef<VoicePrepareView | null>(null);
	prepRef.current = prepView;
	// 原生流式打开函数由契约接线；用 ref 让引擎始终读最新实现（切换不重建引擎）。
	const openStreamRef = useRef(opts.openStream);
	openStreamRef.current = opts.openStream;

	// 录音租约（只对本地 ASR）：录音 + 重试期间持有，避免 idle 卸载把正在用的模型 kill 掉。
	// 并发 begin / 重试复用同一管理器（逻辑与单测见 voice-input.ts AsrLeaseManager）。
	const leaseRef = useRef<AsrLeaseManager | null>(null);
	if (!leaseRef.current) leaseRef.current = new AsrLeaseManager({ acquire: acquireAsrLease, release: (id) => void releaseAsrLease(id) });
	const beginLease = (provider: string, model: string) => leaseRef.current!.begin(provider, model);
	const endLease = () => leaseRef.current!.end();

	// 选源：只读后端 `GET /api/audio/asr/source` 的显式选择 + 归一化候选（availability 也来自后端）；未配置 = null。
	// 同一次 GET 带出 `defaultVoice` 准备状态，不另开轮询（进度由统一下载事件驱动）。
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	const loadSource = useCallback(async () => {
		try {
			const view = await getVoiceSource();
			if (!mountedRef.current) return;
			setSource(view.source);
			setAsrModel(resolveSelected(view));
			setPrep(view.defaultVoice ? normalizeVoicePrepareView(view.defaultVoice) : null);
			setSourceUnavailable(false);
		} catch {
			// 接口暂不可用：当作「未配置」，不伪造选择；界面用 title 说明。
			if (!mountedRef.current) return;
			setSource(null);
			setAsrModel(null);
			setPrep(null);
			setSourceUnavailable(true);
		}
	}, []);
	useEffect(() => {
		void loadSource();
		// 「语音配置」保存后刷新选中（同一页/同一会话内即时生效，不轮询）。
		const off = onVoiceSourceChanged(() => void loadSource());
		return off;
	}, [loadSource]);

	useEffect(() => {
		setCapability(voiceCapability({ mediaDevices: navigator.mediaDevices, isSecureContext: window.isSecureContext }));
	}, []);

	/** 两条路径共用的状态 / 错误 / 音量 / 进度回调（同一套 UI，不出现第二份来源状态）。 */
	const sharedEvents = {
		onState: (s: VoiceState) => {
			setState(s);
			if (s === "recording" || s === "preparing") setError(null);
			if (s === "idle") setTentative("");
			// 转写结束 / 出错 / 回到 idle 时释放录音租约。
			if (s === "finish" || s === "error" || s === "idle") endLease();
		},
		onError: (e: VoiceError) => setError(e),
		onLevel: (v: number) => setLevel(v),
		onProgress: (p: VoiceProgress) => setProgress(p),
		onNoSpeech: () => setError({ code: "asr_no_speech", message: "没有听到声音，请靠近麦克风再说一次" }),
	};

	// 整段批量 + 停顿分段增量（既有路径，保持原样）。
	const controller = useMemo(
		() =>
			new VoiceInputController(
				{
					getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
					startCapture: startAudioCapture,
					transcribe: (i) => transcribeAudio({ ...i, agentId: optsRef.current.agentId, conversationId: optsRef.current.conversationId }),
				},
				{
					...sharedEvents,
					onResult: (r) => optsRef.current.onResult(r),
					onSegment: (s) => optsRef.current.onSegment?.(s),
				},
			),
		[],
	);

	// 原生流式（会话由契约 `openStream` 提供；缺省不启用）。
	const nativeController = useMemo(
		() =>
			new NativeVoiceController(
				{
					getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
					startCapture: startAudioCapture,
					openStream: (o) => {
						const fn = openStreamRef.current;
						if (!fn) return Promise.reject(Object.assign(new Error("asr_stream_unavailable"), { name: "NotSupportedError" }));
						return fn(o);
					},
				},
				{
					...sharedEvents,
					onSegment: (s) => optsRef.current.onSegment?.(s),
					onTentative: (text) => {
						setTentative(text);
						optsRef.current.onTentative?.(text);
					},
				},
			),
		[],
	);

	// 当前生效的引擎（两条路径互斥；开始录音时确定）。
	const activeRef = useRef<"controller" | "native">("controller");
	const engine = () => (activeRef.current === "native" ? nativeController : controller);

	// 页面隐藏 / 切后台：停轨道 + 取消（不发送），并释放录音租约。
	useEffect(() => {
		const onHide = () => {
			if (document.hidden) {
				engine().onHidden();
				endLease();
			}
		};
		document.addEventListener("visibilitychange", onHide);
		return () => document.removeEventListener("visibilitychange", onHide);
	}, [controller, nativeController]);

	// 语音来源被改（另一个页面 / 设置页保存）：录音 / 准备中，或正在重试转写时立即停轨道 + 取消，
	// 避免把旧来源的请求串到新会话（取消会 abort 在途 attempt，不另切云 / 模型）。两条路径都取消（幂等）。
	useEffect(() => {
		const off = onVoiceSourceChanged(() => {
			for (const c of [controller, nativeController]) {
				const st = c.getState();
				if (c.isActive() || st === "transcribing") c.cancel();
			}
			endLease();
			setNative(false);
			setTentative("");
		});
		return off;
	}, [controller, nativeController]);

	// 组件卸载：释放麦克风与录音租约。
	useEffect(
		() => () => {
			controller.cancel();
			nativeController.cancel();
			endLease();
		},
		[controller, nativeController],
	);

	const start = useCallback(() => {
		setError(null);
		if (!capability.available) {
			setError({ code: capability.reason ?? "no_mediadevices", message: capability.reason === "insecure_context" ? "当前不是安全上下文（请用 HTTPS 隧道或本机 127.0.0.1 打开）" : "当前浏览器不支持麦克风" });
			return;
		}
		if (!source || !asrModel) {
			// 未配置来源时：默认本地语音可能正在自动准备 / 准备失败——不逼用户手动找文件，先如实告知状态。
			if (!source && prepView?.ok) {
				if (prepView.state === "preparing") {
					setError({ code: "asr_preparing", message: prepView.percent != null ? `默认本地语音正在自动准备（${prepView.percent}%），准备好后点麦克风即可` : "默认本地语音正在自动准备（首次需联网），准备好后点麦克风即可" });
					return;
				}
				if (prepView.state === "not_prepared") {
					setError({ code: "asr_preparing", message: "默认本地语音还没准备好（首次需联网自动准备），可在设置 › 语音配置 查看进度" });
					return;
				}
				if (prepView.state === "failed") {
					setError({ code: "asr_prepare_failed", message: prepView.error ? `默认本地语音准备失败：${prepView.error}（可在设置里重试）` : "默认本地语音准备失败，可在设置 › 语音配置 重试" });
					return;
				}
			}
			setError({ code: "asr_not_configured", message: sourceUnavailable ? "语音识别设置暂不可用，请稍后重试或在设置 › 语音配置 里检查" : "请先在设置 › 语音配置 里选择语音识别模型" });
			return;
		}
		// 只有 ready 表示当下可用；本地「已安装但未运行」（not_running）允许：录音租约会按需加载（不在这里起进程）。
		const usable = asrModel.availability === "ready" || (asrModel.location === "local" && asrModel.availability === "not_running");
		if (!usable) {
			setError({ code: asrModel.availability === "not_installed" ? "asr_not_installed" : asrModel.availability === "deleted" ? "asr_deleted" : "asr_unavailable", message: asrModel.reason || "当前选择的语音识别模型不可用，请到设置 › 语音配置 重新选择" });
			return;
		}
		// 原生流式：只在「服务端模型能力声明流式（streaming + protocol + streamProtocol 三项一致）+ 已接线 openStream」时启用，缺任一项回落分段增量。
		const useNative = asrModel.location === "local" && isStreamingSource(asrModel) && !!openStreamRef.current;
		// 本地 ASR：先拿录音租约（边录边加载）；云端不需要。
		if (asrModel.location === "local") beginLease(asrModel.provider, asrModel.model);
		const startOpts = { provider: asrModel.provider, model: asrModel.model, agentId: optsRef.current.agentId, conversationId: optsRef.current.conversationId, anchor: optsRef.current.getAnchor(), incremental: asrModel.location === "local" };
		activeRef.current = useNative ? "native" : "controller";
		setNative(useNative);
		setTentative("");
		if (useNative) void nativeController.start(startOpts);
		else void controller.start(startOpts);
	}, [capability.available, capability.reason, source, asrModel, sourceUnavailable, prepView, controller, nativeController]);

	const dismissError = useCallback(() => setError(null), []);
	const retryFailed = useCallback(() => {
		setError(null);
		// 原生流式不保留音频（重放会重复计费）：没有可重试的段，重试 = 用户重新录音。
		if (activeRef.current === "native") return;
		// 停止后租约已释放：若超过本地 idle TTL（默认 90s）再点重试，模型可能已被卸载。
		// 重试前按需补一次租约（复用同一管理器；只在本地源且确有失败段时拿），不切换来源 / 模型。
		if (controller.progress().failed > 0) {
			const m = asrModelRef.current;
			if (m?.location === "local") beginLease(m.provider, m.model);
		}
		void controller.retryFailed();
	}, [controller]);
	const cancel = useCallback(() => {
		engine().cancel();
		endLease();
		setError(null);
		setTentative("");
	}, [controller, nativeController]);
	// 切会话 / 换助理：停轨道 + 释放租约 + 清错误（旧的麦克风提示不跟到新对话里）。
	const resetContext = useCallback(() => {
		controller.cancel();
		nativeController.cancel();
		endLease();
		setError(null);
		setTentative("");
		setNative(false);
	}, [controller, nativeController]);

	const nativeCapable = !!opts.openStream && asrModel?.location === "local" && isStreamingSource(asrModel);

	// 默认本地语音准备的取消 / 重试：走统一下载组件同一 job（`asr:<modelId>`），**不写 source**。
	const cancelPrepare = useCallback(() => {
		if (!prepRef.current?.jobId) return;
		// 窄接口：只取消目录里唯一的默认模型（手机也可用；不动通用下载）。
		void cancelDefaultVoicePrepare().then(() => void loadSource()).catch(() => {});
	}, [loadSource]);
	const retryPrepare = useCallback(() => {
		if (!prepRef.current?.jobId) return;
		void retryDefaultVoicePrepare().then(() => void loadSource()).catch(() => {});
	}, [loadSource]);

	return {
		state,
		error,
		supported: capability.available,
		unsupportedReason: capability.reason,
		asrModel,
		source,
		sourceUnavailable,
		active: state === "preparing" || state === "recording",
		nativeCapable,
		streaming: native,
		tentative,
		prep: prepView,
		cancelPrepare,
		retryPrepare,
		level,
		progress,
		retryFailed,
		toggle: () => (state === "preparing" || state === "recording" ? void engine().stop() : start()),
		start,
		stop: () => void engine().stop(),
		cancel,
		dismissError,
		resetContext,
	};
}
