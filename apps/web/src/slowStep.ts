/** 一步跑了超过 1 分钟：提示可能在等系统权限弹窗（例如 macOS 问能不能访问「文稿」），不然用户只看到一直转圈。 */
export function slowStepHint(startedAt: number | undefined, now: number): string | null {
	if (!startedAt || now - startedAt < 60_000) return null;
	return `这一步已经 ${Math.floor((now - startedAt) / 60_000)} 分钟了。如果一直没动静，可能在等系统的权限弹窗（比如问能不能访问「文稿」文件夹），看看屏幕上有没有；不想等了就说「停」。`;
}
