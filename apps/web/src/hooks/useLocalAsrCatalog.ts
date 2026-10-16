/**
 * 本地语音多模型：拉 catalog、订阅统一下载进度、安装态轮询、显式「使用」的竞态守卫。
 *
 * 复用的既有模块：`store.ts` 的 `downloads`（统一下载注册表实时进度，按 stable downloadId 合并）；
 * 来源真相由服务端；UI 本地 seq 只用于**丢弃过期操作的视觉状态**（不作权威）。
 *
 * 契约（与 backendowner 的 local-asr-multi-model 对齐）：
 *  - 「安装并使用」= `install { intent: "install_and_use" }`；来源由服务端在装完且选择未变时写
 *    （后端自带 stale 防护）。前端只看 catalog 的 `selected`，不自己 late PUT。
 *  - 「使用这个模型」（已安装未选中）= `POST /models/:id/select`（后端写来源 + 启停 worker，忙时拒绝）。
 *    **不**在前端另造一条写 source 的路径（避免两处同时写 / 迟到覆盖）；状态以 catalog `selected` 为准。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emitVoiceSourceChanged, onVoiceSourceChanged } from "../api";
import {
	cancelLocalAsrModel,
	deleteLocalAsrModel,
	emptyLocalAsrCatalog,
	getLocalAsrCatalog,
	installLocalAsrModel,
	type LocalAsrCatalogView,
	type LocalAsrModelView,
	selectLocalAsrModel,
	startLocalAsrModel,
	stopLocalAsrModel,
	updateLocalAsrModel,
} from "../local-asr-api";
import { beginAsrIntent, emptyAsrIntent, invalidateAsrIntent, isCurrentAsrIntent, mergeLiveDownload, type AsrIntentState, type LiveDownloadLike } from "../local-asr-intent";
import { useStore } from "../store";

export interface UseLocalAsrCatalog {
	catalog: LocalAsrCatalogView;
	loading: boolean;
	/** catalog 读取失败 / 结构不可用时的中文说明（为空 = 正常）。 */
	error: string;
	/** 安装 / 切换 / 删除等操作失败说明（可重试）。 */
	opError: string;
	/** 正在进行的操作对应的 model id。 */
	busy: string | null;
	reload: () => Promise<void>;
	/** 安装并使用：`install { intent: "install_and_use" }` → 装好由服务端写来源（selected）。 */
	installUse: (m: LocalAsrModelView) => Promise<void>;
	/** 已安装但没在用：调 `POST /models/:id/select` 设为来源（后端写 source + 启停 worker）。 */
	use: (m: LocalAsrModelView) => Promise<void>;
	/** 导入已合法取得的权重（`source:"import"`，只复制清单内文件，不走下载）。 */
	importWeights: (m: LocalAsrModelView, dir: string) => Promise<void>;
	/** 取消进行中的安装。 */
	cancel: (m: LocalAsrModelView) => Promise<void>;
	/** 启动 / 停止该模型的 sidecar（lazy，可选操作）。 */
	start: (m: LocalAsrModelView) => Promise<void>;
	stop: (m: LocalAsrModelView) => Promise<void>;
	update: (m: LocalAsrModelView) => Promise<void>;
	/** 删除该模型（只删自己目录）。 */
	remove: (m: LocalAsrModelView) => Promise<void>;
	clearOpError: () => void;
}

