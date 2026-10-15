/**
 * 本地 ASR 的**适配器契约**（与 voice agent 对齐的薄接口，不是 ChatProvider）。
 *
 * 用户要求：统一 localASR provider、`modeltype = asr`；**不伪造成 chat / classifier**；
 * 也不在这里定义一整套 ChatProvider 鉴权（鉴权是 Pi 对 chat 模型的事）。
 *
 * 本文件只定义两端之间**最小**的数据形状：
 *  - 服务端内部：`AsrEndpoint`（含进程内 token，只在内存）；
 *  - 识别结果：`AsrResult`（text / language / segments / usage；**成本未知写 null，绝不填 0**）。
 *
 * ⚠️ **待 voice agent 确认**：UI → Pi Server 的上传契约（multipart 字段名、返回结构）由语音输入主任务定；
 * 本模块只保证「服务端能拿到一段 16k mono WAV 并转成文本」这一层，路径/字段可随主契约调整。
 */

/** 运行中的本地 ASR 端点（server 内部；token 绝不外发）。 */
export interface AsrEndpoint {
	provider: string;
	modelId: string;
	/** 协议标识：`local-asr-http`（本机 loopback，Bearer token） */
	protocol: string;
	baseUrl: string;
	/** 进程内短期 token（不是长期 API key） */
	token: string;
	sampleRate: number;
	languages: string[];
}

/** 一个识别片段。 */
export interface AsrSegment {
	start: number;
	end: number;
	text: string;
}

/** 识别结果。`usage.cost` 未知时为 null（**不填 0**）。 */
export interface AsrResult {
	text: string;
	language: string | null;
	segments: AsrSegment[];
	usage: { audioSeconds: number; cost: number | null };
}

export const ASR_PROTOCOL = "local-asr-http";
