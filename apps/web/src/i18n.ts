/** 极简 i18n：以中文原文为 key，英文表缺失时回退中文。后续可替换为 i18next。 */
const en: Record<string, string> = {
	助理: "Assistants", 设置: "Settings", 新建助理: "New assistant", 搜索: "Search", 发送: "Send", 停止: "Stop",
	"给 {name} 发消息…": "Message {name}…", 概览: "Overview", 更多: "More", 定时任务: "Routines", 文件: "Files", 电脑: "Computer",
	批准: "Approve", 拒绝: "Reject", 正在工作: "Working", 空闲: "Idle", 本机: "This computer", 远程: "Remote",
	模型: "Models", 远程访问与设备: "Remote & devices", 入口域名: "Entry domain", 外观: "Appearance", 关于: "About",
	后台任务: "Background tasks", 需要你的批准: "Needs your approval", 已批准: "Approved", 已拒绝: "Rejected", 已过期: "Expired",
	给助理安装电脑: "Install a computer for assistants", 助理电脑: "Assistant computer", 运行方式: "Runtime", 空闲自动关机: "Auto shutdown when idle", 镜像下载地址: "Image download source",
	已安装: "Installed", 未安装: "Not installed", 未下载: "Not downloaded", 下载中: "Downloading", 关机: "Shut down", 从不: "Never", 重试: "Retry", "{m} 分钟": "{m} min",
	"自带运行时（推荐）": "Built-in runtime (recommended)", "使用已安装的 Docker": "Use installed Docker", 启动中: "Starting", 运行中: "Running", 已关机: "Off",
	"删除虚拟机和镜像（登录状态会清掉）": "Delete VM and images (logins cleared)", "未安装，去设置安装": "Not installed — set up in Settings",
	"预计下载 ≈{d}，磁盘占用 ≈{disk}，运行时内存 3–4 GB。开启前什么都不会下载。": "Download ≈{d}, disk ≈{disk}, RAM 3–4 GB while running. Nothing is downloaded until enabled.",
	共用电脑: "Shared computer", "共用电脑（{n} 个助理）": "Shared computer ({n} assistants)", 单独的电脑: "Separate computer", 屏幕: "Screen", 主屏幕: "Main screen", 它在用: "in use",
	回主屏幕: "Back to main screen", 给它开自己的屏幕: "Give it its own screen", 使用单独的电脑: "Use a separate computer", 合并进共用电脑: "Merge into shared computer", "关掉共用电脑？": "Shut down the shared computer?",
	下载: "Download", 上传: "Upload", 保存: "Save", 取消: "Cancel", 下一步: "Next", 完成: "Done", 测试连接: "Test connection",
};
let lang: "zh" | "en" = (localStorage.getItem("pia.lang") as "zh" | "en") || "zh";
export const getLang = () => lang;
export function setLang(l: "zh" | "en") {
	lang = l;
	localStorage.setItem("pia.lang", l);
	location.reload();
}
export function t(s: string, vars?: Record<string, string | number>) {
	let out = lang === "en" ? (en[s] ?? s) : s;
	if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
	return out;
}
