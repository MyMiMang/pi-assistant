/**
 * 语音输入的浏览器管线（React hook）：真实 `getUserMedia` + `AudioContext`/`AudioWorklet` 采集 16 kHz PCM。
 *
 * 逻辑都在 `../voice-input.ts`（纯逻辑、可单测）；这里只做浏览器接线：
 *  - 优先 `AudioContext({ sampleRate: 16000 })` + `AudioWorkletNode`（无 worklet 时退回 `ScriptProcessorNode`）；
 *  - **校验实际 `ctx.sampleRate`**，不等于 16000 时由纯逻辑真重采样，绝不假装 16000；
 *  - 停止 / 取消 / 切后台立即 `track.stop()`（不偷录）；
 *  - 自动从统一注册表挑一个已配置的 ASR 模型（本地优先，音频不出设备）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listAsrModels, transcribeAudio, type AsrModelOption } from "../api";
import { VoiceInputController, voiceCapability, type VoiceError, type VoiceResult, type VoiceState } from "../voice-input";

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

/** 统一注册表里的 ASR 候选：本地优先（音频不出设备），其次云。 */
export function pickAsrModel(models: AsrModelOption[]): AsrModelOption | undefined {
	return models.find((m) => m.configured && m.location === "local") ?? models.find((m) => m.configured);
}

export interface UseVoiceInputOptions {
	agentId?: string;
	conversationId?: string;
	/** 开始录制时取光标锚点。 */
	getAnchor: () => number;
	onResult: (r: VoiceResult) => void;
}

export interface UseVoiceInput {
	state: VoiceState;
	error: VoiceError | null;
	/** 浏览器是否支持麦克风（安全上下文 + mediaDevices）。 */
	supported: boolean;
	/** 支持的否定原因，用于按钮提示。 */
	unsupportedReason?: string;
	/** 当前选中的 ASR 模型（未配置为 null）。 */
	asrModel: AsrModelOption | null;
	active: boolean;
	toggle: () => void;
	start: () => void;
	stop: () => void;
	cancel: () => void;
}

export function useVoiceInput(opts: UseVoiceInputOptions): UseVoiceInput {
	const [state, setState] = useState<VoiceState>("idle");
	const [error, setError] = useState<VoiceError | null>(null);
	const [asrModel, setAsrModel] = useState<AsrModelOption | null>(null);
	const [capability, setCapability] = useState(() => voiceCapability({ mediaDevices: typeof navigator !== "undefined" ? navigator.mediaDevices : null, isSecureContext: typeof window !== "undefined" ? window.isSecureContext : true }));

	const optsRef = useRef(opts);
	optsRef.current = opts;

	// 选源：注册表里挑一个已配置的 ASR（本地优先）；失败不报错，只是按钮提示未配置。
	useEffect(() => {
		let alive = true;
		void listAsrModels()
			.then((models) => alive && setAsrModel(pickAsrModel(models) ?? null))
			.catch(() => alive && setAsrModel(null));
		return () => {
			alive = false;
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
					},
					onResult: (r) => optsRef.current.onResult(r),
					onError: (e) => setError(e),
				},
			),
		[],
	);

	// 页面隐藏 / 切后台：停轨道 + 取消（不发送）。
	useEffect(() => {
		const onHide = () => {
			if (document.hidden) controller.onHidden();
		};
		document.addEventListener("visibilitychange", onHide);
		return () => document.removeEventListener("visibilitychange", onHide);
	}, [controller]);

	// 组件卸载：释放麦克风。
	useEffect(() => () => controller.cancel(), [controller]);

	const start = useCallback(() => {
		setError(null);
		if (!capability.available) {
			setError({ code: capability.reason ?? "no_mediadevices", message: capability.reason === "insecure_context" ? "当前不是安全上下文（请用 HTTPS 隧道或本机 127.0.0.1 打开）" : "当前浏览器不支持麦克风" });
			return;
		}
		if (!asrModel) {
			setError({ code: "asr_not_configured", message: "请先在设置 › 模型 里配置语音识别模型" });
			return;
		}
		void controller.start({ provider: asrModel.provider, model: asrModel.model, language: asrModel.language, agentId: optsRef.current.agentId, conversationId: optsRef.current.conversationId, anchor: optsRef.current.getAnchor() });
	}, [capability.available, capability.reason, asrModel, controller]);

	return {
		state,
		error,
		supported: capability.available,
		unsupportedReason: capability.reason,
		asrModel,
		active: controller.isActive(),
		toggle: () => (controller.isActive() ? void controller.stop() : start()),
		start,
		stop: () => void controller.stop(),
		cancel: () => controller.cancel(),
	};
}
