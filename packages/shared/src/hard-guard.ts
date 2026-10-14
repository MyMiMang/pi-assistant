/**
 * 硬性保护清单（hard guard）：无论哪个权限档位（包括“完全权限”）、无论 Cua 以什么模式运行，
 * 命中这里的动作都必须由用户明确批准（不会被“本任务内都允许”或任何自动规则放行）。
 * 在我们自己的 tool_call 闸门里执行：shell（bash）、文件（write/edit）、电脑操作（Cua 输入/应用动作）。
 *
 * 覆盖：结束/卸载/修改 Pi Assistant 本身及其数据目录、LaunchAgent/服务、Cua/cloudflared/Hindsight 附属进程；
 * 删除/修改系统目录；磁盘格式化/分区/抹掉；关机/重启/注销；结束系统进程；修改安全/网络/防火墙/用户账户设置；
 * 批量删除（rm -rf 宽泛路径、大量文件）；fork 炸弹/资源耗尽；修改 shell 启动脚本 / 开机自启项。
 * 助理电脑（sandbox）另外保护它自己的运行环境（Xvfb、VNC、cua-driver 等）。
 *
 * 判断原则：只看「命令位置」和「真正的写入目标」，不看命令串里出现的词。
 * grep/echo/rg 的参数、引号里的 > |、PATH/--repo 里的产品名都不算执行。
 * 词法拆分在 ./shell-lex.ts。纯函数、无 Node 依赖：服务端、各扩展、测试都能直接用。
 */

import { baseName, commandOf, isAbsPath, isFlag, parseSegment, processHeredocs, segments, underPath, writeTargets } from "./shell-lex.ts";

export interface GuardContext {
	target: "host" | "sandbox";
	/** 受保护的路径（数据目录、应用安装目录等），按前缀匹配 */
	protectedPaths?: string[];
	/** 受保护路径里允许正常读写的子目录（例如助理工作区） */
	allowedPaths?: string[];
	/** 一条命令里删除的文件参数超过这个数就算批量删除 */
	massDeleteThreshold?: number;
}
export interface GuardHit {
	rule: string;
	label: string;
}

