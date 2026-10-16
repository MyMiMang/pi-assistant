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
	/** 是否必须显式接受条款（宽松许可 MIT / Apache-2.0 不需要；默认 false） */
	requiresExplicitAgreement: boolean;
	links: { modelCard: string; modelLicense: string; issue?: string; engineLicense: string };
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
	// FunASR 条款适用范围需用户确认，允许 override 的高级路径上要求显式接受
	requiresExplicitAgreement: true,
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
	/** 运行族 id（见 runner.ts）：决定生成的 serve 脚本与权重校验规则 */
	runner?: string;
	/** 运行族需要的文件角色 → 清单内相对路径（如 `{ model: "model.int8.onnx", tokens: "tokens.txt" }`） */
	fileRoles?: Record<string, string>;
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
	runner: "sensevoice",
	fileRoles: { model: "model.int8.onnx", tokens: "tokens.txt" },
};

/**
 * 引擎（sherpa-onnx）wheel 供应链固定。
 *
 * 公开来源：PyPI `sherpa-onnx==1.13.8` 的 JSON 元数据（2026-10-15 复核），
 * `sherpa-onnx` 仅依赖 `sherpa-onnx-core==1.13.8`（后者无依赖）。两个 wheel 的 SHA256 逐平台固定。
 * Python 固定 3.12（`ASR_PYTHON_VERSION`）→ `sherpa-onnx` 用 cp312 轮子；`sherpa-onnx-core` 是 py3-none。
 * macOS 上 pip 可能在 arch 专用与 universal2 间选择，故两组摘要都列入（`--require-hashes` 任一匹配即可）。
 * 缺固定摘要的平台 = **fail closed**，绝回退到未校验安装。
 */
export interface SherpaEnginePin {
	package: string;
	version: string;
	/** 该平台可接受的官方 wheel SHA256（多个=任一匹配即通过） */
	sha256: string[];
}
export const SHERPA_ONNX_WHEEL_PINS: Record<string, SherpaEnginePin[]> = {
	"darwin-arm64": [
		{ package: "sherpa-onnx", version: SHERPA_ONNX_VERSION, sha256: ["04b9268c348e9f4bd61315754ad06b02a3c185d3d7770acd8e2dcee9c2e039f9", "17ff957b1b33849671262ddbac51815a5a82286f963091bddf85540c9e728c12"] },
		{ package: "sherpa-onnx-core", version: SHERPA_ONNX_VERSION, sha256: ["9312bbd46c93e31cecd3abda9cc8e71881d86cc3da3c35c7445ab04025b9fc3e", "b279ad024b37f2999834abc5583fe9e70df0fb3f37c20a2d1e76e75ad2ccb1a1"] },
	],
	"darwin-x64": [
		{ package: "sherpa-onnx", version: SHERPA_ONNX_VERSION, sha256: ["ef218d6545a9dcc2aff7043f39026c7d78d6cf46a3876d450d508feebffc00a9", "17ff957b1b33849671262ddbac51815a5a82286f963091bddf85540c9e728c12"] },
		{ package: "sherpa-onnx-core", version: SHERPA_ONNX_VERSION, sha256: ["917422880287baa0f0ae1bd10d9528fa78af8cc7c233d2a953a185a4fe8d83f2", "b279ad024b37f2999834abc5583fe9e70df0fb3f37c20a2d1e76e75ad2ccb1a1"] },
	],
	"win32-x64": [
		{ package: "sherpa-onnx", version: SHERPA_ONNX_VERSION, sha256: ["566e49ad3fb2aa8ceb723a52f9809aa6c2ee0a5eb3b0946c3fd2374af807a5c6"] },
		{ package: "sherpa-onnx-core", version: SHERPA_ONNX_VERSION, sha256: ["5579e80196d516e6dae23c8f629292ce3142ab8869925d32b94612fd86f93733"] },
	],
	"win32-arm64": [
		{ package: "sherpa-onnx", version: SHERPA_ONNX_VERSION, sha256: ["1613f14db38b6936098c660f610baee95541378edbdec39a973a591d8df58f5b"] },
		{ package: "sherpa-onnx-core", version: SHERPA_ONNX_VERSION, sha256: ["85e9b12e9e985d73ad9165a1122c396e2c9384256a4023cd7cf9c91bc8d32073"] },
	],
	"linux-x64": [
		{ package: "sherpa-onnx", version: SHERPA_ONNX_VERSION, sha256: ["6949773017647febc0c3696dffb2c67dd3febd4737b87e3dd135a42773704a06"] },
		{ package: "sherpa-onnx-core", version: SHERPA_ONNX_VERSION, sha256: ["4da90acf435373d7b2ba9cc0be806e7e274d28f63f5780880b5dea6721626e36"] },
	],
	"linux-arm64": [
		{ package: "sherpa-onnx", version: SHERPA_ONNX_VERSION, sha256: ["2520b1e7b779a29a493a8cec893612218dfad7304786bf3f64df2ff7ac6c3302"] },
		{ package: "sherpa-onnx-core", version: SHERPA_ONNX_VERSION, sha256: ["a51a03d55c376c32e15dd63ea852236042ba91a5cd73e253bbf7cf21f6582ba9"] },
	],
};

/** 生成 `uv pip install --require-hashes -r` 用的 requirements 内容；平台无固定摘要时返回原因（拒绝安装）。 */
export function sherpaRequirements(platformKey: string): { ok: true; content: string } | { ok: false; reason: string } {
	const pins = SHERPA_ONNX_WHEEL_PINS[platformKey];
	if (!pins || !pins.length) return { ok: false, reason: `没有 ${platformKey} 的引擎 wheel 固定摘要，拒绝未校验的安装` };
	const lines = pins.map((p) => `${p.package}==${p.version} ${p.sha256.map((h) => `--hash=sha256:${h}`).join(" ")}`);
	return { ok: true, content: `${lines.join("\n")}\n` };
}

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
