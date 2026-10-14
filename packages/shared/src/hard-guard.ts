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
 * 纯函数、无 Node 依赖：服务端、各扩展、测试都能直接用。启发式，宁严勿松（误报只是多问一次）。
 */

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
const SYSTEM_PROCS = /\b(launchd|kernel_task|WindowServer|loginwindow|SystemUIServer|Finder|Dock|coreaudiod|securityd|opendirectoryd|systemd|init|Xorg|gdm|sddm|explorer(\.exe)?|csrss(\.exe)?|winlogon(\.exe)?|lsass(\.exe)?|svchost(\.exe)?|dwm(\.exe)?|services\.exe|smss(\.exe)?|wininit(\.exe)?|sshd)\b/i;
const SANDBOX_RUNTIME = /\b(Xvfb|x11vnc|websockify|novnc|socat|cua-driver|tini|xfce4-session|xfwm4|xfce4-panel|xfdesktop|dbus-daemon|pia-desktop)\b/;
const SYSTEM_DIRS = /(^|[\s"'=:(])(\/(System|usr|bin|sbin|etc|boot|lib|lib32|lib64|Library|private|dev|proc|sys|opt\/homebrew|Applications\/Utilities)(\/|[\s"')]|$)|[A-Za-z]:\\+(Windows|Program Files( \(x86\))?|ProgramData)(\\|[\s"']|$)|%(SystemRoot|windir|ProgramFiles)%)/i;
const RC_FILES = /(\.(bash|zsh)rc|\.bash_profile|\.bash_login|\.zprofile|\.zshenv|\.zlogin|\.profile|config\.fish|Library\/LaunchAgents|Library\/LaunchDaemons|\.config\/autostart|\/etc\/(profile|bash|zsh|cron|systemd|init|rc\.)|\/etc\/environment|CurrentVersion\\+Run|Start Menu\\+Programs\\+Startup|\\Startup\\)/i;
const WRITE_VERB = /(>|\btee\b|\bsed\s+(-\w*\s+)*-i|\b(cp|mv|rm|rmdir|ln|install|truncate|chmod|chown|chflags|xattr|nano|vim?|emacs|code|unlink|shred|Remove-Item|Move-Item|Copy-Item|Set-Content|Add-Content|Out-File|New-Item|del|erase|rd|ren|icacls|takeown|attrib)\b)/i;
/** 无副作用的输出重定向（写 /dev/null、复制文件描述符），不算写入，避免把只读命令（ls … 2>/dev/null）当成修改文件 */
const NOOP_REDIRECT = /\d*\s*>>?\s*\/dev\/null\b|\d*\s*>&\s*\d+|\d*\s*>&-/gi;
const BROAD = /^(\/|\/\*|~|~\/|~\/\*|\$HOME\/?\*?|\$\{HOME\}\/?\*?|\/Users\/?\*?|\/home\/?\*?|\/Users\/[^/\s]+\/?\*?|\/home\/[^/\s]+\/?\*?|\*|\.\.\/?\*?|[A-Za-z]:\\?\*?|\$\{?\w+\}?\/?\*?)$/;

