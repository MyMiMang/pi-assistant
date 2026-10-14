export type Schedule = { kind: "daily" | "weekdays" | "weekly" | "interval" | "advanced"; time: string; weekday: string; every: string; unit: "minutes" | "hours" };
export const defaultSchedule = (): Schedule => ({ kind: "daily", time: "08:00", weekday: "1", every: "30", unit: "minutes" });
const weekdays = ["日", "一", "二", "三", "四", "五", "六"];

/** Only recognize losslessly editable schedules; keep all other expressions in advanced mode. */
export function parseSchedule(cron: string): Schedule {
	const s = defaultSchedule();
	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) return { ...s, kind: "advanced" };
	const [m, h, dom, month, dow] = parts;
	if (dom !== "*" || month !== "*") return { ...s, kind: "advanced" };
	if (/^\d+$/.test(m) && /^\d+$/.test(h) && +m < 60 && +h < 24 && (dow === "*" || dow === "1-5" || /^[0-6]$/.test(dow))) {
		return { ...s, kind: dow === "*" ? "daily" : dow === "1-5" ? "weekdays" : "weekly", time: `${h.padStart(2, "0")}:${m.padStart(2, "0")}`, weekday: dow === "*" || dow === "1-5" ? "1" : dow };
	}
	if (dow === "*") {
		if (m === "0" && h === "*") return { ...s, kind: "interval", every: "1", unit: "hours" };
		const minute = /^\*\/(\d+)$/.exec(m);
		if (h === "*" && minute && +minute[1] >= 5 && +minute[1] <= 60 && 60 % +minute[1] === 0) return { ...s, kind: "interval", every: minute[1], unit: "minutes" };
		const hour = /^\*\/(\d+)$/.exec(h);
		if (m === "0" && hour && +hour[1] >= 1 && +hour[1] <= 24 && 24 % +hour[1] === 0) return { ...s, kind: "interval", every: hour[1], unit: "hours" };
	}
	return { ...s, kind: "advanced" };
}

export function scheduleError(s: Schedule): string | null {
	if (s.kind === "advanced") return null;
	if (s.kind !== "interval") return /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time) && /^[0-6]$/.test(s.weekday) ? null : "请选择有效的时间和星期";
	const n = Number(s.every), cycle = s.unit === "minutes" ? 60 : 24, min = s.unit === "minutes" ? 5 : 1;
	if (!/^\d+$/.test(s.every) || n < min || n > cycle) return s.unit === "minutes" ? "分钟间隔须为 5–60 分钟" : "小时间隔须为 1–24 小时";
	if (cycle % n !== 0) return s.unit === "minutes" ? "请选择 5、6、10、12、15、20、30 或 60 分钟，保持每次间隔一致" : "请选择 1、2、3、4、6、8、12 或 24 小时，保持每次间隔一致";
	return null;
}

export function scheduleCron(s: Schedule): string | null {
	if (s.kind === "advanced" || scheduleError(s)) return null;
	if (s.kind === "interval") return s.unit === "minutes" ? `*/${Number(s.every)} * * * *` : `0 */${Number(s.every)} * * *`;
	const [h, m] = s.time.split(":").map(Number);
	return `${m} ${h} * * ${s.kind === "daily" ? "*" : s.kind === "weekdays" ? "1-5" : s.weekday}`;
}

export function scheduleLabel(cron: string): string {
	const s = parseSchedule(cron);
	if (s.kind === "advanced") return `高级计划：${cron}`;
	if (s.kind === "interval") return `每隔 ${s.every} ${s.unit === "minutes" ? "分钟" : "小时"}`;
	return `${s.kind === "daily" ? "每天" : s.kind === "weekdays" ? "工作日（周一至周五）" : `每周${weekdays[+s.weekday]}`} ${s.time}`;
}
