/**
 * 快速操作模型 · 真实操控基准测试 —— 受限权限桥（纯逻辑，可注入）。
 *
 * 背景（2026-10-22 用户要求）：基准测试经 HTTP 跑，**没有 Pi 的 tool_call ctx**，所以不能借「没有 ctx」绕过
 * ext-computer 的 guard / 档位 / 一键暂停。这里的桥不把目标当成 always-allow：
 *  - 目标已暂停（hostpc 一键暂停 / 助理电脑暂停）→ 拒绝一切（含读取，对齐「撤销全部会话」语义）；
 *  - 用户档位是「只看」（observe）→ 只允许读取，输入动作一律拒绝，**且不弹多余审批**：基准是产品功能，
 *    不是模型工具调用，不需要再走「本任务内都允许」；不允许就直接明确 blocked；
 *  - 其余档位（限定 / 信任 / 完全权限）→ 基准的固定、有界、synthetic 动作在用户点「开始实际操作测试」时被视为已授权，
 *    但仍受暂停 / 档位 / 凭据 deny 等硬规则约束。
 */

/** 只读工具判定：与 ext-computer 的语义一致（观察 / 列表 / 检查），这些在「只看」档位也允许。 */
const READ_ONLY = /^(get_|list_|health_report$|check_permissions$|verify_state$|zoom$|screenshot$|browser_dialog$|start_session$|end_session$)/;

export const isBenchmarkReadOnly = (tool: string): boolean => READ_ONLY.test(tool.replace(/^mcp__[a-z0-9_-]+__/, ""));

export interface BenchmarkGuardInput {
	prefix: "hostpc" | "computer";
	/** 裸工具名。 */
	tool: string;
	/** 目标是否已暂停（hostpc 一键暂停 / 助理电脑暂停）。 */
	paused: boolean;
	/** hostpc 档位（observe/bounded/trusted/full）；computer 不传。 */
	tier?: "observe" | "bounded" | "trusted" | "full";
}

export interface BenchmarkGuardResult {
	ok: boolean;
	reason?: string;
}

/** 判定一个基准动作能不能派发。fail-closed：拿不准就拒绝并说明原因。 */
export function benchmarkToolGuard(input: BenchmarkGuardInput): BenchmarkGuardResult {
	const tool = input.tool.replace(/^mcp__[a-z0-9_-]+__/, "");
	if (input.paused) return { ok: false, reason: "电脑已暂停：基准动作一律拒绝（先恢复再跑测试）。" };
	if (input.prefix === "hostpc" && input.tier === "observe" && !isBenchmarkReadOnly(tool)) {
		return { ok: false, reason: "当前是「只看」档位：不能执行输入动作，真实操控基准需要「限定」及以上。可以在设置 › 电脑里调整档位。" };
	}
	return { ok: true };
}