const SELF_NAMES = /pi[-_ ]?assistant|piassistant|com\.piassistant|pia-desk-|pia-home-|cua-?driver|cuadriver|com\.trycua|cloudflared|hindsight/i;
/** 只指 Pi Assistant 自身构件的强特征（不含裸产品名，避免仓库名 / 包 scope / PATH 里的 pi-assistant 误报） */
const SELF_STRONG = /com\.piassistant|pia-desk-|pia-home-|cua-?driver|cuadriver|com\.trycua|cloudflared|hindsight|pi[-_ ]?assistant\.app/i;
const SYSTEM_PROCS = /\b(launchd|kernel_task|WindowServer|loginwindow|SystemUIServer|Finder|Dock|coreaudiod|securityd|opendirectoryd|systemd|init|Xorg|gdm|sddm|explorer(\.exe)?|csrss(\.exe)?|winlogon(\.exe)?|lsass(\.exe)?|svchost(\.exe)?|dwm(\.exe)?|services\.exe|smss(\.exe)?|wininit(\.exe)?|sshd)\b/i;
const SANDBOX_RUNTIME = /\b(Xvfb|x11vnc|websockify|novnc|socat|cua-driver|tini|xfce4-session|xfwm4|xfce4-panel|xfdesktop|dbus-daemon|pia-desktop)\b/;
const SYSTEM_DIRS = /(^|[\s"'=:(])(\/(System|usr|bin|sbin|etc|boot|lib|lib32|lib64|Library|private|dev|proc|sys|opt\/homebrew|Applications\/Utilities)(\/|[\s"')]|$)|[A-Za-z]:\\+(Windows|Program Files( \(x86\))?|ProgramData)(\\|[\s"']|$)|%(SystemRoot|windir|ProgramFiles)%)/i;
const RC_FILES = /(\.(bash|zsh)rc|\.bash_profile|\.bash_login|\.zprofile|\.zshenv|\.zlogin|\.profile|config\.fish|Library\/LaunchAgents|Library\/LaunchDaemons|\.config\/autostart|\/etc\/(profile|bash|zsh|cron|systemd|init|rc\.)|\/etc\/environment|CurrentVersion\\+Run|Start Menu\\+Programs\\+Startup|\\Startup\\)/i;
const BROAD = /^(\/|\/\*|~|~\/|~\/\*|\$HOME\/?\*?|\$\{HOME\}\/?\*?|\/Users\/?\*?|\/home\/?\*?|\/Users\/[^/\s]+\/?\*?|\/home\/[^/\s]+\/?\*?|\*|\.\.\/?\*?|[A-Za-z]:\\?\*?|\$\{?\w+\}?\/?\*?)$/;
/** 按「命令位置」判断用的命令名集合（避免 grep "mkfs"、echo "shutdown" 这类纯文本参数误报） */
const POWER_CMDS = /^(shutdown(\.exe)?|reboot|halt|poweroff|logout|stop-computer|restart-computer|xfce4-session-logout|gnome-session-quit)$/i;
const DISK_CMDS = /^(mkfs(\.\w+)?|mke2fs|wipefs|fdisk|sfdisk|gdisk|sgdisk|parted|diskpart|newfs_\w+|clear-disk|format-volume|initialize-disk|remove-partition)$/i;
const SECURITY_CMDS = /^(networksetup|pfctl|ufw|iptables|ip6tables|nft|firewall-cmd|netsh|socketfilterfw|csrutil|sysadminctl|useradd|userdel|usermod|groupadd|groupdel|chpasswd|passwd|visudo|fdesetup|bcdedit|set-mppreference|add-mppreference|new-localuser|remove-localuser|set-localuser|add-localgroupmember|set-executionpolicy|set-netfirewall\w*|new-netfirewallrule|disable-netadapter)$/i;
const KILL_CMDS = /^(kill|pkill|killall|taskkill(\.exe)?|skill|stop-process)$/i;
const SENSITIVE_WRITE_CMDS = /^(cp|mv|tee|sed|install|dd|chmod|chown|rm|rmdir|truncate|shred|ln)$/i;
const RM_CMDS = /^(rm|remove-item|del|erase|rd|rmdir|unlink|shred)$/i;

/** shell 命令是否命中硬性保护 */
export function guardShell(cmd: string, ctx: GuardContext): GuardHit | null {
	// heredoc 正文按语义处理：字面数据丢弃、未引号的 $(...) 保留、喂给 shell 的正文当脚本
	const c = processHeredocs(String(cmd ?? ""));
	if (!c.trim()) return null;
	// 整条命令级别的规则
	if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/.test(c) || /%0\s*\|\s*%0/.test(c) || /\bwhile\s+(true|:|\[\s*1\s*\])\s*;?\s*do\b[\s\S]*&\s*;?\s*done/.test(c) || /\bfork\s*\(\s*\)\s*while/.test(c))
		return { rule: "fork-bomb", label: "可能耗尽系统资源（fork 炸弹 / 压力测试）" };
	for (const seg of segments(c)) {
		const hit = guardSegment(seg, ctx);
		if (hit) return hit;
	}
	return null;
}