export function useLocalAsrCatalog(): UseLocalAsrCatalog {
	const [rawCatalog, setRawCatalog] = useState<LocalAsrCatalogView | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [opError, setOpError] = useState("");
	const [busy, setBusy] = useState<string | null>(null);

	const intentRef = useRef<AsrIntentState>(emptyAsrIntent());
	const mountedRef = useRef(true);
	const prevSelectedRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const downloads = useStore((s) => s.downloads) as Record<string, LiveDownloadLike> | undefined;

	const reload = useCallback(async () => {
		try {
			const cat = await getLocalAsrCatalog();
			if (!mountedRef.current) return;
			setRawCatalog(cat);
			setError(cat.ok ? "" : "本地模型目录暂不可用（后端未提供 catalog）");
			// 服务端可能在后台（intent: install_and_use）把来源切到了某本地模型：检测 selected 翻转，
			// 通知语音页刷新状态徽标（前端 setVoiceSource 才发这个事件，这里补一次）。
			const nowSelected = new Set(cat.models.filter((m) => m.selected).map((m) => m.id));
			const flipped = [...nowSelected].some((id) => !prevSelectedRef.current.has(id));
			prevSelectedRef.current = nowSelected;
			if (flipped) emitVoiceSourceChanged();
		} catch (e) {
			if (!mountedRef.current) return;
			setRawCatalog(emptyLocalAsrCatalog());
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			if (mountedRef.current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		void reload();
	}, [reload]);

	// 外部把来源改到别处（例如在语音页保存了云端）→ 作废在途「使用」的视觉回调，并重读 catalog（selected 以服务端为准）。
	useEffect(() => {
		const off = onVoiceSourceChanged(() => {
			intentRef.current = invalidateAsrIntent(intentRef.current);
			void reload();
		});
		return off;
	}, [reload]);

	// 安装中轮询（契约：1s）；其余状态由 downloads.changed 合并驱动。
	const installing = !!rawCatalog?.models.some((m) => m.install.state === "installing");
	useEffect(() => {
		if (!installing) return;
		const t = setInterval(() => void reload(), 1000);
		return () => clearInterval(t);
	}, [installing, reload]);

	const run = useCallback(
		async (m: LocalAsrModelView, body: (id: string) => Promise<unknown>) => {
			setBusy(m.id);
			setOpError("");
			try {
				await body(m.id);
				await reload();
			} catch (e) {
				setOpError(e instanceof Error ? e.message : String(e));
			} finally {
				if (mountedRef.current) setBusy(null);
			}
		},
		[reload],
	);

	const installUse = useCallback(
		async (m: LocalAsrModelView) => {
			// 显式改选 → 作废可能在途的「使用」视觉回调。
			intentRef.current = beginAsrIntent(intentRef.current).state;
			setBusy(m.id);
			setOpError("");
			try {
				// 许可分级：MIT/Apache（`agreementRequired=false`）不弹「我同意」也不传 `acceptLicense`（不伪造同意）；
				// 仅确需显式同意的许可原样回传 acceptValue（SenseVoice unresolved 已被按钮禁用，装不了）。
				const needsAccept = m.license.agreementRequired && !!m.license.acceptValue;
				await installLocalAsrModel(m.id, { source: "download", intent: "install_and_use", ...(needsAccept ? { acceptLicense: m.license.acceptValue } : {}) });
				await reload();
			} catch (e) {
				setOpError(e instanceof Error ? e.message : String(e));
			} finally {
				if (mountedRef.current) setBusy(null);
			}
		},
		[reload],
	);

	const use = useCallback(
		async (m: LocalAsrModelView) => {
			const { state, token } = beginAsrIntent(intentRef.current);
			intentRef.current = state;
			setBusy(m.id);
			setOpError("");
			try {
				// 与后端 install_and_use 同一条写来源路径（selection.write），不另造前端 PUT source。
				await selectLocalAsrModel(m.id);
				await reload();
			} catch (e) {
				// 后端忙（录音 / 有未完成请求）会拒绝切换：明确报错，不假装成功。
				if (mountedRef.current && isCurrentAsrIntent(intentRef.current, token)) setOpError(`切换到「${m.name}」失败：${e instanceof Error ? e.message : String(e)}`);
				await reload();
			} finally {
				if (mountedRef.current) setBusy(null);
			}
		},
		[reload],
	);

	const view = useMemo<LocalAsrCatalogView>(() => {
		const base = rawCatalog ?? emptyLocalAsrCatalog();
		if (!downloads || !base.ok) return base;
		return {
			...base,
			models: base.models.map((m) => {
				const install = mergeLiveDownload(m.install, downloads[m.downloadId]);
				return install === m.install ? m : { ...m, install };
			}),
		};
	}, [rawCatalog, downloads]);

	return {
		catalog: view,
		loading,
		error,
		opError,
		busy,
		reload,
		installUse,
		use,
		importWeights: (m, dir) => run(m, (id) => installLocalAsrModel(id, { source: "import", importDir: dir })),
		cancel: (m) => run(m, cancelLocalAsrModel),
		start: (m) => run(m, startLocalAsrModel),
		stop: (m) => run(m, stopLocalAsrModel),
		update: (m) => run(m, updateLocalAsrModel),
		remove: (m) => run(m, deleteLocalAsrModel),
		clearOpError: () => setOpError(""),
	};
}
