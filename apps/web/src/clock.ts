/** 消息时间的显示（纯函数，便于单测）：每条消息下方的时间、日期分隔条共用。 */
const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** 今天 →「{todayPrefix}HH:mm」，昨天 →「昨天 HH:mm」，今年更早 →「M月D日 HH:mm」，往年 →「YYYY年M月D日 HH:mm」 */
export function fmtClock(ts: number, todayPrefix = "", now = Date.now()): string {
	const d = new Date(ts);
	const today = new Date(now);
	const yesterday = new Date(now);
	yesterday.setDate(today.getDate() - 1);
	if (d.toDateString() === today.toDateString()) return `${todayPrefix}${hm(d)}`;
	if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm(d)}`;
	const md = `${d.getMonth() + 1}月${d.getDate()}日 ${hm(d)}`;
	return d.getFullYear() === today.getFullYear() ? md : `${d.getFullYear()}年${md}`;
}

/** 悬停看的完整时间：2026年11月15日 13:36:05 */
export const fmtFullTime = (ts: number): string => {
	const d = new Date(ts);
	return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm(d)}:${String(d.getSeconds()).padStart(2, "0")}`;
};