function guardSegment(seg: string, ctx: GuardContext): GuardHit | null {
	const sandbox = ctx.target === "sandbox";
	// 允许的目录（助理工作区）里的路径不算受保护（工作区可能在数据目录里，路径里也可能带产品名）
	let s = seg;
	for (const a of ctx.allowedPaths ?? []) if (a) s = s.split(a).join("WORKSPACE");
	// 词法切分：命令名 / 参数 / 重定向目标分开，避免纯文本参数、引号里的 > 与 | 误报
	const toks = parseSegment(s);
	const { cmd, args } = commandOf(s);
	const rts = toks.filter((t) => t.kind === "redirect").map((t) => t.value);
	const wts = writeTargets(cmd, args, rts);
	// 关机 / 重启 / 注销 / 休眠（只认命令位置，不认参数文本）
	if (
		POWER_CMDS.test(cmd) ||
		(cmd === "systemctl" && args.some((a) => /^(poweroff|reboot|halt|suspend|hibernate|kexec)$/i.test(a))) ||
		(cmd === "loginctl" && args.some((a) => /^(terminate|kill)-/i.test(a))) ||
		(cmd === "pmset" && args.some((a) => /^sleepnow$/i.test(a))) ||
		((cmd === "init" || cmd === "telinit") && args.some((a) => /^[06]$/.test(a))) ||
		(cmd === "osascript" && /\b(shut down|restart|log out)\b/i.test(s))
	)
		return { rule: "power", label: "关机 / 重启 / 注销" };
	// 磁盘格式化 / 分区 / 抹掉
	if (
		DISK_CMDS.test(cmd) ||
		(cmd === "dd" && /\bof=\/dev\//i.test(s)) ||
		(cmd === "diskutil" && (/^(erase\w*|partition\w*|zeroDisk|randomDisk|secureErase|reformat|unmountDisk)$/i.test(args[0] ?? "") || (/^apfs$/i.test(args[0] ?? "") && /^(delete\w*|erase\w*)/i.test(args[1] ?? "")))) ||
		((cmd === "format" || cmd === "format.com" || cmd === "format.exe") && args.some((a) => /^[A-Za-z]:$/.test(a))) ||
		(cmd === "cipher" && args.some((a) => /^\/w$/i.test(a)))
	)
		return { rule: "disk", label: "磁盘格式化 / 分区 / 抹掉" };
	// 资源耗尽
	if (/^stress(-ng)?$/.test(cmd)) return { rule: "fork-bomb", label: "可能耗尽系统资源（压力测试）" };
	if ((cmd === "fallocate" && /-l\s*\d+[GT]\b/i.test(s)) || (cmd === "dd" && /\bif=\/dev\/(zero|urandom)\b/i.test(s) && (/\bbs=\d+[GT]\b/i.test(s) || !/\bcount=/i.test(s))))
		return { rule: "resource", label: "可能耗尽磁盘空间" };
	// 安全 / 网络 / 防火墙 / 用户账户（只认命令位置）
	if (
		SECURITY_CMDS.test(cmd) ||
		(cmd === "scutil" && args.some((a) => /^--set$/i.test(a))) ||
		(cmd === "spctl" && args.some((a) => /^--(master-disable|global-disable|add)$/i.test(a))) ||
		(cmd === "dscl" && args.some((a) => /^-(create|delete|passwd|append|change)$/i.test(a))) ||
		(cmd === "tccutil" && args.some((a) => /^reset$/i.test(a))) ||
		(cmd === "security" && args.some((a) => /^(delete|add|set|import|unlock)-?\w*/i.test(a))) ||
		(cmd === "profiles" && args.some((a) => /^(remove|install)$/i.test(a))) ||
		(cmd === "net" && /^(user|localgroup)$/i.test(args[0] ?? "")) ||
		(cmd === "defaults" && /^write$/i.test(args[0] ?? "") && args.some((a) => /(loginwindow|alf|com\.apple\.security|LaunchServices)/i.test(a))) ||
		(cmd === "nmcli" && /^(con|connection|radio|networking)$/i.test(args[0] ?? "") && args.some((a) => /^(delete|down|off|modify)$/i.test(a))) ||
		(SENSITIVE_WRITE_CMDS.test(cmd) && wts.some((t) => /\/etc\/(sudoers|hosts|passwd|shadow|group|resolv\.conf|ssh\/)/i.test(t)))
	)
		return { rule: "security", label: "修改安全 / 网络 / 防火墙 / 用户账户设置" };
	// 开机自启 / 系统服务（只认命令位置）
	if (
		(cmd === "crontab" && !/^\s*(sudo\s+)?crontab\s+-l\b/i.test(s)) ||
		((cmd === "schtasks" || cmd === "schtasks.exe") && args.some((a) => /^\/(create|delete|change)$/i.test(a))) ||
		((cmd === "reg" || cmd === "reg.exe") && args.some((a) => /^(add|delete|import)$/i.test(a))) ||
		(cmd === "systemctl" && args.some((a) => /^(enable|disable|mask|unmask|edit)$/i.test(a))) ||
		(cmd === "launchctl" && args.some((a) => /^(load|unload|bootstrap|bootout|remove|disable|enable|submit|kickstart)$/i.test(a))) ||
		cmd === "loginitems" ||
		(cmd === "osascript" && /\blogin item\b/i.test(s))
	)
		return { rule: "autostart", label: "修改开机自启 / 系统服务" };
	// shell 启动脚本 / 自启动项：只看真正的写入目标
	if (wts.some((t) => RC_FILES.test(t))) return { rule: "rc", label: "修改 shell 启动脚本 / 自启动项" };
	// Pi Assistant 自身与附属进程（结束、卸载、删除、改动）
	// 只在「真正被写/删/结束的目标」上匹配产品名：--repo pi-assistant、PATH、@pi-assistant 包名、相对路径 pi-assistant/xx 都不算
	const isSelfRef = (t: string) => SELF_STRONG.test(t) || ((isAbsPath(t) || t.startsWith("~")) && SELF_NAMES.test(t));
	const killSelf = KILL_CMDS.test(cmd) && args.some((a) => SELF_NAMES.test(a));
	const pkgSelf = /^(brew|npm|pnpm|yarn|winget|pip\d?|pip3)$/i.test(cmd) && args.some((a) => /^(uninstall|remove|rm)$/i.test(a)) && args.some((a) => SELF_NAMES.test(a));
	const dockerSelf = cmd === "docker" && /\b(rm|kill|stop|rmi|system\s+prune|volume\s+rm)\b/i.test(s) && SELF_STRONG.test(s);
	const scSelf = (cmd === "sc" || cmd === "sc.exe") && /\b(stop|delete|config)\b/i.test(s) && SELF_NAMES.test(s);
	if (
		rts.some(isSelfRef) ||
		wts.some(isSelfRef) ||
		(/^(launchctl|systemctl|sqlite3)$/i.test(cmd) && args.some(isSelfRef)) ||
		killSelf || pkgSelf || dockerSelf || scSelf
	)
		return { rule: "self", label: "结束 / 卸载 / 修改 Pi Assistant 本身或它的组件" };
	// 数据目录：只看真正的写入目标（重定向目标 / 写入命令的路径参数），cp 的源、只读命令的文件参数不算
	for (const p of ctx.protectedPaths ?? []) {
		if (p && wts.some((t) => underPath(p, t))) return { rule: "self-data", label: "修改 Pi Assistant 的数据目录 / 安装目录" };
	}
	if (cmd === "docker" && /\b(system\s+prune|volume\s+prune)\b/i.test(s)) return { rule: "self", label: "批量删除 Docker 容器 / 卷（包括助理电脑）" };
	// 结束系统进程（只看目标参数）
	if (KILL_CMDS.test(cmd)) {
		if (args.some((a) => SYSTEM_PROCS.test(a))) return { rule: "system-proc", label: "结束系统进程" };
		if (/\bkill\s+(-\S+\s+)*(-1|1)\b(?!\d)/.test(s)) return { rule: "system-proc", label: "结束所有进程 / init" };
		if (sandbox && args.some((a) => SANDBOX_RUNTIME.test(a))) return { rule: "sandbox-runtime", label: "结束助理电脑的运行环境进程" };
	}
	// 系统目录：只看真正的写入目标
	if (wts.some((t) => SYSTEM_DIRS.test(` ${t}`))) return { rule: "system-dir", label: "删除 / 修改系统目录" };
	// 批量删除
	if (RM_CMDS.test(cmd)) {
		const flags = args.filter(isFlag);
		const recursive = flags.some((f) => /^-[a-zA-Z]*[rR]|^--recursive|^-Recurse|^\/[sS]$/.test(f));
		const targets = args.filter((a) => !isFlag(a));
		if (recursive && targets.some((t) => BROAD.test(t))) return { rule: "mass-delete", label: "大范围删除（rm -rf 宽泛路径）" };
		if (targets.length > (ctx.massDeleteThreshold ?? 20)) return { rule: "mass-delete", label: `一次删除 ${targets.length} 个文件` };
		if (sandbox && targets.some((t) => /^\/home\/agent\/?$|^~\/?$|\.config\/pia-browser|\.cache\/cua-driver|\.local\/wechat/.test(t))) return { rule: "sandbox-runtime", label: "删除助理电脑的家目录 / 运行数据" };
	}
	if (cmd === "find" && /(-delete\b|-exec\s+(rm|shred)\b)/.test(s)) {
		const root = args.find((a) => !isFlag(a));
		if (!root || BROAD.test(root)) return { rule: "mass-delete", label: "大范围批量删除（find -delete）" };
	}
	if (cmd === "git" && /\bclean\s+-\w*f\w*x/.test(s) && /\s(~|\/)\s*$/.test(s)) return { rule: "mass-delete", label: "大范围删除未跟踪文件" };
	return null;
}

/** 文件工具（write / edit）要写的路径是否受保护 */
export function guardPath(path: string, ctx: GuardContext): GuardHit | null {
	const p = String(path ?? "");
	if (!p) return null;
	if (RC_FILES.test(p)) return { rule: "rc", label: "修改 shell 启动脚本 / 自启动项" };
	const under = (base: string) => p === base || p.startsWith(base.endsWith("/") || base.endsWith("\\") ? base : `${base}/`) || p.startsWith(`${base}\\`);
	const allowed = (ctx.allowedPaths ?? []).some((a) => a && under(a));
	if (!allowed) for (const pp of ctx.protectedPaths ?? []) if (pp && (p === pp || p.startsWith(pp.endsWith("/") || pp.endsWith("\\") ? pp : `${pp}/`) || p.startsWith(`${pp}\\`))) return { rule: "self-data", label: "修改 Pi Assistant 的数据目录 / 安装目录" };
	if (SYSTEM_DIRS.test(` ${p}`)) return { rule: "system-dir", label: "修改系统目录里的文件" };
	if (ctx.target === "sandbox" && /^\/home\/agent\/\.(config\/pia-browser|cache\/cua-driver)/.test(p)) return { rule: "sandbox-runtime", label: "修改助理电脑的运行数据" };
	return null;
}

const SECURITY_APPS = /(System Settings|System Preferences|系统设置|系统偏好设置|com\.apple\.(systempreferences|Settings|DiskUtility|keychainaccess|ActivityMonitor)|Disk Utility|磁盘工具|Keychain Access|钥匙串访问|Activity Monitor|活动监视器|Boot Camp|Migration Assistant|迁移助理|regedit(\.exe)?|control(\.exe)?$|Control Panel|控制面板|SystemSettings(\.exe)?|ms-settings|taskmgr(\.exe)?|Task Manager|任务管理器|diskmgmt|mmc(\.exe)?|gpedit|secpol|WindowsSecurity|Windows Security|Windows 安全中心|compmgmt|services\.msc|xfce4-settings-manager|gnome-control-center|gparted)/i;
const DANGER_LABELS = /关机|重新启动|重启|注销|退出登录|锁定并注销|抹掉|格式化|分区|卸载|强制退出|Shut ?Down|Restart|Log ?Out|Sign out|Erase|Partition|Format|Uninstall|Force Quit|Move to Trash.*Pi Assistant|Quit Pi Assistant|退出 Pi Assistant/i;
const HOTKEY_GUARD: string[][] = [
	["cmd", "option", "esc"],
	["cmd", "alt", "esc"],
	["cmd", "shift", "q"],
	["ctrl", "cmd", "power"],
	["ctrl", "option", "cmd", "power"],
	["ctrl", "cmd", "eject"],
	["ctrl", "alt", "delete"],
	["ctrl", "alt", "del"],
	["ctrl", "shift", "esc"],
	["ctrl", "alt", "backspace"],
];
const norm = (k: string) => k.toLowerCase().replace(/^(command|meta|super|win)$/, "cmd").replace(/^(alt|opt)$/, "option").replace(/^control$/, "ctrl").replace(/^escape$/, "esc");

/**
 * 电脑操作（Cua 工具）是否命中硬性保护。recent = 最近几次观察工具的输出（按元素编号找元素名字）。
 */
export function guardComputer(tool: string, input: Record<string, unknown>, ctx: GuardContext, recent: string[] = []): GuardHit | null {
	const appRef = [input.name, input.bundle_id, input.launch_path, input.app, input.title, input.executable, input.process].filter(Boolean).join(" ");
	if (tool === "kill_app") {
		if (SELF_NAMES.test(appRef)) return { rule: "self", label: "结束 Pi Assistant 或它的组件" };
		if (SYSTEM_PROCS.test(appRef)) return { rule: "system-proc", label: "结束系统进程" };
		if (ctx.target === "sandbox" && SANDBOX_RUNTIME.test(appRef)) return { rule: "sandbox-runtime", label: "结束助理电脑的运行环境进程" };
	}
	if (tool === "launch_app" || tool === "bring_to_front") {
		if (SECURITY_APPS.test(appRef)) return { rule: "security-app", label: "打开系统设置 / 磁盘工具 / 钥匙串等系统管理应用" };
		if (/uninstall|卸载/i.test(appRef)) return { rule: "self", label: "打开卸载程序" };
	}
	if (tool === "type_text" || tool === "set_value") {
		const hit = guardShell(String(input.text ?? input.value ?? ""), ctx);
		if (hit) return { rule: hit.rule, label: `输入的内容是危险命令：${hit.label}` };
	}
	if (tool === "press_key" || tool === "hotkey") {
		const keys = (Array.isArray(input.keys) ? input.keys : String(input.keys ?? input.key ?? "").split(/[+\s]+/)).map((k) => norm(String(k)));
		if (keys.length && HOTKEY_GUARD.some((combo) => combo.every((k) => keys.includes(k)) && keys.length === combo.length)) return { rule: "power", label: "强制退出 / 注销 / 关机快捷键" };
		if (keys.includes("power")) return { rule: "power", label: "电源键" };
	}
	if (tool === "invoke_menu") {
		const m = JSON.stringify(input.path ?? input.menu ?? input);
		if (DANGER_LABELS.test(m)) return { rule: "power", label: "危险菜单项（关机 / 注销 / 抹掉 / 卸载 / 强制退出）" };
	}
	if (/^(click|double_click|right_click)$/.test(tool)) {
		const label = [input.label, input.name, input.title, input.description].filter(Boolean).join(" ");
		if (label && DANGER_LABELS.test(label)) return { rule: "power", label: `点击危险按钮「${label}」` };
		const token = String(input.element_token ?? input.element ?? input.element_index ?? "");
		if (token)
			for (const txt of recent) {
				const line = txt.split("\n").find((l) => l.includes(token));
				if (line) {
					if (DANGER_LABELS.test(line)) return { rule: "power", label: `点击危险按钮：${line.trim().slice(0, 80)}` };
					break;
				}
			}
	}
	return null;
}
