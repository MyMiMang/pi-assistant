/** 极简 i18n：以中文原文为 key，英文表缺失时回退中文。后续可替换为 i18next。 */
const en: Record<string, string> = {
	助理: "Assistants", 设置: "Settings", 新建助理: "New assistant", 搜索: "Search", 发送: "Send", 停止: "Stop",
	"给 {name} 发消息…": "Message {name}…", 概览: "Overview", 定时任务: "Routines", 文件: "Files", 电脑: "Computer",
	批准: "Approve", 拒绝: "Reject", 正在工作: "Working", 空闲: "Idle", 本机: "This computer", 远程: "Remote",
	模型: "Models", 远程访问与设备: "Remote & devices", 入口域名: "Entry domain", 外观: "Appearance", 关于: "About",
	后台任务: "Background tasks", 需要你的批准: "Needs your approval", 已批准: "Approved", 已拒绝: "Rejected", 已过期: "Expired",
	下载: "Download", 上传: "Upload", 保存: "Save", 取消: "Cancel", 下一步: "Next", 完成: "Done", 测试连接: "Test connection",
};
let lang: "zh" | "en" = (localStorage.getItem("huhao.lang") as "zh" | "en") || "zh";
export const getLang = () => lang;
export function setLang(l: "zh" | "en") {
	lang = l;
	localStorage.setItem("huhao.lang", l);
	location.reload();
}
export function t(s: string, vars?: Record<string, string | number>) {
	let out = lang === "en" ? (en[s] ?? s) : s;
	if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
	return out;
}
