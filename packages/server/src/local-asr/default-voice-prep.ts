/**
 * 「默认本地语音」的**状态视图类型**（契约 §1.1 的 `defaultVoice` 块）。
 *
 * 本地语音识别是**可选模块**（决策 0013）：默认不安装、启动时不自动下载；只有用户在 设置 › 语音 里选好模型点「安装所选模型」
 * （或在「下载与组件」里点下载）才准备共享运行环境 + 所选模型。云端语音不依赖它。
 * 不覆盖任何已有选择：装好后只有「安装并使用」且来源从未设置、期间没被改选，才由 CAS 写成本地默认。
 *
 * 设计见 `docs/design/local-voice-optional.md`；契约见 `docs/design/default-stream-contract.md` §1。
 */

export interface DefaultVoicePrepView {
	/** 目录里的默认本地语音（安装前选择器预选它） */
	defaultModelId: string | null;
	/** 模块当前对应的模型：正在装 / 正在用 / 已装 / 装失败的那个，都没有时 = 默认 */
	modelId: string | null;
	/** `modelId` 的界面名 */
	modelName: string | null;
	kind: "user-chosen" | "default" | "unconfigured";
	label: string;
	prep: {
		state: "not_applicable" | "not_prepared" | "preparing" | "ready" | "failed";
		jobId: string | null;
		phase: string | null;
		phaseLabel: string | null;
		received: number | null;
		total: number | null;
		percent: number | null;
		attempt: number | null;
		startedAt: string | null;
		finishedAt: string | null;
		error: string | null;
		errorCode: string | null;
		retryable: boolean;
	};
	firstRunNeedsNetwork: boolean;
	approxBytes: number | null;
	offlineAfterReady: boolean;
	/** 可选模块：必须用户显式安装（true）。 */
	requiresUserAction: true;
	micPermissionRequested: false;
	notes: string[];
}