/** 把一条 shell 命令按 ; && || | 换行 拆成片段 */
function segments(cmd: string): string[] {
	return cmd
		.split(/;|&&|\|\||\||\n/)
		.map((s) => s.trim())
		.filter(Boolean);
}
const strip = (s: string) => s.replace(/^["']|["']$/g, "");

/** shell 命令是否命中硬性保护 */
export function guardShell(cmd: string, ctx: GuardContext): GuardHit | null {
	const c = String(cmd ?? "");
	if (!c.trim()) return null;
	// 整条命令级别的规则
	if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/.test(c) || /%0\s*\|\s*%0/.test(c) || /\bwhile\s+(true|:|\[\s*1\s*\])\s*;?\s*do\b[\s\S]*&\s*;?\s*done/.test(c) || /\bfork\s*\(\s*\)\s*while|\bstress(-ng)?\b/.test(c))
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
	// 去掉无副作用的输出重定向后的命令（只看写入类操作时用）
	const w = s.replace(NOOP_REDIRECT, " ");
	// 关机 / 重启 / 注销 / 休眠
	if (/^(sudo\s+)?(shutdown|reboot|halt|poweroff|logout)\b|\bsystemctl\s+(poweroff|reboot|halt|suspend|hibernate|kexec)\b|\bshutdown(\.exe)?\s+\/[srlhp]\b|\bloginctl\s+(terminate|kill)-|\bpmset\s+sleepnow\b|\bStop-Computer\b|\bRestart-Computer\b|osascript\b.*\b(shut down|restart|log out)\b|\binit\s+[06]\b|\btelinit\s+[06]\b|\bxfce4-session-logout\b|\bgnome-session-quit\b/i.test(s))
		return { rule: "power", label: "关机 / 重启 / 注销" };
	// 磁盘
	if (/\b(mkfs(\.\w+)?|mke2fs|wipefs|fdisk|sfdisk|gdisk|sgdisk|parted|diskpart|newfs_\w+)\b|\bdiskutil\s+(erase\w*|partition\w*|zeroDisk|randomDisk|secureErase|reformat|apfs\s+(delete\w*|erase\w*)|unmountDisk\s+force)\b|\bformat(\.com)?\s+[A-Za-z]:|\bdd\b[^\n]*\bof=\/dev\/|\b(Clear-Disk|Format-Volume|Initialize-Disk|Remove-Partition)\b|\bcipher\s+\/w\b/i.test(s))
		return { rule: "disk", label: "磁盘格式化 / 分区 / 抹掉" };
	// 资源耗尽
	if (/\bfallocate\s+(-\w+\s+)*-l\s*\d+[GT]\b|\bdd\b[^\n]*if=\/dev\/(zero|urandom)[^\n]*\bbs=\d+[GT]|\bdd\b[^\n]*if=\/dev\/(zero|urandom)(?![^\n]*\bcount=)/i.test(s))
		return { rule: "resource", label: "可能耗尽磁盘空间" };
	// 安全 / 网络 / 防火墙 / 用户账户
	if (/\b(networksetup|pfctl|ufw|iptables|ip6tables|nft|firewall-cmd|netsh|socketfilterfw|scutil\s+--set|csrutil|spctl\s+--(master-disable|global-disable|add)|sysadminctl|dscl\s+\S+\s+-(create|delete|passwd|append|change)|useradd|userdel|usermod|groupadd|groupdel|chpasswd|passwd|visudo|tccutil\s+reset|security\s+(delete|add|set|import|unlock)-?\w*|fdesetup|profiles\s+(remove|install)|net\s+(user|localgroup)|Set-MpPreference|Add-MpPreference|Set-NetFirewall\w*|New-NetFirewallRule|Disable-NetAdapter|New-LocalUser|Remove-LocalUser|Set-LocalUser|Add-LocalGroupMember|Set-ExecutionPolicy|bcdedit|nmcli\s+(con|connection|radio|networking)\s+(delete|down|off|modify))\b/i.test(s) || /\bdefaults\s+write\s+\S*(loginwindow|alf|com\.apple\.security|LaunchServices)/i.test(s) || /(^|\s)(sudo\s+)?(cp|mv|tee|sed\s+-i)[^\n]*\/etc\/(sudoers|hosts|passwd|shadow|group|resolv\.conf|ssh\/)/i.test(s))
		return { rule: "security", label: "修改安全 / 网络 / 防火墙 / 用户账户设置" };
	// 开机自启 / shell 启动脚本
	if (/\bcrontab\b(?!\s+-l\b)|\bschtasks(\.exe)?\s+\/(create|delete|change)\b|\breg(\.exe)?\s+(add|delete|import)\b|\bsystemctl\s+(--user\s+)?(enable|disable|mask|unmask|edit)\b|\blaunchctl\s+(load|unload|bootstrap|bootout|remove|disable|enable|submit|kickstart\s+-k)\b|\bloginitems\b|\bosascript\b[^\n]*login item/i.test(s))
		return { rule: "autostart", label: "修改开机自启 / 系统服务" };
	if (RC_FILES.test(s) && WRITE_VERB.test(w)) return { rule: "rc", label: "修改 shell 启动脚本 / 自启动项" };
	// Pi Assistant 自身与附属进程（结束、卸载、删除、改动）
	if (SELF_NAMES.test(s) && /\b(kill|pkill|killall|taskkill|launchctl|systemctl|sc(\.exe)?\s+(stop|delete|config)|Stop-Process|Stop-Service|rm|rmdir|mv|del|rd|Remove-Item|uninstall|brew\s+(uninstall|remove)|npm\s+(uninstall|rm)|docker\s+(rm|kill|stop|volume\s+rm|rmi|system\s+prune)|winget\s+uninstall|chmod|chown|truncate|sqlite3)\b|>/i.test(w))
		return { rule: "self", label: "结束 / 卸载 / 修改 Pi Assistant 本身或它的组件" };
	for (const p of ctx.protectedPaths ?? []) {
		if (p && s.includes(p) && WRITE_VERB.test(w)) return { rule: "self-data", label: "修改 Pi Assistant 的数据目录 / 安装目录" };
	}
	if (/\bdocker\s+(system\s+prune|volume\s+prune|rm\s+-f\s+\$\(docker)/i.test(s)) return { rule: "self", label: "批量删除 Docker 容器 / 卷（包括助理电脑）" };
	// 结束系统进程
	if (/\b(kill|pkill|killall|taskkill|Stop-Process|skill)\b/i.test(s)) {
		if (SYSTEM_PROCS.test(s.replace(/^\S+/, ""))) return { rule: "system-proc", label: "结束系统进程" };
		if (/\bkill\s+(-\S+\s+)*(-1|1)\b(?!\d)/.test(s)) return { rule: "system-proc", label: "结束所有进程 / init" };
		if (sandbox && SANDBOX_RUNTIME.test(s)) return { rule: "sandbox-runtime", label: "结束助理电脑的运行环境进程" };
	}
	// 系统目录：只看真正的写删操作；去掉目标不在系统目录的重定向（ls /usr/bin > /tmp/x 不算修改系统目录）
	const sw = w.replace(/\d*>>?\s*([^\s;&|<>]+)/g, (m, t: string) => (SYSTEM_DIRS.test(` ${t}`) ? m : " "));
	if (SYSTEM_DIRS.test(s) && WRITE_VERB.test(sw)) {
		// cp / install / Copy-Item 只有目标在系统目录才算（从系统目录复制出来没关系）
		const cp = /^(sudo\s+)?(cp|install|Copy-Item|ditto|rsync)\b(.*)$/i.exec(s);
		const other = WRITE_VERB.test(sw.replace(/^(sudo\s+)?(cp|install|Copy-Item|ditto|rsync)\b/i, ""));
		if (!cp || other) return { rule: "system-dir", label: "删除 / 修改系统目录" };
		const last = cp[3].trim().split(/\s+/).filter((a) => !a.startsWith("-")).at(-1) ?? "";
		if (SYSTEM_DIRS.test(` ${strip(last)}`)) return { rule: "system-dir", label: "写入系统目录" };
	}
	// 批量删除
	const rm = /^(sudo\s+)?(rm|Remove-Item|del|erase|rd|rmdir|unlink|shred)\b(.*)$/i.exec(s);
	if (rm) {
		const args = rm[3].trim().split(/\s+/).filter(Boolean);
		const flags = args.filter((a) => /^-|^\/[a-zA-Z]$/.test(a));
		const recursive = flags.some((f) => /^-[a-zA-Z]*[rR]|^--recursive|^-Recurse|^\/[sS]$/.test(f));
		const targets = args.filter((a) => !/^-|^\/[a-zA-Z]$/.test(a)).map(strip);
		if (recursive && targets.some((t) => BROAD.test(t))) return { rule: "mass-delete", label: "大范围删除（rm -rf 宽泛路径）" };
		if (targets.length > (ctx.massDeleteThreshold ?? 20)) return { rule: "mass-delete", label: `一次删除 ${targets.length} 个文件` };
		if (sandbox && targets.some((t) => /^\/home\/agent\/?$|^~\/?$|\.config\/pia-browser|\.cache\/cua-driver|\.local\/wechat/.test(t))) return { rule: "sandbox-runtime", label: "删除助理电脑的家目录 / 运行数据" };
	}
	if (/\bfind\b/.test(s) && /(-delete\b|-exec\s+(rm|shred)\b)/.test(s)) {
		const root = /\bfind\s+("?[^\s"]+"?)/.exec(s)?.[1];
		if (!root || BROAD.test(strip(root))) return { rule: "mass-delete", label: "大范围批量删除（find -delete）" };
	}
	if (/\bgit\s+clean\s+-\w*f\w*x/.test(s) && /\s(~|\/)\s*$/.test(s)) return { rule: "mass-delete", label: "大范围删除未跟踪文件" };
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
