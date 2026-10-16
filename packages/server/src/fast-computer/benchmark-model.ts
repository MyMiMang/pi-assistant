/**
 * 基准测试「点哪条测哪条」的模型可用性纯逻辑。
 *
 * 只根据**真实注册状态**判断，不看前端传的字符串、不看全局快速模型是否开启：
 *  - 已在分类器目录且凭据可用 → ok；
 *  - 本地 Laya 已装未运行 → 明确 blocked + startable（由 UI 走既有 `/api/local-models/laya/start`，这里不偷开）；
 *  - 其它未注册 / 未配置 → 明确 blocked。
 *
 * 抽成纯函数便于单测；runtime 负责把 Pi 分类器目录 + Laya 状态喂进来。
 */
export interface BenchmarkModelResolution {
	ok: boolean;
	reason?: string;
	/** 已安装但未运行、可按既有流程启动（当前只有本地 Laya）；只表示可启动，不等于已就绪。 */
	startable?: boolean;
}

export interface BenchmarkModelInput {
	/** 该 provider 下真实注册的分类器（`configured` = 凭据可用）。 */
	classifiers: { id: string; configured: boolean }[];
	/** provider 是否是本地 Laya。 */
	isLocalLaya: boolean;
	/** 本地 Laya 的真实安装 / 运行状态；不是 Laya 或已注册时为 null。 */
	laya: { installed: boolean; installing: boolean; running: boolean } | null;
}

export function resolveBenchmarkModel(input: BenchmarkModelInput, provider: string, model: string): BenchmarkModelResolution {
	const hit = input.classifiers.find((m) => m.id === model);
	if (hit) return hit.configured ? { ok: true } : { ok: false, reason: `快速模型 ${provider}/${model} 还没有可用凭据，先在「模型服务」里配好。` };
	if (input.isLocalLaya) {
		if (input.laya?.installing) return { ok: false, reason: "本地 Laya 正在安装，装完再测。" };
		if (!input.laya?.installed) return { ok: false, reason: "本地 Laya 还没安装：先到「电脑 › 操作这台电脑」一键安装。" };
		return { ok: false, reason: "本地 Laya 已安装但未运行：先点「启动」，再回来测试。", startable: true };
	}
	return { ok: false, reason: `找不到快速模型 ${provider}/${model}（未注册 / 未配置凭据）。` };
}
