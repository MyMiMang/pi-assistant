/**
 * 本地 Laya 接入**统一**「下载与组件」登记（复用 downloads.ts，不新建 registry / controller）。
 *
 * 背景：Laya 安装有自己的分阶段状态（`/status` 的 install.phase/received/error），旧设计因此不登记下载面板，
 * 结果用户「在下载和组件里看不到 Laya」。这里把同一个 manager 安装任务登记成统一下载条目：
 *  - 两个入口（设置 › 电脑 › 操作这台电脑 的 Laya 卡，与 设置 › 下载与组件）读同一个 job；
 *  - 进度分阶段：权重阶段按**真实字节**显示百分比；其余阶段总量未知 → 不定进度条 + 阶段文字（不显示假百分比）；
 *  - 取消走同一个 installAbortController（manager.cancel），原子回滚 staging，不动已生效环境。
 *
 * 只是用统一的 `status` 投影 + `followStatus` 观察 manager 状态，不复制安装逻辑，不另起下载链路。
 * 通用契约见 downloads.ts 的 `DownloadStatus` / `followStatus`（本地 ASR 可直接复用，勿另写一套）。
 */
import { registerDownload, followStatus } from "../downloads.ts";
import { layaManager } from "./index.ts";
import { DEFAULT_CHECKPOINT, LAYA_CHECKPOINTS } from "./manifest.ts";
import type { LayaStatus } from "./manager.ts";

export const LAYA_DOWNLOAD_ID = "local-laya";

/** 阶段中文（界面按钮/进度条用），与 local-laya-api.md 的 phase 对应。 */
const PHASE_LABEL: Record<string, string> = {
	preflight: "检查平台能力",
	uv: "准备 uv",
	venv: "创建虚拟环境",
	torch: "安装 Python 依赖（torch / laya）",
	laya: "安装 Laya",
	weights: "下载模型权重",
	verify: "校验权重完整性",
	activate: "切换生效环境",
	rollback: "回滚",
};

/** 把 manager 的 install 状态投影成统一下载状态（纯函数，两个入口读这一个；单测直接注入 status）。 */
export function projectLayaInstall(s: LayaStatus["install"]) {
	return {
		state: s.state === "installed" ? ("ready" as const) : s.state === "installing" ? ("downloading" as const) : s.state === "failed" ? ("error" as const) : ("missing" as const),
		received: s.received,
		// 只有权重阶段有可靠总量；依赖安装等阶段总量未知 → null → 界面显示不定进度，不编假百分比。
		total: s.phase === "weights" ? s.total : null,
		detail: PHASE_LABEL[s.phase] ?? s.phase,
		error: s.error,
	};
}

function project() {
	return projectLayaInstall(layaManager().status().install);
}

/** 开始 / 重试安装：唯一入口。已在安装中直接返回，避免两个入口重复触发二次安装。 */
export function startLayaDownload(): Promise<void> {
	const m = layaManager();
	if (m.status().install.state === "installing") return Promise.resolve();
	void m.install({ checkpoint: LAYA_CHECKPOINTS[DEFAULT_CHECKPOINT] }).catch(() => {});
	followStatus(LAYA_DOWNLOAD_ID, () => ({ active: layaManager().status().install.state === "installing", ...project() }));
	return Promise.resolve();
}

/** 取消安装 / 下载：走 manager 同一个 AbortController（回滚 staging，保留 HF partial 可续传）。 */
export function cancelLayaDownload() {
	return layaManager().cancel();
}

registerDownload({
	id: LAYA_DOWNLOAD_ID,
	name: "本地快速操作模型（Laya）",
	group: "本地模型",
	size: LAYA_CHECKPOINTS[DEFAULT_CHECKPOINT].bytes || undefined,
	installed: () => layaManager().status().configured,
	start: () => startLayaDownload(),
	cancel: () => cancelLayaDownload(),
	status: () => project(),
});

// 别的入口（设置 › 电脑 的 Laya 卡直接 POST /install）也会被这里接上进度，保证两个入口同一个 job。
const watcher = setInterval(() => {
	if (layaManager().status().install.state === "installing") {
		followStatus(LAYA_DOWNLOAD_ID, () => ({ active: layaManager().status().install.state === "installing", ...project() }));
	}
}, 1000);
watcher.unref();
