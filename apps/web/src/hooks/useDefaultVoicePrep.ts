/**
 * 设置 › 语音配置：默认本地语音的**准备状态**（读 `GET /api/audio/asr/source` 的 `defaultVoice` 块）。
 *
 * 复用既有模块，不另造链路：进度来自统一下载注册表（同一个 `asr:<modelId>` job），
 * 取消 / 重试走统一下载组件的 `POST /api/downloads/:id/cancel|start`。
 * **前端不写 source**：自动采用默认由服务端 CAS + opt-out 管（契约 §1.2）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { cancelDefaultVoicePrepare, getVoiceSource, onVoiceSourceChanged, retryDefaultVoicePrepare } from "../api";
import type { LiveDownloadLike } from "../local-asr-intent";
import { useStore } from "../store";
import { mergePrepareDownload, normalizeVoicePrepareView, type VoicePrepareView } from "../voice-pref";

export interface UseDefaultVoicePrep {
	/** 归一化后的准备状态；`null` = 后端没给 `defaultVoice` 块（旧后端）。 */
	prep: VoicePrepareView | null;
	loading: boolean;
	/** 起 / 停下载组件请求进行中。 */
	busy: boolean;
	/** 读取 / 操作失败说明（可重试）。 */
	error: string;
	reload: () => Promise<void>;
	cancel: () => Promise<void>;
	retry: () => Promise<void>;
}

export function useDefaultVoicePrep(): UseDefaultVoicePrep {
	const [raw, setRaw] = useState<VoicePrepareView | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	// 统一下载注册表的实时进度（同一个 job id）；store 更新会触发重渲染，无需轮询。
	const downloads = useStore((s) => s.downloads) as Record<string, LiveDownloadLike> | undefined;

	const reload = useCallback(async () => {
		try {
			const view = await getVoiceSource();
			setRaw(view.defaultVoice ? normalizeVoicePrepareView(view.defaultVoice) : null);
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void reload();
	}, [reload]);
	// 来源 / 准备状态在别处变化（服务端事件、设置页保存）：复用同一 bus 刷新，不轮询。
	useEffect(() => onVoiceSourceChanged(() => void reload()), [reload]);

	const prep = useMemo(() => (raw ? mergePrepareDownload(raw, raw.jobId ? downloads?.[raw.jobId] : undefined) : null), [raw, downloads]);

	const act = useCallback(
		async (fn: () => Promise<void>) => {
			const id = prep?.jobId;
			if (!id) return;
			setBusy(true);
			setError("");
			try {
				await fn();
				await reload();
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setBusy(false);
			}
		},
		[prep?.jobId, reload],
	);

	return {
		prep,
		loading,
		busy,
		error,
		reload,
		cancel: () => act(cancelDefaultVoicePrepare),
		retry: () => act(retryDefaultVoicePrepare),
	};
}
