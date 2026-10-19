/**
 * 设置 › 语音：本地语音识别（**可选模块**，默认不安装）的状态（读 `GET /api/audio/asr/source` 的 `defaultVoice` 块）。
 *
 * 复用既有模块，不另造链路：进度来自统一下载注册表（同一个 `asr:<modelId>` job），
 * 安装 / 取消走本地语音窄接口（手机也能用）。`install(modelId)` 只装用户在模块卡上选的那个模型，装完由服务端
 * CAS 设为语音来源（期间改选过就不覆盖）；没切成时 `adopt()` 让用户显式把它设为语音来源（复用 `setVoiceSource`）。
 * 状态跟着「模块当前对应的模型」（`prep.modelId`：正在装 / 正在用 / 已装 / 装失败的那个）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { cancelDefaultVoicePrepare, getVoiceSource, installDefaultVoice, onVoiceSourceChanged, setVoiceSource, type VoiceSource } from "../api";
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
	/** 模块当前模型对应的来源（装好后用于「设为语音来源」）；目录里没有时为 null。 */
	moduleSource: VoiceSource | null;
	/** 当前语音来源就是它。 */
	inUse: boolean;
	reload: () => Promise<void>;
	cancel: () => Promise<void>;
	/** 安装所选模型（未安装时）/ 重试（失败时，省略 modelId）：同一个窄接口、同一个下载 job。 */
	install: (modelId?: string) => Promise<void>;
	adopt: () => Promise<void>;
}

export function useDefaultVoicePrep(): UseDefaultVoicePrep {
	const [raw, setRaw] = useState<VoicePrepareView | null>(null);
	const [moduleSource, setModuleSource] = useState<VoiceSource | null>(null);
	const [inUse, setInUse] = useState(false);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	// 统一下载注册表的实时进度（同一个 job id）；store 更新会触发重渲染，无需轮询。
	const downloads = useStore((s) => s.downloads) as Record<string, LiveDownloadLike> | undefined;

	const reload = useCallback(async () => {
		try {
			const view = await getVoiceSource();
			const norm = view.defaultVoice ? normalizeVoicePrepareView(view.defaultVoice) : null;
			setRaw(norm);
			const opt = norm?.modelId ? view.options.find((o) => o.location === "local" && o.model === norm.modelId) : undefined;
			setModuleSource(opt ? { location: "local", provider: opt.provider, model: opt.model } : null);
			setInUse(!!opt?.selected);
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
		async (fn: () => Promise<unknown>) => {
			if (!prep?.jobId) return;
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
		moduleSource,
		inUse,
		reload,
		cancel: () => act(() => cancelDefaultVoicePrepare(prep?.modelId ?? undefined)),
		install: (modelId?: string) => act(() => installDefaultVoice(modelId)),
		adopt: () => act(async () => moduleSource && setVoiceSource(moduleSource)),
	};
}
