/**
 * 页面大纲：在页面里给可交互元素打上 data-pia-ref 编号，输出一份紧凑的可访问性大纲。
 * 页面脚本在 page-scripts.js（纯 JS 文本注入，经 Playwright 公开的 frame.evaluate 执行）。
 */
import { readFileSync } from "node:fs";

export interface SnapshotResult {
	lines: string[];
	count: number;
	truncated: boolean;
}
export interface RiskInfo {
	risky: boolean;
	label: string;
	text: string;
	form?: string;
}
const SRC = readFileSync(new URL("./page-scripts.js", import.meta.url), "utf8");
/** frame.evaluate 用的函数（Playwright 按函数源码注入页面；字符串形式不会被调用，所以用 new Function 构造） */
export const SNAPSHOT_FN = new Function("arg", `${SRC}; return pageSnapshot(arg);`) as (arg: { prefix: string; maxItems: number }) => SnapshotResult;
export const RISK_FN = new Function("el", `${SRC}; return elementRisk(el);`) as (el: Element) => RiskInfo;
