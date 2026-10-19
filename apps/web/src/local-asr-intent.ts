/**
 * 本地语音前端的 intent / stale 守卫与展示格式化（纯函数，可单测，不依赖 React / DOM）。
 *
 * 「安装并使用」的来源写入由后端 `intent:"install_and_use"` 负责（服务端在装完且选择未变时写 source），
 * 前端只按 catalog 的 `selected` 显示，不自己 late PUT。
 * 这里只保留**前端显式「使用这个模型」PUT** 的竞态守卫：后一次选择必须生效，先前的在途 PUT 不得 late 覆盖。
 */

export interface AsrIntentState {
	/** 自增序号：每次用户显式改选都 +1；在途回调靠它判断是否仍是当前选择。 */
	seq: number;
}

export const emptyAsrIntent = (): AsrIntentState => ({ seq: 0 });

/** 用户动作开始：返回新状态 + 该动作的 token。 */
export function beginAsrIntent(state: AsrIntentState): { state: AsrIntentState; token: number } {
	const token = state.seq + 1;
	return { state: { seq: token }, token };
}

/** 外部改选（在别处把来源改到云端 / 别的模型）→ 作废在途回调。 */
export function invalidateAsrIntent(state: AsrIntentState): AsrIntentState {
	return { seq: state.seq + 1 };
}

export function isCurrentAsrIntent(state: AsrIntentState, token: number): boolean {
	return state.seq === token;
}

// ---------------------------------------------------------------- 展示格式化（不杜撰：只格式化真实数值）

/** 模型体积 / 内存：十进制单位（1000），与下载页 / 研究清单的 MB/GB 一致。 */
export function formatBytes(n: number | null | undefined): string {
	if (n == null || !Number.isFinite(n) || n <= 0) return "未知";
	if (n < 1000) return `${n} B`;
	if (n < 1000 ** 2) return `${(n / 1000).toFixed(1)} KB`;
	if (n < 1000 ** 3) return `${(n / 1000 ** 2).toFixed(0)} MB`;
	return `${(n / 1000 ** 3).toFixed(2)} GB`;
}

export const TIER_LABEL: Record<string, string> = { light: "轻量", balanced: "均衡", high: "高质量", unknown: "未分级" };

/** 档位标签 = 后端给的**推荐建议**，不是实测跑分（Help 里说明）。 */
export function tierLabel(tag: string): string {
	return TIER_LABEL[tag] ?? tag;
}

/** total 未知 → 不确定进度条（phase 名 + 动画），不画假百分比。 */
export function isIndeterminate(total: number | null | undefined): boolean {
	return total == null || total <= 0;
}

/** 安装进度：不确定时返回 null（前端不显示百分比）。 */
export function installPercent(received: number, total: number | null | undefined): number | null {
	if (isIndeterminate(total)) return null;
	return Math.max(0, Math.min(100, Math.round((received / total!) * 100)));
}

/** 内存「配置建议」文案：明确标注估算、未实测，不把某档位写成硬门槛。 */
export function memoryAdvice(bytes: number, note: string): string {
	if (!bytes) return note || "未给出内存建议";
	return `运行内存约 ${formatBytes(bytes)}${note ? `（${note}）` : ""} · 估算，未实测`;
}

// ---------------------------------------------------------------- 统一下载注册表进度合并

/** 下载注册表里的条目字段（结构化，避免把 Downloads.tsx 拉进来）。 */
export interface LiveDownloadLike {
	state: "missing" | "downloading" | "ready" | "error";
	received: number;
	total: number | null;
	percent: number | null;
	error: string | null;
}

/** 把下载注册表的实时进度并进安装态（组件页 / 语音页两个入口看到同一份进度）。 */
export function mergeLiveDownload<T extends { state: string; received: number; total: number | null; percent: number | null; phase: string | null; phaseLabel: string | null; error: string | null }>(install: T, live: LiveDownloadLike | undefined): T {
	if (!live) return install;
	if (live.state === "downloading") return { ...install, state: "installing", received: live.received, total: live.total, percent: live.percent ?? install.percent, phase: install.phase ?? "weights", error: null };
	if (live.state === "error") return { ...install, state: "failed", error: live.error ?? install.error };
	return install;
}

/**
 * 本地模型下拉该停在哪一项。优先级：正在用的（服务端 `selected`，即已保存的来源）→ 推荐 → 已安装 → 第一个。
 * `current` 是用户这次打开后自己点过的：只要还在目录里就保留；但已保存的来源换了（别处「使用」/ 装完切过去）就跟过去。
 */
export function localAsrPick(models: { id: string; selected: boolean; installed: boolean }[], recommendedId: string | null, current: string, savedChanged = false): string {
	const saved = models.find((m) => m.selected)?.id;
	if (savedChanged && saved) return saved;
	if (current && models.some((m) => m.id === current)) return current;
	if (saved) return saved;
	if (recommendedId && models.some((m) => m.id === recommendedId)) return recommendedId;
	return models.find((m) => m.installed)?.id ?? models[0]?.id ?? "";
}

/** 装这个模型大约要下载多少（估算）：权重 + 共享运行环境；运行环境所有模型共用、只算一次（已就位就不再计）。 */
export function localVoiceDownloadBytes(m: { weightsBytes: number }, runtime: { downloadBytes: number | null; present: boolean }): number {
	return m.weightsBytes + (runtime.present ? 0 : (runtime.downloadBytes ?? 0));
}

/** 安装前模型选择器的一项（复用 ui.tsx 的 Select）：名字 + 一行「适合什么」+ 右侧大约下载量。 */
export function localVoiceOption(m: { id: string; name: string; suits: string; note: string; weightsBytes: number; available: boolean; unavailableReason: string | null }, runtime: { downloadBytes: number | null; present: boolean }) {
	const desc = !m.available ? (m.unavailableReason ?? "这台电脑上不能安装") : m.suits || m.note;
	return { value: m.id, label: m.name, desc, hint: `约 ${formatBytes(localVoiceDownloadBytes(m, runtime))}` };
}
