/**
 * 本地 Laya 一键安装的固定清单（版本 / revision SHA / 许可证）。
 *
 * 供应链原则：一切版本 pin 在这里，不从上游 `curl | sh`，不跟随 `latest`。
 *  - Laya 代码：PyPI `laya==0.4.8`（Apache-2.0）
 *  - 权重：HuggingFace `convaiinnovations/*`，pin 到 Laya 审核过的 commit SHA（见其三份 revisions.py）
 *  - Python：uv 托管的 CPython 3.12（python-build-standalone）
 * 升级本文件即代表「换审核快照」，必须同步 docs 与测试。
 */

/** 面向用户的来源说明（界面「来源标签」用）。 */
export interface LayaSourceMeta {
	project: string;
	repoUrl: string;
	weightsOrg: string;
	codeLicense: string;
	weightsLicense: string;
	version: string;
	/** Laya 审核快照对应的版本（revisions.py） */
	reviewedRevisions: Record<string, string>;
}

/** Laya 包版本（PyPI）。 */
export const LAYA_VERSION = "0.4.8";

/** Pin 到发布时核对的 Laya 代码来源。 */
export const LAYA_SOURCE: LayaSourceMeta = {
	project: "Laya（NandhaKishorM/laya）",
	repoUrl: "https://github.com/NandhaKishorM/laya",
	weightsOrg: "huggingface.co/convaiinnovations",
	codeLicense: "Apache-2.0",
	weightsLicense: "apache-2.0",
	version: LAYA_VERSION,
	// 与 research/laya/laya/revisions.py 的 PINNED_REVISIONS 一致（2026-10-15 快照）。
	reviewedRevisions: {
		"convaiinnovations/laya": "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851",
		"convaiinnovations/laya-multilingual": "e4e9ddf21a7b1903b7acffd8814ad4307bf63a67",
		"convaiinnovations/laya-typed-decisions": "1a793eb568e6718f15941d08f85432581df534e3",
	},
};

/** 默认安装的 checkpoint：只下 multilingual（约 647 MB），其余按需。 */
export const DEFAULT_CHECKPOINT = "laya-multilingual";

/** 我们支持的 checkpoint 清单（repo + revision SHA + 常驻大小估计）。 */
export interface LayaCheckpoint {
	id: string;
	repo: string;
	revision: string;
	/** 上游记录的 model card 许可证 */
	license: string;
	/** 大约大小（字节），仅界面显示用 */
	bytes: number;
}

export const LAYA_CHECKPOINTS: Record<string, LayaCheckpoint> = {
	[`${DEFAULT_CHECKPOINT}`]: {
		id: DEFAULT_CHECKPOINT,
		repo: `convaiinnovations/${DEFAULT_CHECKPOINT}`,
		revision: LAYA_SOURCE.reviewedRevisions[`convaiinnovations/${DEFAULT_CHECKPOINT}`],
		license: LAYA_SOURCE.weightsLicense,
		bytes: 678_000_000,
	},
	"laya-typed-decisions": {
		id: "laya-typed-decisions",
		repo: "convaiinnovations/laya-typed-decisions",
		revision: LAYA_SOURCE.reviewedRevisions["convaiinnovations/laya-typed-decisions"],
		license: LAYA_SOURCE.weightsLicense,
		bytes: 846_000_000,
	},
};

/** uv 托管的 Python 版本（python-build-standalone，不装到系统 Python）。 */
export const PYTHON_VERSION = "3.12";

/** 传给 Laya 进程的协议相关固定项。 */
export const JEV_PROTOCOL = "typesafe-system-one";
