/**
 * 本地 ASR 接入**统一**「下载与组件」登记（复用 downloads.ts，不新建 registry / controller）。
 *
 * 用户要求：多个本地 ASR 模型可共存，但「组件页下载」与「语音页安装并使用」是**同一个 job**；
 * 取消走同一个 AbortController（manager.cancel），不另造下载链路。
 *
 * 做法（与 `local-laya/download.ts` 同构，**事件驱动**，不装轮询 loop）：
 *  - 每个 catalog 模型登记一个稳定 downloadId = `asr:<modelId>`（catalog.install.jobId 用它）；
 *  - `status()` 直接把 manager 的 install 状态投影成统一下载状态（首屏真实阶段）；
 *  - 别的入口（语音页 POST /models/:id/install）触发的安装，经 `local-asr.changed` 事件同步进下载面板；
 *  - 事件只负责 `notifyDownload(id, force)` 让统一下载面板重读投影，**不再每秒轮询** manager；
 *  - 本地按需下载放行的模型（`license.selfServe`）都登记为可下载（含 SenseVoice：个人自用；不随 App 分发 / 不镜像）。
 */
import { bus } from "../bus.ts";
import { notifyDownload, registerDownload } from "../downloads.ts";
import { ASR_CATALOG } from "./catalog.ts";
import { clearDefaultOptOut } from "./default-voice-prep.ts";
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

/** 组件页「下载」按钮：装但不换来源（intent = install）。进度由事件驱动（见下），这里不另起轮询。 */
export async function startAsrDownload(modelId: string): Promise<void> {
	const svc = localAsrService();
	if (svc.managerFor(modelId).status().install.state === "installing") return;
	// 显式重试默认本地语音（模型维度）：清掉「不再自动装」标记；**不改**来源（采用仍走 install_and_use 的 CAS）。
	if (modelId === svc.defaultVoiceModelId()) clearDefaultOptOut();
	void svc
		.install(modelId, { intent: "install" })
		.catch(() => {});
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
			// 本地自用下载未放行（selfServe=false）或平台不支持的模型不在下载面板放按钮。
			hidden: () => !spec.license.selfServe || (spec.platforms.length > 0 && !spec.platforms.includes(platformKey())),
		});
	}
	// 进度**事件驱动**：任何入口（下载页 / 语音页）触发的安装，manager 每次状态变化都推 `local-asr.changed`，
	// 这里把它转发给统一下载面板重读投影。首帧与终态立即发（force），常规进度沿用 downloads.ts 的 500ms 节流。
	bus.on((e) => {
		if (e.type !== "local-asr.changed") return;
		const modelId = (e as { modelId?: string }).modelId;
		const status = (e as { status?: AsrStatus }).status;
		if (!modelId || !status?.install) return;
		notifyDownload(asrDownloadId(modelId), status.install.state !== "installing");
	});
}

// 模块加载即登记（与 local-laya/download.ts 同一写法）；只登记元数据，不构造 service、不启动 worker。
registerAsrDownloads();
