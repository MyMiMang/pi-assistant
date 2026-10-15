/**
 * @pi-assistant/ext-computer —— 让助理操作“它自己的电脑”（或经用户允许操作本机）。
 *
 * 集成方式只用公开接口：`pi.registerMcpServer("computer", { command: <cua-driver mcp> })`。
 * cua-driver 本体是 MIT；会拉取非 MIT 组件的工具（install_extension → cua-perception/AGPL、
 * parse_visual_regions 等）一律隐藏。
 *
 * 目标：
 *  - sandbox（默认）：助理电脑容器里的 Linux 桌面，它自己的电脑：默认完全权限（Cua unrestricted），不逐个审批；
 *  - host（默认关闭）：用户本机，按助理分档：只看 / 限定（默认）/ 信任 / 完全权限。
 * 审批策略：host.approvals() = "observe"（只允许观察）| "all" | "sensitive"（发送/付款/删除/提交才问）| "none"。
 * 硬性保护：命中 @pi-assistant/shared 的 guardComputer 的动作在“只看 / 限定 / 信任”档位必须明确批准（不能“本任务内都允许”）；
 * “完全权限”档位应用层不再弹审批（包括受保护动作），只有凭据文件、暂停 / 降权、系统权限弹窗和网站验证码仍然拦得住。
 * 一键暂停：host.isPaused() 为真时，所有电脑工具立即被拒绝（任何模式都生效）。
 * 操作记录：每个电脑动作（含被拒绝/暂停拦下的）都交给 host.log() 记录，供回看。
 */
