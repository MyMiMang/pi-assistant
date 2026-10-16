/**
 * 本地 ASR 接入**统一**「下载与组件」登记（复用 downloads.ts，不新建 registry / controller）。
 *
 * 用户要求：多个本地 ASR 模型可共存，但「组件页下载」与「语音页安装并使用」是**同一个 job**；
 * 取消走同一个 AbortController（manager.cancel），不另造下载链路。
 *
 * 做法（与 `local-laya/download.ts` 同构，但**事件驱动**，不装永久定时 loop）：
 *  - 每个 catalog 模型登记一个稳定 downloadId = `asr:<modelId>`（catalog.install.jobId 用它）；
 *  - `status()` 直接把 manager 的 install 状态投影成统一下载状态（首屏真实阶段）；
 *  - 别的入口（语音页 POST /models/:id/install）触发的安装，经 `local-asr.changed` 事件同步进下载面板。
 *  - 只有许可 `cleared` 且平台支持的模型登记为可下载；SenseVoice 保持「自行导入」，不在下载面板放按钮。
 */
import { bus } from "../bus.ts";
import { followStatus, registerDownload } from "../downloads.ts";
import { ASR_CATALOG } from "./catalog.ts";
import { localAsrService } from "./index.ts";
import type { AsrStatus } from "./manager.ts";
import { asrPhaseLabel } from "./service.ts";

export const ASR_DOWNLOAD_PREFIX = "asr:";

/** 每个模型的稳定 downloadId（同一次安装 = 同一个 job）。 */
export function asrDownloadId(modelId: string): string {
	return `${ASR_DOWNLOAD_PREFIX}${modelId}`;
}

interface InstallLike {
	state: AsrStatus["install"]["state"];
	phase: AsrStatus["install"]["phase"];
	received: number;
	total: number | null;
	error: string | null;
}

/**
 * 把 manager 的 install 状态投影成统一下载状态（纯函数，可单测）。
 * 只有权重阶段有可靠总量；其余阶段总量未知 → null → 界面显示不定进度，不编假百分比。
 */
export function projectAsrInstall(s: InstallLike) {
	return {
		state: s.state === "installed" ? ("ready" as const) : s.state === "installing" ? ("downloading" as const) : s.state === "failed" ? ("error" as const) : ("missing" as const),
		received: s.received,
		total: s.phase === "weights" ? s.total : null,
		detail: s.state === "installing" ? asrPhaseLabel(s.phase) : null,
		error: s.error,
	};
}

function platformKey(): string {
	return `${process.platform}-${process.arch}`;
}

function statusOf(modelId: string): AsrStatus {
	return localAsrService().managerFor(modelId).status();
}

/** 组件页「下载」按钮：装但不换来源（intent = install）。 */
export async function startAsrDownload(modelId: string): Promise<void> {
	const svc = localAsrService();
	if (svc.managerFor(modelId).status().install.state === "installing") return;
	void svc
		.install(modelId, { intent: "install" })
		.catch(() => {});
	followStatus(asrDownloadId(modelId), () => ({ active: svc.managerFor(modelId).status().install.state === "installing", ...projectAsrInstall(svc.managerFor(modelId).status().install) }));
}

/** 取消安装 / 下载：走 manager 同一个 AbortController（回滚 staging）。 */
export function cancelAsrDownload(modelId: string): void {
	localAsrService().cancel(modelId);
}

let registered = false;

/** 登记所有 catalog 模型到统一下载面板；幂等。由 http.ts 装配时调用一次。 */
export function registerAsrDownloads(): void {
	if (registered) return;
	registered = true;
	for (const spec of ASR_CATALOG) {
		const id = asrDownloadId(spec.id);
		registerDownload({
			id,
			name: spec.name,
			group: "本地模型",
			size: spec.manifest.bytes || undefined,
			installed: () => statusOf(spec.id).install.state === "installed",
			start: () => startAsrDownload(spec.id),
			cancel: () => cancelAsrDownload(spec.id),
			status: () => projectAsrInstall(statusOf(spec.id).install),
			// 许可未确认（SenseVoice）或平台不支持的不在下载面板放按钮（保留语音页「自行导入」）。
			hidden: () => spec.license.decision !== "cleared" || (spec.platforms.length > 0 && !spec.platforms.includes(platformKey())),
		});
	}
	// 事件驱动：任何入口（下载页 / 语音页）触发的安装都同步到同一下载条目；不装每模型永久定时 loop。
	bus.on((e) => {
		if (e.type !== "local-asr.changed") return;
		const modelId = (e as { modelId?: string }).modelId;
		const status = (e as { status?: AsrStatus }).status;
		if (!modelId || !status || !status.install) return;
		if (status.install.state === "installing") {
			followStatus(asrDownloadId(modelId), () => ({ active: statusOf(modelId).install.state === "installing", ...projectAsrInstall(statusOf(modelId).install) }));
		}
	});
}

// 模块加载即登记（与 local-laya/download.ts 同一写法）；只登记元数据，不构造 service、不启动 worker。
registerAsrDownloads();
