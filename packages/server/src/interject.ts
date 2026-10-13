/**
 * 工作途中插话（像 Grok Bot 一样随时能发消息）。
 * - 普通消息：助理正在工作时，用 Pi 的 steer 在下一个工具边界送达（见 pi-adapter promptSession）。
 * - 停止指令：整条消息就是“停 / 停止 / 别做了 / stop …”时，立刻中止整轮（含正在跑的命令、电脑操作、等待中的审批）。
 * 只认“整条消息就是停止词”，避免“停止这个服务”之类的正常任务被误判。
 */
const STOP_WORDS = ["停", "停止", "停下", "停下来", "先停", "先停下", "别做了", "不要做了", "不用做了", "别弄了", "不做了", "取消", "算了", "中止", "终止", "stop", "/stop", "cancel", "abort"];
const norm = (t: string) =>
	t
		.trim()
		.toLowerCase()
		.replace(/^[\s@]*/, "")
		.replace(/[\s。.!！~～,，、…]+$/u, "")
		.replace(/^(请|快|先)?/, (m) => m)
		.replace(/(吧|啊|呀|一下)$/u, "");
export function isStopCommand(text: string): boolean {
	const t = norm(text);
	if (!t || t.length > 12) return false;
	return STOP_WORDS.includes(t) || STOP_WORDS.includes(t.replace(/^(请|快)/, ""));
}

/** 系统提示：怎么处理工作途中收到的新消息 */
export const INTERJECTION_RULE =
	"用户可以在你工作途中随时发新消息，标记为「（你工作时用户发来的新消息）」，会在你当前这一步工具调用结束后送达。读到后：先用一句很短的话回应（例如“收到，改成…”），再判断它是什么——补充或修正要求，就并进正在做的事继续做；换了方向，就放下原来的活按新要求做（必要时说明已做到哪一步）；让你停下或不要做了，就立刻停止调用工具，简短说明停在了哪里。不要因为插话就从头重做已经完成的部分，也不要忽略它等做完再说。";