import { isAbsolute, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { guardComputer, type GuardContext, type GuardHit } from "@pi-assistant/shared";

export const MCP_SERVER = "computer";
export const MCP_PREFIX = "mcp__computer__";
/** 本机（用户自己的电脑）用另一个 MCP 服务名，工具名不会和助理电脑的混在一起 */
export const HOST_MCP_SERVER = "hostpc";
export const HOST_MCP_PREFIX = "mcp__hostpc__";

/** 不暴露给模型的 cua-driver 工具：许可证风险、自我更新、改配置、重放、脚本。 */
export const HIDDEN_TOOLS = [
	"install_extension",
	"install_ffmpeg",
	"parse_visual_regions",
	"check_for_update",
	"set_config",
	"replay_trajectory",
	"escalate_session",
	"get_session_state",
	"page",
	// 0.35 起 driver 默认提供 run_script（沙箱 JavaScript，一次调用里跑循环/分支）。它的权限与直接调用相同，
	// 但我们的 tool_call 闸门看不到脚本内部要做什么，无法逐层套 guard / 敏感动作 / 文件限制，所以先不提供；
	// 另外在 MCP 服务 env 里设 CUA_DRIVER_DISABLE_RUN_SCRIPT=1，让 driver 自己也不列入 tools/list（双保险）。
	"run_script",
	"run_actions",
];
/** cua 的 CDP 浏览器工具（DESIGN §14.8）。助理电脑上浏览器走 ext-browser（Playwright），这些隐藏，避免两套同名能力 */
export const CUA_BROWSER_TOOLS = ["get_browser_state", "browser_prepare", "browser_navigate", "browser_click", "browser_type", "browser_pointer", "browser_download", "browser_set_input_files", "browser_dialog"];
/** 本机（hostpc）浏览器操作指引：注入系统提示。fileAccess = 完全权限（文件路径可用用户主机上的绝对路径） */
export const hostBrowserPrompt = (fileAccess: boolean) => `<user-computer-browser>
在用户自己的电脑上操作网页（Chrome / Edge）时，按这个顺序用 hostpc 的 CDP 浏览器工具，不要用截图 + 快捷键 + type_text：
1. list_windows 找到浏览器的 pid 和 window_id。
2. get_browser_state {pid, window_id, session} 绑定窗口。
3. 只有返回 browser_requires_setup 或 browser_consent_required 时，才调用 browser_prepare {pid, window_id, session, strategy:{kind:"existing_profile"}}（保留登录状态、不重启浏览器；macOS 上 Chrome 可能自己弹“允许远程调试”并来到前台）。之后重新 list_windows + get_browser_state 绑定。
4. 绑定结果必须是 binding_quality=exact 且 mutation_allowed=true 才能操作；否则只读，不要换个窗口硬来。
5. get_browser_state {target_id, tab_id, session, snapshot_format:"semantic_v2"} 读页面，拿 refs（p<快照>:<序号>）。
6. browser_navigate 打开网址；browser_click {ref}（macOS / Linux 返回 browser_input_trust_unavailable 时改用 input_route:"dom_event"）；browser_type {ref, text, replace}；browser_pointer 滚动 / 悬停。
7. 每次操作后重新 get_browser_state 读状态，绝不复用旧 ref（导航、新快照都会让旧 ref 失效）。要看结果画面时加 include_screenshot:true，用眼睛核对结果后再交付给用户。
8. 整个任务用同一个 session 标签（如 "web"）。不要用 cmd+t / cmd+l / ctrl+l 等地址栏快捷键当浏览器接口；只有标签栏、权限弹窗、原生文件选择框，或 CDP 工具不可用（Safari / Firefox、用户拒绝）时，才退回 get_window_state + click / hotkey。
9. 上传用 browser_set_input_files、下载用 browser_download，路径${fileAccess ? "可以是用户电脑上的绝对路径（你在这个助理上是完全权限，工作区只是默认目录）" : "只能在你的工作区里"}。
</user-computer-browser>`;
/** 本机桌面应用的操作方式（按 cua 0.35 官方 SKILL / WORKFLOW），注入系统提示 */
export const hostDesktopPrompt = (p: Approvals) => `<user-computer-desktop>
你可以像人一样操作用户的电脑${p === "all" ? "（“限定”档位：只能操作用户勾选的应用，每个动作都要用户批准）" : p === "none" ? "（用户给了完全权限：所有应用都能操作，应用层不再弹审批——包括关机、强制退出、系统设置这类受保护操作也会直接执行；只有凭据文件、用户暂停或调低档位、系统权限弹窗和网站验证码仍拦得住）" : "（“信任”档位：所有应用都能操作；发送、付款、删除、提交类动作会先问用户）"}。按官方流程：
1. 找目标：list_apps / list_windows 找到应用的 pid 和 window_id（不要用记住的旧 pid，也不要随手拿第一个窗口）；没开就 launch_app，之后有限次地 list_windows 等窗口出现，不要反复启动。
2. 先看再动：get_window_state {pid, window_id, tree_format:"elements"}，用 structuredContent.elements 里的 element_token（每次快照都会换新，不要自己编、不要复用旧的）。driver 0.35 起默认只回精简的 tree_markdown（没有 elements），要 token 就传 tree_format:"elements"（或 full_output:true）；重复读同一个窗口用 since:"latest" 只取变化。
3. 动作：click / double_click / right_click / type_text / set_value / press_key / hotkey / scroll / drag，带上精确的 {pid, window_id} 和最新的 element_token；控件够不到时才用同一次截图上的 x,y 像素坐标。菜单用 invoke_menu，调整窗口大小位置用 set_window_frame。连续几步已经想好的动作（填表 → 点按钮）可以用 run_steps {steps:[{tool,args}], observe:{}} 一次做完并顺带观察（最多 64 步，遇错即停、不自动回滚）；批量里每一步都会按你的权限档位单独检查。脚本工具 run_script 已关闭，不要用它。
4. 默认后台送达（不抢用户的前台、不动用户的鼠标）。只有返回 background_unavailable 或动作明显没生效时，才对这一个动作用 delivery_mode:"foreground"（会把窗口提到前台，用户能看见）。
${p === "all" ? "" : '5. 窗口截图拿不到、或必须操作整个桌面时，用 get_desktop_state 看全屏，再用 target:{kind:"desktop",display_id:"primary"} 操作，操作后再 get_desktop_state 核对。\n'}6. 每个动作后都要重新观察并核对结果（verify_state 或新的 get_window_state / 截图）。"成功"返回不等于任务完成；effect 为 unverifiable / suspected_noop 时先看清楚再决定，不要盲目重复。
7. 系统权限弹窗（辅助功能、屏幕录制、钥匙串等）由用户自己点，不要替用户点，也不要改安全设置。
8. 整个任务用同一个 session 标签；结束后 end_session。网页内容优先用 CDP 浏览器工具（见 user-computer-browser）。
</user-computer-desktop>`;

/** “限定”档位：没有 CDP 浏览器工具时的说明 */
export const HOST_BROWSER_BOUNDED_NOTE = `<user-computer-browser>
你对用户电脑的权限是“限定”：不能直接连接用户的 Chrome 做网页任务（只能按应用清单逐个动作操作）。网页任务优先用你自己的浏览器（助理电脑）；如果必须用用户的 Chrome（要他的登录状态），告诉用户需要在 设置 › 操作这台电脑 里把你的档位调到“信任”或以上。
</user-computer-browser>`;
const READ_ONLY = /^(get_|list_|zoom$|check_permissions$|health_report$|verify_state$|screenshot$)/;
/** 会改变电脑状态的 Cua 工具（“只看”档位隐藏） */
export const INPUT_TOOLS = ["click", "double_click", "right_click", "type_text", "set_value", "press_key", "hotkey", "scroll", "drag", "move_cursor", "invoke_menu", "launch_app", "kill_app", "bring_to_front", "browser_prepare", "browser_click", "browser_type", "browser_navigate", "browser_pointer", "browser_download", "browser_set_input_files", "browser_dialog", "clipboard_write", "set_window_frame", "start_recording", "stop_recording", "set_agent_cursor_enabled", "set_agent_cursor_motion", "set_agent_cursor_theme", "run_steps"];
/** 只读判定：observation 工具，以及 0.35 批量动作里“读窗口 / 纯检查”不算改状态 */
const isObserveTool = (t: string) => READ_ONLY.test(t) || t === "start_session" || t === "end_session" || t === STEP_CHECK;
/** 批量里“只有检查、没有动作”的步骤（只读） */
export const STEP_CHECK = "__check__";
/** 认不出的批量步骤：不能证明安全，整批拦下 */
export const STEP_UNKNOWN = "__unknown__";
/** 批量步骤里允许当作“动作”的工具名（含批量自身，用于识别简写 `{click:{…}}`） */
const BATCH_TOOLS = new Set([...INPUT_TOOLS, "run_steps", "run_script", "run_actions"]);
/** 纯检查步骤允许的字段（0.35 run_steps 的 check） */
const CHECK_KEYS = new Set(["role", "name", "text", "gone", "value", "value_contains", "enabled", "selected", "app", "window", "timeout_ms"]);
/**
 * 0.35 起 cua-driver 有批量动作 `run_steps({steps:[…],…})`：一次调用里顺序跑多步。
 * 我们的 tool_call 闸门只看得到外层工具名，看不到里面的步骤，嵌套的动作会绕过 guard / 敏感动作 / 文件限制，
 * 所以先展开成每一步的 (tool, args)，再逐层过同一套检查。步骤支持两种写法：`{tool, args}` 和简写 `{click:{…}}`；
 * 纯检查步骤（只有 role/name/text…）标成 STEP_CHECK（只读）；认不出的步骤标成 STEP_UNKNOWN，由调用方整批拦下。
 * 嵌套的批量（driver 不允许，但以防万一）也递归展开。
 */
export function expandComputerSteps(tool: string, input: Record<string, unknown>): { tool: string; input: Record<string, unknown> }[] {
	if (tool !== "run_steps" && tool !== "run_actions") return [{ tool, input }];
	const out: { tool: string; input: Record<string, unknown> }[] = [];
	const steps = Array.isArray(input.steps) ? input.steps : [];
	for (const raw of steps) {
		const s = (raw ?? {}) as Record<string, unknown>;
		let name = String(s.tool ?? "");
		let args = (s.args ?? {}) as Record<string, unknown>;
		if (!name) {
			const keys = Object.keys(s);
			const toolKeys = keys.filter((k) => BATCH_TOOLS.has(k));
			if (toolKeys.length === 1) {
				name = toolKeys[0];
				args = (s[name] ?? {}) as Record<string, unknown>;
			} else if (!toolKeys.length && keys.length > 0 && keys.every((k) => CHECK_KEYS.has(k))) {
				out.push({ tool: STEP_CHECK, input: s });
				continue;
			} else {
				out.push({ tool: STEP_UNKNOWN, input: s });
				continue;
			}
		}
		out.push(...expandComputerSteps(name, args));
	}
	return out;
}

export interface ComputerHost {
	target: "sandbox" | "host";
	mcp: { command: string; args: string[]; env?: Record<string, string> };
	isPaused(): boolean;
	/** sandbox 目标：整屏截图（host 目标不提供整屏截图，只能看清单里允许的窗口） */
	screenshot?(): Promise<Buffer>;
	/** 请用户接管（扫码 / 验证码）；推送到手机，返回用户的结果说明。 */
	handoff?(reason: string, screenshot: Buffer): Promise<string>;
	/** host 目标下的输入动作审批；allowTask = 卡片上提供“本任务内都允许” */
	request(req: { toolName: string; input: Record<string, unknown>; summary: string; risk: "medium" | "high"; allowTask?: boolean }): Promise<{ approved: boolean; note?: string; scope?: "task" }>;
	/** host 目标：用户可读的应用名（用于审批卡片） */
	describe?(tool: string, input: Record<string, unknown>): string;
	/** 审批策略（每次调用时读取，设置改了立即生效）。默认：host = all，sandbox = none */
	approvals?(): Approvals;
	/** 操作记录（始终记录） */
	log?(e: ActionLogEntry): void;
	/** 读自己的操作记录（复盘用，文字版，最新在前）；all = 包括同一台电脑上其他助理的 */
	history?(o: { limit?: number; all?: boolean }): string;
	/** 硬性保护上下文 */
	guard?: GuardContext;
	/**
	 * sandbox 目标：每个会改变屏幕的动作执行前调用（例如主屏幕正被别的助理使用时，给这个助理开一块自己的屏幕）。
	 * 返回字符串 = 拦下这次动作并把说明告诉模型；null = 照常执行。
	 */
	before?(tool: string, input: Record<string, unknown>): Promise<string | null>;
	/** host 目标：是否提供 cua 的 CDP 浏览器工具（“限定”档位不提供，见 HOST_BROWSER_BOUNDED_NOTE） */
	browserTools?: boolean;
	/** 允许浏览器上传/下载的目录（这个助理的工作区）；不设则 browser_download / browser_set_input_files 一律拒绝。完全权限下允许用户主机上的绝对路径 */
	workspace?: string;
	/** 完全权限：文件工具 / 浏览器上传下载可用用户主机路径。每次调用求值 */
	hostFileAccess?: () => boolean;
	/** sandbox 目标：屏幕 / 电脑管理（computer_screen 工具） */
	screens?: ScreenHost;
}

/** 同一台助理电脑里的多块屏幕（DESIGN §15.4） */
export interface ScreenHost {
	/** 列出这台电脑的屏幕、谁在用、你在哪块 */
	list(): Promise<string>;
	/** 给自己开一块屏幕（同一台电脑、同一个家目录和登录状态），之后的电脑操作都在这块屏幕上 */
	own(): Promise<string>;
	/** 回到主屏幕（关掉自己的屏幕，上面的窗口会关掉） */
	main(): Promise<string>;
	/** 开 / 关“单独的电脑”（自己的家目录和登录状态，和其他助理完全分开）；从下一条消息开始生效 */
	separate?(on: boolean, reason: string): Promise<string>;
}
export type Approvals = "observe" | "all" | "sensitive" | "none";
export interface ActionLogEntry {
	callId: string;
	target: "sandbox" | "host";
	tool: string;
	input: Record<string, unknown>;
	summary: string;
	phase: "start" | "blocked" | "done" | "error";
	detail?: string;
	approval?: "approved" | "task" | "auto" | "guarded";
}

/** 发送 / 付款 / 删除类的字样（中英文） */
export const SENSITIVE_WORDS = /发送|发出|提交|付款|支付|转账|红包|购买|下单|结算|确认订单|删除|移除|清空|卸载|注销|退出登录|send|submit|pay|purchase|checkout|buy|transfer|delete|remove|erase|uninstall|empty trash/i;
const SENSITIVE_KEYS = /^(enter|return|kp_enter|delete|del|backspace)$/i;
/**
 * 是否“敏感动作”（sensitive 审批策略下仍需批准）：结束应用；回车/删除键（常用于发送、删除）；
 * 点击的元素名字或窗口内容里带发送/付款/删除等字样；输入框填写带这些字样的不算（只是打字）。
 * recent = 最近几次观察工具（读取窗口/可访问性树）的输出，用于按元素编号找到元素名字。启发式，宁严勿松。
 */
export function isSensitiveAction(tool: string, input: Record<string, unknown>, recent: string[] = []): boolean {
	if (tool === "kill_app" || tool === "browser_download") return true;
	if (tool === "browser_dialog") return String(input.action ?? "") === "accept";
	if (tool === "browser_click" || tool === "browser_pointer") {
		const ref = String(input.ref ?? "");
		if (!ref) return true; // 坐标点击看不出点的是什么，宁严勿松
		for (const txt of recent) {
			const i = txt.indexOf(`"${ref}"`);
			if (i >= 0) return SENSITIVE_WORDS.test(txt.slice(Math.max(0, i - 300), i + 300));
		}
		return false;
	}
	if (tool === "press_key") return SENSITIVE_KEYS.test(String(input.key ?? input.keys ?? ""));
	if (tool === "hotkey") {
		const keys = (Array.isArray(input.keys) ? input.keys : [input.key ?? input.keys]).map(String);
		return keys.some((k) => SENSITIVE_KEYS.test(k));
	}
	// 带换行的输入在聊天软件里等于按回车发送
	if (tool === "type_text") return /[\n\r]/.test(String(input.text ?? ""));
	if (tool === "invoke_menu") return SENSITIVE_WORDS.test(JSON.stringify(input.path ?? input.menu ?? input));
	if (/^(click|double_click|right_click)$/.test(tool)) {
		const label = [input.label, input.name, input.title, input.description].filter(Boolean).join(" ");
		if (label && SENSITIVE_WORDS.test(label)) return true;
		const token = String(input.element_token ?? input.element ?? input.element_index ?? "");
		if (token) {
			for (const txt of recent) {
				const line = txt.split("\n").find((l) => l.includes(token));
				if (line) return SENSITIVE_WORDS.test(line);
			}
		}
		return false;
	}
	return false;
}

/** 连接用户浏览器的审批卡片说明 */
export const BROWSER_PREPARE_SUMMARY = (input: Record<string, unknown>) =>
	(input.allow_launch
		? "在你的电脑上另开一个独立的 Chrome/Edge 窗口（全新的空白资料，不带你的登录状态），助理通过调试接口快速操作网页。"
		: "连接你正在用的 Chrome/Edge（调试接口，只在本机），助理可以直接读取和操作网页，比截图点鼠标快得多也准得多。会保留你的登录状态，不会重启浏览器。Chrome 可能会临时打开设置页开启“远程调试”再关掉，macOS 上 Chrome 还可能自己弹出“允许远程调试”请你点允许，浏览器窗口可能会来到前台。连接期间助理能看到这个浏览器里的网页内容，任务结束后自动断开。") +
	"之后打开网址、点击、输入仍按你的权限档位审批。";

/** browser_download / browser_set_input_files 的路径：默认必须在工作区里，完全权限（hostAccess）下允许用户主机上的绝对路径；返回拒绝原因或 null */
export function browserFileViolation(tool: string, input: Record<string, unknown>, workspace?: string, hostAccess = false): string | null {
	if (tool !== "browser_download" && tool !== "browser_set_input_files") return null;
	if (hostAccess) {
		const paths = tool === "browser_download" ? [input.destination_root] : Array.isArray(input.files) ? input.files : [undefined];
		return paths.every((p) => typeof p === "string" && isAbsolute(p) && !p.includes("\0")) ? null : "完全权限下也要用用户电脑上的绝对路径（destination_root 是目录，files 是文件）。";
	}
	if (!workspace) return "这台电脑上没有允许读写的工作区，不能上传或下载文件。";
	const root = resolve(workspace);
	const inside = (p: unknown) => typeof p === "string" && isAbsolute(p) && !p.includes("\0") && (resolve(p) === root || resolve(p).startsWith(root + sep));
	const paths = tool === "browser_download" ? [input.destination_root] : Array.isArray(input.files) ? input.files : [undefined];
	return paths.every(inside) ? null : `文件路径必须是你工作区（${root}）里的绝对路径。先把文件放进工作区再上传；下载的 destination_root 用工作区里的目录。`;
}

/** 共用电脑的工作方式（注入系统提示）：让助理自己按需选屏幕 / 隔离 / 不用屏幕 */
export const SHARED_COMPUTER_PROMPT = `<assistant-computer>
所有助理默认共用一台助理电脑：同样的文件、同一个浏览器的登录状态（cookie）、同样已装的应用（如微信）。按需选择，不用每次问用户：
- 不需要看屏幕的事（读写文件、跑命令、下载、处理数据）直接用 shell / 文件工具，不要开屏幕。
- 网页任务用浏览器工具：你只看得到、只操作自己打开的标签页；其他助理的标签页不要动。登录状态是共用的，别随便退出登录。
- 主屏幕有别的助理在操作时，你的桌面操作会自动换到你自己的屏幕（computer_screen own 也可以主动开）；要长时间操作桌面应用时先开自己的屏幕。用完 computer_screen main 关掉。
- 需要用另一个账号登录、或不想带上共用的登录状态时，用 browser_context isolated 开一个单独的浏览器环境，并告诉用户。
- 只有必须长期和其他助理分开账号 / 数据时才用 computer_screen separate_on 开单独的电脑，并告诉用户原因。
- cua-driver 已是 0.35：get_window_state 默认只回精简的 tree_markdown（没有 elements），要拿 element_token 就传 tree_format:"elements"（或 full_output:true）；重复读同一个窗口用 since:"latest" 只取变化。想一次做多步用 run_steps（最多 64 步，遇错即停、不自动回滚），批量里每一步都会按你的权限档位单独检查；脚本 run_script 已关闭，不要用它。
</assistant-computer>`;

export const isComputerTool = (name: string) => name.startsWith(MCP_PREFIX) || name.startsWith(HOST_MCP_PREFIX) || name === "computer_screenshot" || name === "request_handoff" || name === "computer_screen";

/** 供审批扩展使用：sandbox 目标下的电脑工具由本扩展自己把关。 */
export function trustedComputerTool(target: "sandbox" | "host") {
	return (name: string) => target === "sandbox" && isComputerTool(name);
}
/** 本机工具由本扩展逐项审批（避免通用审批再问一次） */
export const isHostTool = (name: string) => name.startsWith(HOST_MCP_PREFIX);

export function computerExtension(host: ComputerHost) {
	return (pi: ExtensionAPI) => {
		const host_ = host.target === "host";
		const prefix = host_ ? HOST_MCP_PREFIX : MCP_PREFIX;
		/** 本任务内已允许的本机工具（审批时选了“本任务内都允许”） */
		const granted = new Set<string>();
		/** 最近几次观察工具的输出（敏感动作判断用） */
		const recent: string[] = [];
		const pending = new Map<string, { tool: string; input: Record<string, unknown>; summary: string; approval?: ActionLogEntry["approval"] }>();
		const policy = (): Approvals => host.approvals?.() ?? (host_ ? "all" : "none");
		const browserOn = host_ && host.browserTools !== false && policy() !== "observe";
		const log = (e: Omit<ActionLogEntry, "target">) => {
			try {
				host.log?.({ ...e, target: host.target });
			} catch {}
		};
		pi.registerMcpServer(host_ ? HOST_MCP_SERVER : MCP_SERVER, {
			command: host.mcp.command,
			args: host.mcp.args,
			env: { CUA_DRIVER_TELEMETRY: "0", CUA_DRIVER_DISABLE_RUN_SCRIPT: "1", ...(host.mcp.env ?? {}) },
			exposure: "direct",
			// “只看”档位：输入类工具直接不给模型（调用时也会被拦下）
			toolExposure: Object.fromEntries([...HIDDEN_TOOLS, ...(host_ && browserOn ? [] : CUA_BROWSER_TOOLS), ...(policy() === "observe" ? INPUT_TOOLS : [])].map((t) => [t, "hidden" as const])),
			description: host_
				? policy() === "observe"
					? "用户本人的电脑（用户说“我的电脑 / 我电脑上的浏览器”时用这组工具；只看：可以截图、读取窗口内容，不能点击或输入）"
					: policy() === "all"
					? "用户本人的电脑（用户说“我的电脑 / 我电脑上的浏览器”时用这组工具；只能操作用户允许的应用，每个动作都要用户批准）"
					: policy() === "sensitive"
					? "用户本人的电脑（用户说“我的电脑 / 我电脑上的浏览器”时用这组工具；信任：所有应用都能看、能操作，发送/付款/删除类动作需要用户批准）"
					: "用户本人的电脑（用户说“我的电脑 / 我电脑上的浏览器”时用这组工具；完全权限：所有应用都能看、能操作，像人一样使用，应用层不再弹审批（受保护操作也直接执行））"
				: "助理自己的 Linux 桌面电脑（浏览器、微信等应用）——不是用户的电脑",
			timeout: 60_000,
		});
		if (host.history) {
			const hist = host.history;
			pi.registerTool({
				name: host_ ? "hostpc_action_history" : "computer_action_history",
				label: "查看操作记录",
				description: host_
					? "查看你之前在用户电脑上做过的操作（时间、工具、参数、结果、是否被拒绝/拦下），最新在前。用于复盘：出错后回看哪一步失败、避免重复做过的操作。"
					: "查看你之前在助理电脑上做过的操作（时间、工具、参数、结果），最新在前。all=true 时包括同一台共用电脑上其他助理的操作。用于复盘出错原因、接着上次的进度做。",
				promptSnippet: host_ ? "hostpc_action_history: 回看在用户电脑上的操作记录" : "computer_action_history: 回看在助理电脑上的操作记录",
				parameters: Type.Object({
					limit: Type.Optional(Type.Number({ description: "最多几条（默认 30，最多 200）" })),
					...(host_ ? {} : { all: Type.Optional(Type.Boolean({ description: "包括其他助理的操作" })) }),
				}),
				annotations: { readOnlyHint: true },
				async execute(_id, p) {
					const q = p as { limit?: number; all?: boolean };
					return { content: [{ type: "text" as const, text: hist({ limit: q.limit, all: q.all }) }], details: undefined };
				},
			});
		}
		if (!host_ && host.screenshot && host.handoff) {
		const shot = host.screenshot;
		const hand = host.handoff;
		pi.registerTool({
			name: "computer_screenshot",
			label: "看屏幕",
			description: "截取助理电脑的整个屏幕，查看当前画面（打开的窗口、登录二维码、弹窗等）。",
			promptSnippet: "computer_screenshot: 截取助理电脑屏幕",
			parameters: Type.Object({}),
			annotations: { readOnlyHint: true },
			async execute() {
				const png = await shot();
				return { content: [{ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" }, { type: "text" as const, text: "这是助理电脑当前的屏幕。" }], details: undefined };
			},
		});
		pi.registerTool({
			name: "request_handoff",
			label: "请你接管",
			description: "遇到需要用户本人完成的步骤（扫码登录、短信/图形验证码、人脸、付款确认）时调用：把当前屏幕推送到用户手机，等待用户完成后继续。",
			promptSnippet: "request_handoff: 请用户扫码/输入验证码等",
			parameters: Type.Object({ reason: Type.String({ description: "需要用户做什么，例如“请用助理的微信扫码登录”" }) }),
			annotations: { readOnlyHint: true },
			async execute(_id, p) {
				const r = await hand(p.reason, await shot());
				return { content: [{ type: "text" as const, text: `用户接管结果：${r}` }], details: undefined };
			},
		});
		}
		if (host_ && policy() !== "observe") pi.on("before_agent_start", async (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${hostDesktopPrompt(policy())}\n\n${browserOn ? hostBrowserPrompt(host.hostFileAccess?.() ?? false) : HOST_BROWSER_BOUNDED_NOTE}` }));
		if (!host_ && host.screens) {
			const sc = host.screens;
			pi.on("before_agent_start", async (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${SHARED_COMPUTER_PROMPT}` }));
			pi.registerTool({
				name: "computer_screen",
				label: "屏幕",
				description:
					"管理你在助理电脑上用的屏幕。所有助理默认共用一台电脑（同样的文件、浏览器登录状态、已装的应用）和它的主屏幕。" +
					"list：看有哪些屏幕、谁在用。own：给自己开一块屏幕（同一台电脑、同样的文件和登录状态，但有自己的鼠标键盘，不和别的助理抢），主屏幕有别的助理在操作、或者你要长时间操作桌面应用时用。" +
					"main：回到主屏幕（关掉自己的屏幕）。" +
					(sc.separate ? "separate_on / separate_off：开 / 关“单独的电脑”（自己的家目录和登录状态，和其他助理完全分开，从下一条消息开始生效；必须说明原因并告诉用户）——只在必须长期分开账号时用，临时用另一个账号登录网站请用 browser_context isolated。" : ""),
				promptSnippet: "computer_screen: 自己的屏幕 / 回主屏幕 / 单独的电脑",
				parameters: Type.Object({
					action: Type.Union([Type.Literal("list"), Type.Literal("own"), Type.Literal("main"), ...(sc.separate ? [Type.Literal("separate_on"), Type.Literal("separate_off")] : [])]),
					reason: Type.Optional(Type.String({ description: "separate_on / separate_off 时必填：为什么" })),
				}),
				async execute(_id, p) {
					const a = String((p as { action: string }).action);
					const reason = String((p as { reason?: string }).reason ?? "").trim();
					let t: string;
					if (a === "list") t = await sc.list();
					else if (a === "own") t = await sc.own();
					else if (a === "main") t = await sc.main();
					else if (sc.separate && (a === "separate_on" || a === "separate_off")) {
						if (!reason) throw new Error("请在 reason 里说明为什么要开 / 关单独的电脑");
						t = await sc.separate(a === "separate_on", reason);
					} else throw new Error(`不支持的操作：${a}`);
					return { content: [{ type: "text" as const, text: t }], details: undefined };
				},
			});
		}
		pi.on("tool_call", async (event) => {
			if (!isComputerTool(event.toolName)) return;
			const own = event.toolName.startsWith(prefix);
			const tool = own ? event.toolName.slice(prefix.length) : event.toolName;
			const input = (event.input ?? {}) as Record<string, unknown>;
			const summary = host.describe?.(tool, input) ?? (host_ ? `在你的电脑上执行 ${tool}` : `在助理电脑上执行 ${tool}`);
			const callId = (event as { toolCallId?: string }).toolCallId ?? `${Date.now()}`;
			if (host.isPaused()) {
				if (own) log({ callId, tool, input, summary, phase: "blocked", detail: "已暂停" });
				return { block: true, reason: "用户已暂停“操作电脑”。停止所有电脑操作，告诉用户你停在了哪一步。" };
			}
			if (!own) return;
			let approval: ActionLogEntry["approval"] = "auto";
			// 0.35 批量动作：展开成每一步，逐层过同一套权限检查（否则嵌套的动作会绕过 guard / 敏感动作 / 文件限制）
			const steps = expandComputerSteps(tool, input);
			const batch = steps.length > 1 ? `（批量 ${steps.length} 步：${[...new Set(steps.map((s) => s.tool))].join("、")}）` : "";
			const fullSummary = summary + batch;
			const hiddenStep = steps.find((s) => HIDDEN_TOOLS.includes(s.tool) || s.tool === STEP_UNKNOWN);
			if (hiddenStep) {
				const why = hiddenStep.tool === STEP_UNKNOWN ? "批量动作里有认不出的步骤，不能确认安全，已整批拦下。" : `不提供的电脑工具：${hiddenStep.tool}（批量动作里也拦）。`;
				log({ callId, tool, input, summary: fullSummary, phase: "blocked", detail: why });
				return { block: true, reason: why };
			}
			if (steps.some((s) => CUA_BROWSER_TOOLS.includes(s.tool)) && !browserOn) {
				const why = host_ ? "“限定”档位不能连接用户的浏览器；需要用户把档位调到“信任”或以上。" : "助理电脑上的网页请用浏览器工具（browser_*，Playwright），不用 cua 的浏览器工具。";
				log({ callId, tool, input, summary: fullSummary, phase: "blocked", detail: why });
				return { block: true, reason: why };
			}
			const fileWhy = steps.map((s) => browserFileViolation(s.tool, s.input, host.workspace, host.hostFileAccess?.() ?? false)).find(Boolean);
			if (fileWhy) {
				log({ callId, tool, input, summary: fullSummary, phase: "blocked", detail: fileWhy });
				return { block: true, reason: fileWhy };
			}
			const observe = steps.every((s) => isObserveTool(s.tool));
			if (!observe && host.before) {
				for (const s of steps) {
					if (isObserveTool(s.tool)) continue;
					const why = await host.before(s.tool, s.input).catch(() => null);
					if (why) {
						log({ callId, tool, input, summary: fullSummary, phase: "blocked", detail: why });
						return { block: true, reason: why };
					}
				}
			}
			const p = policy();
			if (p === "observe" && !observe) {
				log({ callId, tool, input, summary: fullSummary, phase: "blocked", detail: "“只看”档位不允许操作" });
				return { block: true, reason: "你对用户电脑的权限是“只看”：只能截图和读取窗口内容，不能点击、输入或打开应用。需要操作请让用户在设置里调高权限。" };
			}
			// 硬性保护：非完全权限档位都要明确批准，且不会记住；完全权限（本机档位 full）应用层不弹审批
			let g: GuardHit | null = null;
			let gTool = "";
			if (!observe && !(host_ && p === "none")) {
				for (const s of steps) {
					const hit = guardComputer(s.tool, s.input, host.guard ?? { target: host.target }, recent);
					if (hit) {
						g = hit;
						gTool = s.tool;
						break;
					}
				}
			}
			if (g) {
				const label = gTool && gTool !== tool ? `${g.label}（批量里的 ${gTool}）` : g.label;
				const res = await host.request({ toolName: event.toolName, input, summary: `⚠️ 受保护的操作（${label}）：${fullSummary}`, risk: "high", allowTask: false });
				if (!res.approved) {
					log({ callId, tool, input, summary: fullSummary, phase: "blocked", detail: `受保护的操作（${label}），用户没有批准${res.note ? `：${res.note}` : ""}` });
					return { block: true, reason: `这是受保护的操作（${label}），用户没有批准。不要换方式重试。` };
				}
				approval = "guarded";
			} else {
				// browser_prepare 和其他动作一样按档位审批（完全权限 / 信任不问）；需要问时卡片上说明连接浏览器意味着什么
				const sensitive = steps.some((s) => isSensitiveAction(s.tool, s.input, recent));
				const needs = !observe && p !== "none" && (p === "all" || sensitive) && !granted.has(tool);
				if (needs) {
					const res = await host.request({ toolName: event.toolName, input, summary: tool === "browser_prepare" && host_ ? BROWSER_PREPARE_SUMMARY(input) : fullSummary, risk: "high", allowTask: p === "all" });
					if (!res.approved) {
						log({ callId, tool, input, summary: fullSummary, phase: "blocked", detail: `用户拒绝${res.note ? `：${res.note}` : ""}` });
						return { block: true, reason: `用户拒绝了这个电脑操作${res.note ? `：${res.note}` : ""}。不要换方式重试。` };
					}
					approval = res.scope === "task" ? "task" : "approved";
					if (res.scope === "task") granted.add(tool);
				}
			}
			pending.set(callId, { tool, input, summary: fullSummary, approval });
			log({ callId, tool, input, summary: fullSummary, phase: "start", approval });
		});
		pi.on("tool_result", async (event) => {
			const e = event as { toolCallId: string; toolName: string; content: { type: string; text?: string }[]; isError: boolean };
			if (!e.toolName.startsWith(prefix)) return;
			const text = (e.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
			const tool = e.toolName.slice(prefix.length);
			if (READ_ONLY.test(tool)) {
				recent.unshift(text.slice(0, 50_000));
				recent.length = Math.min(recent.length, 3);
			}
			const p = pending.get(e.toolCallId);
			pending.delete(e.toolCallId);
			if (p) log({ callId: e.toolCallId, tool: p.tool, input: p.input, summary: p.summary, phase: e.isError ? "error" : "done", detail: text.slice(0, 500), approval: p.approval });
		});
	};
}

/**
 * 助理电脑已安装但没开机时挂上的“开电脑”工具（按需启动，DESIGN §15.2）。
 * 调用时：开机并等桌面就绪 → 在同一个会话里热注册电脑扩展（cua-driver MCP 服务 + 看屏幕 + 请你接管 + 审批/记录钩子）
 * → 等 MCP 工具连上并出现在工具列表里 → 返回。工具在同一轮里就能用，不需要用户再说一句话。
 */
export function computerLauncherExtension(host: { start(): Promise<void>; computer?: ComputerHost; waitMs?: number }) {
	return (pi: ExtensionAPI) => {
		let attached = false;
		pi.registerTool({
			name: "computer_open",
			label: "打开助理电脑",
			description: "助理电脑（你自己的 Linux 桌面：浏览器、微信等应用）现在是关机状态。需要用电脑时先调用它开机（约 10–20 秒）；返回后电脑操作工具（mcp__computer__*、computer_screenshot 等）立即可用，直接继续操作。",
			promptSnippet: "computer_open: 打开（开机）助理电脑",
			parameters: Type.Object({}),
			async execute() {
				const dbg = (m: string) => process.env.PIA_DEBUG_COMPUTER && console.error(`[computer_open] ${m}`);
				dbg("start");
				await host.start();
				dbg("started");
				if (!host.computer) return { content: [{ type: "text" as const, text: "助理电脑已经开机。" }], details: undefined };
				if (!attached) {
					attached = true;
					computerExtension(host.computer)(pi);
				}
				dbg("attached");
				const ok = await waitForTools(pi, MCP_PREFIX, host.waitMs ?? 60_000);
				dbg(`tools ok=${ok}`);
				const names = pi.getAllTools().map((t) => t.name).filter((n) => n.startsWith(MCP_PREFIX) || n === "computer_screenshot");
				return {
					content: [
						{
							type: "text" as const,
							text: ok
								? `助理电脑已经开机，桌面已就绪。电脑工具现在就能用（${names.slice(0, 12).join("、")}${names.length > 12 ? " 等" : ""}），直接继续完成用户的任务，不用等用户回复。`
								: "助理电脑已经开机，但电脑操作工具还没连上：先用 computer_screenshot 看屏幕；如果还不行，告诉用户稍后再试。",
						},
					],
					details: undefined,
				};
			},
		});
	};
}

/** 等某个前缀的工具出现在会话工具列表里（MCP 服务在后台连接） */
export async function waitForTools(pi: Pick<ExtensionAPI, "getAllTools">, prefix: string, timeoutMs: number) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (pi.getAllTools().some((t) => t.name.startsWith(prefix))) return true;
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}
