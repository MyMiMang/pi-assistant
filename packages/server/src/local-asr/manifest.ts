/**
 * 本地 SenseVoice 语音识别（ASR）的固定清单：引擎版本 / 权重 revision / 文件哈希 / **许可证判定**。
 *
 * 供应链原则（与 local-laya 一致）：
 *  - 一切版本 pin 在这里，不从上游 `curl | sh`、不跟随 `latest`；
 *  - 权重文件只按本清单 `allow_patterns` 取，`model.int8.onnx` 的 SHA256 直接取 HuggingFace **LFS oid**
 *    （公开元数据，无需下载权重即可 pin）；小文件（`tokens.txt`）在同 revision 下取回后本地算哈希。
 *  - **许可判定是数据，不是注释**：`licenseDecision` 决定安装入口是否开放（见 license.ts）。
 *
 * 复核记录：`research/sensevoice-weight-license-review.md`（2026-10-15，只读官方来源）。
 * 升级本文件即代表「换审核快照」，必须同步该文档与测试。
 */

/** 引擎（sherpa-onnx，Apache-2.0，无 torch）。 */
export const SHERPA_ONNX_VERSION = "1.13.8";

/** uv 托管的 Python（与 local-laya 相同的 python-build-standalone 口径，但**独立 env**）。 */
export const ASR_PYTHON_VERSION = "3.12";

/** 权重来源与审核快照（界面「来源」标签用）。 */
export interface AsrSourceMeta {
	project: string;
	repoUrl: string;
	weightsRepo: string;
	weightsRevision: string;
	/** 引擎代码许可（Apache-2.0） */
	engineLicense: string;
	/** 仓库源码许可（MIT） */
	repoCodeLicense: string;
	/** 权重许可（**非 Apache**） */
	weightsLicense: string;
	engineVersion: string;
	/** 面向用户的一句话来源说明 */
	note: string;
}

export const SENSEVOICE_SOURCE: AsrSourceMeta = {
	project: "SenseVoiceSmall（FunAudioLLM / FunASR）· sherpa-onnx 转换",
	repoUrl: "https://github.com/FunAudioLLM/SenseVoice",
	weightsRepo: "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
	weightsRevision: "2365baeacb507f821a0c8120fcee3d484dba7a07",
	engineLicense: "Apache-2.0",
	repoCodeLicense: "MIT",
	weightsLicense: "FunASR Model Open Source License Agreement v1.1",
	engineVersion: SHERPA_ONNX_VERSION,
	note: "权重由官方 FunASR 权重转换而来；许可按 FunASR MODEL_LICENSE v1.1（不是 Apache-2.0）",
};

/** 许可判定的三种结果。 */
export type LicenseDecision = "cleared" | "unresolved" | "prohibited";

/** 权重许可证元数据（**判定 + 条款可见性**，供门槛与 UI 用）。 */
export interface AsrLicenseMeta {
	decision: LicenseDecision;
	/** 用户必须接受的条款版本；install 的 acceptLicense 必须等于它 */
	termsVersion: string;
	licenseName: string;
	/** 是否允许随 App bundle / 自建镜像再分发权重 */
	redistribution: boolean;
	/** 必须展示的署名（§2.2 硬要求） */
	attribution: string;
	links: { modelCard: string; modelLicense: string; issue: string; engineLicense: string };
	/** 必须**默认可见**的限制摘要（不能靠一次点击遮盖） */
	restrictions: string[];
	/** 判定依据（中文，一句话） */
	reason: string;
}

/**
 * 2026-10-15 复核结论：`unresolved`。
 *
 * `MODEL_LICENSE` §2.1 字面允许 use/copy/modify/share（须 §2.2 署名并保留模型名），
 * 但 §3「reference and learning purposes only」+ §4.2 + §6 单方改版使适用范围不确定，
 * 且许可方对商用 / 再分发的最终确认仍未给出（issue #334 至今 OPEN）。
 * → 不 bundle、不镜像；安装入口默认 blocked；用户自行导入仍开放。
 */
export const SENSEVOICE_LICENSE: AsrLicenseMeta = {
	decision: "unresolved",
	termsVersion: "1.1",
	licenseName: "FunASR Model Open Source License Agreement v1.1",
	redistribution: false,
	attribution: "SenseVoiceSmall by FunASR / FunAudioLLM",
	links: {
		modelCard: "https://huggingface.co/FunAudioLLM/SenseVoiceSmall",
		modelLicense: "https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE",
		issue: "https://github.com/QwenAudio/SenseVoice/issues/334",
		engineLicense: "https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE",
	},
	restrictions: [
		"使用 / 复制 / 修改 / 分享须署名来源与作者并保留模型名（§2.2）",
		"条款写「for reference and learning purposes only」（§3），适用范围未由许可方最终确认",
		"禁止无端贬损，违反即自动丧失全部许可（§4.2）",
		"许可方可单方改版并自动生效（§6）",
		"商用 / 再分发澄清未最终确认：官方 issue #334 仍处于 open（2026-09-22 标注「not final license-owner confirmation」）",
	],
	reason: "权重许可为 FunASR MODEL_LICENSE v1.1（非 Apache）；适用范围未最终确认，故不随 App 分发、安装入口默认关闭",
};

/** 单个权重文件的固定清单项。 */
export interface AsrWeightFile {
	path: string;
	size: number;
	sha256: string;
}

/** SenseVoice 权重（int8 ONNX，CPU）。 */
export interface AsrModelManifest {
	id: string;
	repo: string;
	revision: string;
	files: AsrWeightFile[];
	/** 大约总大小（字节），界面显示用 */
	bytes: number;
	/** 采样率 / 声道（模型硬要求，不是建议） */
	sampleRate: number;
	channels: number;
	/** 输出是否自带标点 / ITN（`use_itn=1`） */
	punctuation: boolean;
	/** 语言范围（已发布 checkpoint） */
	languages: string[];
}

export const SENSEVOICE_MODEL: AsrModelManifest = {
	id: "sensevoice-small-int8",
	repo: SENSEVOICE_SOURCE.weightsRepo,
	revision: SENSEVOICE_SOURCE.weightsRevision,
	files: [
		{
			path: "model.int8.onnx",
			size: 239_233_841,
			sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
		},
		{ path: "tokens.txt", size: 315_894, sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc" },
	],
	bytes: 239_233_841 + 315_894,
	sampleRate: 16_000,
	channels: 1,
	punctuation: true,
	languages: ["zh", "yue", "en", "ja", "ko"],
};

/** 注册进统一注册表时用的稳定 provider / model id。 */
export const ASR_PROVIDER_ID = "local-sensevoice";
export const ASR_MODEL_ID = "sensevoice-small-int8";
export const ASR_BIND_HOST = "127.0.0.1";

/** 上传 / 单次请求硬上限（WAV 16k mono）。 */
export const ASR_MAX_AUDIO_BYTES = 8 * 1024 * 1024; // 8 MB ≈ 4 分钟 16k mono 16bit
export const ASR_MAX_AUDIO_SECONDS = 120;

/** 空闲释放（用户要求：不录音时默认短 idle TTL，可配或立即释放）。 */
export const ASR_DEFAULT_IDLE_SECONDS = 90;
export const ASR_MIN_IDLE_SECONDS = 0;
export const ASR_MAX_IDLE_SECONDS = 3600;
