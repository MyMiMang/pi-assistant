/**
 * 快速操作模型 · 基准测试的能力探测（纯逻辑，可注入）。
 *
 * 2026-10-22 起：隔离窗口来源不再由用户手填开关决定，而是由 `planFixtureWindow`（见 benchmark-window.ts）
 * 只凭 tools/list 推断「可准备」（preparable）。这里接收窗口计划，GET availability 只报可准备，**不开窗口**。
 *
 * 目的：把「目标电脑到底能不能为基准取得一个**独立受控 fixture 窗口**」从硬编码 `true` 改成
 * 基于「目标就绪 + 目标 MCP 暴露的工具清单 + 是否提供隔离测试窗口 / 宿主可达网关」的动态判定。
 * 拿不到证据一律 fail-closed（ok:false + 原因），**绝不写死 true，也绝不写死永远 blocked**。
 *
 * 本模块不认识具体 MCP / CUA，只吃 `tools` 名字列表与几个布尔事实，因此能在单测里完整验证。
 */

import type { FixtureWindowPlan } from "./benchmark-window.ts";

/** 基准运行需要的电脑工具（裸名，与 cua MCP 的 tools/list 一致）。 */
export const BENCHMARK_REQUIRED_TOOLS = ["list_windows", "get_window_state", "click", "scroll"] as const;

export interface BenchmarkCapabilityResult {
	ok: boolean;
	/** ok:false 时的中文原因（供 UI 显示，不隐藏） */
	reason?: string;
}

export interface BenchmarkCapabilityInput {
	/** 目标电脑是否就绪（hostpc 已开启且守护进程在跑 / 助理电脑正在运行）；动态探测，无副作用。 */
	ready: boolean;
	/** 目标 MCP 暴露的工具名清单；`null` = 读不到（连不上 / 未授权）→ fail-closed。 */
	tools: readonly string[] | null;
	/** 打开 fixture 页面用的工具名（默认 browser_navigate）。 */
	openTool: string;
	/**
	 * 是否有一个与用户日常环境隔离的测试窗口来源：
	 *  - 助理电脑（VM）天然隔离；但需要宿主可达的 fixture 网关，由 `gateway` 单独判定；
	 *  - 用户电脑需要「隔离的、驱动自有的浏览器 profile」，不能拿用户日常 Chrome 当 sandbox。
	 * 兼容字段：新调用方应改用 `window`（见 benchmark-window.ts）。
	 */
	sandbox?: boolean;
	/** sandbox:false 时的原因（例如「未提供隔离测试窗口」）。 */
	sandboxReason?: string;
	/** 隔离窗口计划（只凭 tools/list 推断，无副作用）。提供时优先于 `sandbox`。 */
	window?: FixtureWindowPlan;
	/**
	 * 目标电脑能否安全访问宿主 fixture 页面与回调（受控 loopback 映射 / 反向代理）。
	 * 仅助理电脑需要；`null` 表示未提供，按 fail-closed。
	 */
	gateway?: { ok: boolean; reason?: string } | null;
}

/**
 * 判定基准能否真实运行。顺序：就绪 → 隔离窗口 → 工具清单 → 宿主网关。
 * 每一步失败都给明确原因，绝不「大概是它」。
 */
export function evaluateBenchmarkCapability(input: BenchmarkCapabilityInput): BenchmarkCapabilityResult {
	if (!input.ready) return { ok: false, reason: "目标电脑未就绪（「操作这台电脑」未开启 / 助理电脑未运行）" };
	// 窗口计划（新路径）已包含「隔离来源 + 工具清单 + 网关」的判定；兼容旧 `sandbox` 字段。
	if (input.window) {
		if (!input.window.ok) return { ok: false, reason: input.window.reason ?? "当前没有与日常环境隔离的测试窗口来源（fail-closed）" };
		return { ok: true };
	}
	if (!input.sandbox) return { ok: false, reason: input.sandboxReason ?? "当前没有与日常环境隔离的测试窗口来源（fail-closed）" };
	if (input.tools === null) return { ok: false, reason: "读不到目标电脑的能力清单（连接失败或未授权），无法证明能取得独立受控窗口" };
	const have = new Set(input.tools);
	const required = [input.openTool, ...BENCHMARK_REQUIRED_TOOLS];
	const missing = required.filter((t) => !have.has(t));
	if (missing.length) return { ok: false, reason: `目标电脑缺少基准所需能力：${missing.join("、")}（无法保证取得独立受控窗口）` };
	if (input.gateway && !input.gateway.ok) return { ok: false, reason: input.gateway.reason ?? "助理电脑无法安全访问宿主 fixture 回调（未提供受控宿主网关）" };
	return { ok: true };
}
