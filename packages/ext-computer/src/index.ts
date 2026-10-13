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
 * 硬性保护：命中 @pi-assistant/shared 的 guardComputer 的动作在任何档位都必须明确批准（不能“本任务内都允许”）。
 * 一键暂停：host.isPaused() 为真时，所有电脑工具立即被拒绝（任何模式都生效）。
 * 操作记录：每个电脑动作（含被拒绝/暂停拦下的）都交给 host.log() 记录，供回看。
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { guardComputer, type GuardContext } from "@pi-assistant/shared";

export const MCP_SERVER = "computer";
export const MCP_PREFIX = "mcp__computer__";
/** 本机（用户自己的电脑）用另一个 MCP 服务名，工具名不会和助理电脑的混在一起 */
export const HOST_MCP_SERVER = "hostpc";
export const HOST_MCP_PREFIX = "mcp__hostpc__";

/** 不暴露给模型的 cua-driver 工具：许可证风险、自我更新、改配置、重放。 */
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
];
const READ_ONLY = /^(get_|list_|zoom$|check_permissions$|health_report$|verify_state$|screenshot$)/;
/** 会改变电脑状态的 Cua 工具（“只看”档位隐藏） */
export const INPUT_TOOLS = ["click", "double_click", "right_click", "type_text", "set_value", "press_key", "hotkey", "scroll", "drag", "move_cursor", "invoke_menu", "launch_app", "kill_app", "bring_to_front", "browser_click", "browser_type", "browser_navigate", "browser_set_input_files", "browser_dialog", "set_clipboard", "write_clipboard"];

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
	if (tool === "kill_app") return true;
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

/** 共用电脑的工作方式（注入系统提示）：让助理自己按需选屏幕 / 隔离 / 不用屏幕 */
export const SHARED_COMPUTER_PROMPT = `<assistant-computer>
所有助理默认共用一台助理电脑：同样的文件、同一个浏览器的登录状态（cookie）、同样已装的应用（如微信）。按需选择，不用每次问用户：
- 不需要看屏幕的事（读写文件、跑命令、下载、处理数据）直接用 shell / 文件工具，不要开屏幕。
- 网页任务用浏览器工具：你只看得到、只操作自己打开的标签页；其他助理的标签页不要动。登录状态是共用的，别随便退出登录。
- 主屏幕有别的助理在操作时，你的桌面操作会自动换到你自己的屏幕（computer_screen own 也可以主动开）；要长时间操作桌面应用时先开自己的屏幕。用完 computer_screen main 关掉。
- 需要用另一个账号登录、或不想带上共用的登录状态时，用 browser_context isolated 开一个单独的浏览器环境，并告诉用户。
- 只有必须长期和其他助理分开账号 / 数据时才用 computer_screen separate_on 开单独的电脑，并告诉用户原因。
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
		const log = (e: Omit<ActionLogEntry, "target">) => {
			try {
				host.log?.({ ...e, target: host.target });
			} catch {}
		};
		pi.registerMcpServer(host_ ? HOST_MCP_SERVER : MCP_SERVER, {
			command: host.mcp.command,
			args: host.mcp.args,
			env: { CUA_DRIVER_TELEMETRY: "0", ...(host.mcp.env ?? {}) },
			exposure: "direct",
			// “只看”档位：输入类工具直接不给模型（调用时也会被拦下）
			toolExposure: Object.fromEntries([...HIDDEN_TOOLS, ...(policy() === "observe" ? INPUT_TOOLS : [])].map((t) => [t, "hidden" as const])),
			description: host_
				? policy() === "observe"
					? "用户自己的电脑（只看：可以截图、读取窗口内容，不能点击或输入）"
					: policy() === "all"
					? "用户自己的电脑（只能操作用户允许的应用，每个动作都要用户批准）"
					: "用户自己的电脑（用户授予了完全权限；发送/付款/删除类动作可能需要用户批准）"
				: "助理自己的 Linux 桌面电脑（浏览器、微信等应用）",
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
			const observe = READ_ONLY.test(tool) || tool === "start_session" || tool === "end_session";
			if (!observe && host.before) {
				const why = await host.before(tool, input).catch(() => null);
				if (why) {
					log({ callId, tool, input, summary, phase: "blocked", detail: why });
					return { block: true, reason: why };
				}
			}
			const p = policy();
			if (p === "observe" && !observe) {
				log({ callId, tool, input, summary, phase: "blocked", detail: "“只看”档位不允许操作" });
				return { block: true, reason: "你对用户电脑的权限是“只看”：只能截图和读取窗口内容，不能点击、输入或打开应用。需要操作请让用户在设置里调高权限。" };
			}
			// 硬性保护：任何档位都要明确批准，且不会记住
			const g = observe ? null : guardComputer(tool, input, host.guard ?? { target: host.target }, recent);
			if (g) {
				const res = await host.request({ toolName: event.toolName, input, summary: `⚠️ 受保护的操作（${g.label}）：${summary}`, risk: "high", allowTask: false });
				if (!res.approved) {
					log({ callId, tool, input, summary, phase: "blocked", detail: `受保护的操作（${g.label}），用户没有批准${res.note ? `：${res.note}` : ""}` });
					return { block: true, reason: `这是受保护的操作（${g.label}），用户没有批准。不要换方式重试。` };
				}
				approval = "guarded";
			} else {
				const needs = !observe && p !== "none" && (p === "all" || isSensitiveAction(tool, input, recent)) && !granted.has(tool);
				if (needs) {
					const res = await host.request({ toolName: event.toolName, input, summary, risk: "high", allowTask: p === "all" });
					if (!res.approved) {
						log({ callId, tool, input, summary, phase: "blocked", detail: `用户拒绝${res.note ? `：${res.note}` : ""}` });
						return { block: true, reason: `用户拒绝了这个电脑操作${res.note ? `：${res.note}` : ""}。不要换方式重试。` };
					}
					approval = res.scope === "task" ? "task" : "approved";
					if (res.scope === "task") granted.add(tool);
				}
			}
			pending.set(callId, { tool, input, summary, approval });
			log({ callId, tool, input, summary, phase: "start", approval });
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
