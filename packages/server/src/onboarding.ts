import { db, getSetting, setSetting } from "./db.ts";
import { defaultModel } from "./models.ts";

/**
 * 首次运行向导的状态。
 *
 * 背景：`/api/system` 原来用 `getSetting("onboarded") && !!defaultModel() && listAgents().length > 0`
 * 判断是否显示向导。`defaultModel()` 会经 Pi 的模型目录解析当前设置，配置读取失败 / 模型暂时不可解析时
 * 会返回 null，于是「已配置过」被误判成「没配置」，升级或短暂故障后强行弹出首次向导（还可能覆盖原配置）。
 * 这里改成只看**持久、非敏感**的信号（向导标志、默认模型设置、助理数量），模型此刻是否可解析单列为
 * `modelReady`，界面据此提示可恢复错误，而不是重走首次设置。
 */

export interface OnboardingState {
	/** 是否需要显示首次运行向导 */
	onboarded: boolean;
	/** 用户是否已经走过「选模型」这一步（决定向导从哪一步开始） */
	modelSetupDone: boolean;
	/** 模型此刻是否可解析（凭据 / 目录正常）。false 时 onboarded 仍可为 true，界面应提示可恢复错误，不重走向导 */
	modelReady: boolean;
}

const agentCount = () => (db.prepare("SELECT COUNT(*) AS c FROM agents").get() as { c: number }).c;
/** 用户设置过默认模型（持久信号，不依赖凭据是否能读、模型目录是否能解析） */
const hasModelSetting = () => getSetting("defaultModel", null) != null;

export function onboardingState(): OnboardingState {
	const flag = getSetting("onboarded", false);
	const agents = agentCount();
	// 向导标志丢失（升级 / 前端存储变化 / 旧版本从未写过该标志）时，只要库里同时有默认模型设置和助理，
	// 就按「已完成」恢复。只有助理或只有模型都不算——避免把预置 / 遗留数据误当成已配置。
	const existing = agents > 0 && hasModelSetting();
	return {
		onboarded: (flag || existing) && agents > 0,
		modelSetupDone: flag || existing,
		modelReady: !!defaultModel(),
	};
}

/** 启动时把「实际已配置但向导标志丢失」的情况补回 onboarded=true（幂等，只读非敏感元数据）。 */
export function recoverOnboardingFlag(): boolean {
	if (getSetting("onboarded", false)) return false;
	if (agentCount() === 0 || !hasModelSetting()) return false;
	setSetting("onboarded", true);
	console.log("[onboarding] 检测到已有助理和默认模型配置，自动恢复 onboarded 标志，跳过首次向导");
	return true;
}
