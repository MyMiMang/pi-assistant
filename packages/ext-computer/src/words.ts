/** 敏感 / 危险动作的字样（中英文）：审批判断和目标模式守门共用一份 */

/** 发送 / 付款 / 删除类的字样（中英文） */
export const SENSITIVE_WORDS = /发送|发出|提交|付款|支付|转账|红包|购买|下单|结算|确认订单|删除|移除|清空|卸载|注销|退出登录|send|submit|pay|purchase|checkout|buy|transfer|delete|remove|erase|uninstall|empty trash/i;

/** 目标模式里危险按钮：点击 / 勾选前要确认目标里明确写到了（见 fast-executor-v2-impl.md §5.4） */
export const GOAL_GUARD_WORDS = new RegExp(`${SENSITIVE_WORDS.source}|取消|关闭|重置|退出|cancel|close|reset`, "i");

/** 元素名里命中危险字样、而目标里没写这个字样 → 不列入候选 */
export function guardedOut(name: string, goal: string): boolean {
	const g = goal.toLowerCase();
	return (name.match(new RegExp(GOAL_GUARD_WORDS.source, "gi")) ?? []).some((w) => !g.includes(w.toLowerCase()));
}
