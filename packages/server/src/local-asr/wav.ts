/**
 * WAV 校验（纯函数，无系统依赖）。
 *
 * 用户约束：
 *  - 音频来自 **UI controller 的 16k mono WAV**（后台只做校验，不做任意格式解码）；
 *  - **不引入 ffmpeg / 系统解码依赖**，也**不接受任意 URL**（只处理内存里的字节）；
 *  - 长帧必须有界：字节数与时长双上限，超限直接拒绝（避免把长音频塞给离线模型导致内存膨胀）。
 *
 * 只解析 RIFF/WAVE 头，不解码音频；任何越界 / 截断 / 非法块一律拒绝。
 */

export interface WavInfo {
	sampleRate: number;
	channels: number;
	bitsPerSample: number;
	/** PCM 数据字节数 */
	dataBytes: number;
	seconds: number;
}

export interface WavCheck {
	ok: boolean;
	problems: string[];
	info: WavInfo | null;
}

export interface WavLimits {
	/** 允许的最大总字节数 */
	maxBytes: number;
	/** 允许的最大时长（秒） */
	maxSeconds: number;
	/** 要求的采样率（0 = 不检查） */
	expectSampleRate?: number;
	/** 要求的声道数（0 = 不检查） */
	expectChannels?: number;
}

const PCM = 1;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/**
 * 校验一段 WAV 字节。**不修改输入**，不读文件系统，不发网络请求。
 * 返回问题列表（中文，可直接显示）；`ok` 仅在零问题时为 true。
 */
export function checkWav(buf: Uint8Array, limits: WavLimits): WavCheck {
	const problems: string[] = [];
	const info = parseWav(buf, problems);
	if (!info) return { ok: false, problems, info: null };

	const expectRate = limits.expectSampleRate ?? 0;
	if (expectRate && info.sampleRate !== expectRate) problems.push(`采样率必须是 ${expectRate} Hz（收到 ${info.sampleRate}）`);
	const expectCh = limits.expectChannels ?? 0;
	if (expectCh && info.channels !== expectCh) problems.push(`声道数必须是 ${expectCh}（收到 ${info.channels}）`);
	if (info.bitsPerSample !== 16) problems.push(`只支持 16-bit PCM（收到 ${info.bitsPerSample}）`);

	if (buf.byteLength > limits.maxBytes) problems.push(`音频过大：${buf.byteLength} 字节，上限 ${limits.maxBytes}`);
	if (info.seconds > limits.maxSeconds) problems.push(`音频过长：${info.seconds.toFixed(1)} 秒，上限 ${limits.maxSeconds} 秒`);

	return { ok: problems.length === 0, problems, info };
}

/** 解析 RIFF/WAVE 头；失败把原因写进 problems 并返回 null。 */
function parseWav(buf: Uint8Array, problems: string[]): WavInfo | null {
	if (buf.byteLength < 44) {
		problems.push("音频太短，不是有效 WAV");
		return null;
	}
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	if (tag(buf, 0) !== "RIFF" || tag(buf, 8) !== "WAVE") {
		problems.push("不是 WAV（缺少 RIFF/WAVE 头）");
		return null;
	}
	const riffSize = view.getUint32(4, true);
	if (riffSize + 8 > buf.byteLength) {
		problems.push("WAV 被截断（RIFF 声明长度超出实际数据）");
		return null;
	}

	let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
	let dataBytes: number | null = null;
	let off = 12;
	while (off + 8 <= buf.byteLength) {
		const id = tag(buf, off);
		const size = view.getUint32(off + 4, true);
		const body = off + 8;
		if (body + size > buf.byteLength) {
			problems.push(`WAV 块被截断：${id}`);
			return null;
		}
		if (id === "fmt ") {
			if (size < 16) {
				problems.push("fmt 块长度非法");
				return null;
			}
			let format = view.getUint16(body, true);
			const channels = view.getUint16(body + 2, true);
			const sampleRate = view.getUint32(body + 4, true);
			const bits = view.getUint16(body + 14, true);
			if (format === WAVE_FORMAT_EXTENSIBLE) {
				// SubFormat GUID 的前两字节是 PCM 标记；不足 40 字节就按非法处理。
				if (size < 40) {
					problems.push("WAVE_FORMAT_EXTENSIBLE 的 fmt 块过短");
					return null;
				}
				format = view.getUint16(body + 24, true);
			}
			fmt = { format, channels, sampleRate, bits };
		} else if (id === "data") {
			dataBytes = size;
		}
		off = body + size + (size % 2); // 块按偶数字节对齐
	}

	if (!fmt) {
		problems.push("缺少 fmt 块");
		return null;
	}
	if (fmt.format !== PCM) {
		problems.push(`只支持未压缩 PCM（format=${fmt.format}）`);
		return null;
	}
	if (fmt.channels < 1 || fmt.channels > 8) {
		problems.push(`声道数非法：${fmt.channels}`);
		return null;
	}
	if (fmt.sampleRate < 8000 || fmt.sampleRate > 96000) {
		problems.push(`采样率非法：${fmt.sampleRate}`);
		return null;
	}
	if (dataBytes == null) {
		problems.push("缺少 data 块");
		return null;
	}
	const blockAlign = fmt.channels * (fmt.bits / 8);
	if (!Number.isInteger(blockAlign) || blockAlign <= 0) {
		problems.push("位深非法");
		return null;
	}
	if (dataBytes % blockAlign !== 0) {
		problems.push("data 长度不是完整帧（可能被截断）");
		return null;
	}
	const seconds = dataBytes / (fmt.sampleRate * blockAlign);
	return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits, dataBytes, seconds };
}

function tag(buf: Uint8Array, off: number): string {
	return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}
