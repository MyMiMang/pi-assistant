/**
 * @pi-assistant/ext-approval —— 审批闸门（Pi 扩展）。
 * 通过 pi.on("tool_call") 拦截有后果的工具调用：allow / ask（等待用户在任一设备批准）/ deny。
 * 只依赖 Pi 的 ExtensionAPI 类型，运行时能力由宿主注入。
 */
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { guardPath, guardShell, type GuardContext, type GuardHit } from "@pi-assistant/shared";

export type Decision =
	| { kind: "allow" }
	| { kind: "ask"; summary: string; risk: "medium" | "high" }
	| { kind: "deny"; reason: string };

export interface ApprovalRequest {
	toolName: string;
	input: Record<string, unknown>;
	summary: string;
	risk: "medium" | "high";
}
export interface ApprovalHost {
	workspace: string;
	request(req: ApprovalRequest): Promise<{ approved: boolean; note?: string }>;
	/** 由其它扩展自行把关的工具（例如 sandbox 目标下的电脑工具） */
	trusted?: (toolName: string) => boolean;
	/** 硬性保护清单的上下文（受保护路径等）；命中的 shell / 文件操作必须明确批准，任何设置都不能跳过 */
	guard?: GuardContext;
	/** “完全权限”下对用户主机统一可用：文件工具不再被工作区路径拦下、普通命令不再逐条审批（凭据路径拒绝与硬性保护不变） */
	hostAccess?: () => boolean;
}

/** 硬性保护：shell 命令、文件写入 */
export function hardGuard(toolName: string, input: Record<string, unknown>, workspace: string, ctx: GuardContext): GuardHit | null {
	if (toolName === "bash" || toolName === "powershell") return guardShell(String(input.command ?? ""), ctx);
	if (toolName === "write" || toolName === "edit") {
		const p = typeof input.path === "string" ? input.path : "";
		return p ? guardPath(isAbsolute(p) ? p : resolve(workspace, p), ctx) : null;
	}
	return null;
}

// codemode / tool_search 本身无副作用：脚本里调用的每个工具仍会单独经过这道闸门（parentToolCallId）
const SAFE_TOOLS = new Set(["read", "ls", "find", "grep", "deliver_file", "ask_user", "spawn_task", "codemode", "tool_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", "computer_open"]);
const RISKY_BASH: [RegExp, string, "medium" | "high"][] = [
	[/\brm\s+(-[a-zA-Z]*\s+)*/, "删除文件", "high"],
	[/\bsudo\b/, "以管理员权限运行", "high"],
	[/\b(mkfs|dd\s+if=|shutdown|reboot)\b/, "危险的系统命令", "high"],
	[/\bgit\s+push\b/, "推送代码到远程仓库", "medium"],
	[/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/, "丢弃 git 改动", "high"],
	[/\b(curl|wget|http)\b[^|]*\s(-X\s*(POST|PUT|DELETE|PATCH)|--data|-d\s)/i, "向外部发送数据", "medium"],
	[/\b(npm|pnpm|yarn)\s+publish\b/, "发布软件包", "high"],
	[/\b(chmod|chown)\s+-R\b/, "批量修改权限", "medium"],
	[/\bkill(all)?\b/, "结束进程", "medium"],
	[/\b(apt|apt-get|brew|choco|winget)\s+(install|remove|uninstall)\b/, "安装/卸载系统软件", "medium"],
];
const SECRET_PATHS = [/\.ssh\b/, /\.aws\b/, /\.gnupg\b/, /\.pi\/agent/, /auth\.json$/, /Cookies$/, /Login Data$/, /keychain/i];

function outside(workspace: string, p: string): boolean {
	const abs = isAbsolute(p) ? p : resolve(workspace, p);
	const rel = relative(workspace, abs);
	return rel.startsWith("..") || isAbsolute(rel);
}

export function evaluate(
	toolName: string,
	input: Record<string, unknown>,
	annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } | undefined,
	workspace: string,
	hostAccess = false,
): Decision {
	const path = typeof input.path === "string" ? input.path : undefined;
	if (path && SECRET_PATHS.some((r) => r.test(path))) return { kind: "deny", reason: "不允许访问凭据/密钥文件" };
	if (toolName === "bash") {
		const cmd = String(input.command ?? "");
		if (SECRET_PATHS.some((r) => r.test(cmd))) return { kind: "deny", reason: "命令涉及凭据/密钥文件，已拒绝" };
		// 完全权限：普通命令不再逐条审批（受保护操作仍由 hardGuard 每次明确批准）
		if (!hostAccess) for (const [re, label, risk] of RISKY_BASH) if (re.test(cmd)) return { kind: "ask", summary: `${label}：${cmd}`, risk };
		return { kind: "allow" };
	}
	if (SAFE_TOOLS.has(toolName)) return { kind: "allow" };
	if (toolName === "write" || toolName === "edit") {
		// 完全权限：文件写入对用户主机统一可用，不再限制在工作区
		if (!hostAccess && path && outside(workspace, path)) return { kind: "deny", reason: "只能修改工作区内的文件" };
		return { kind: "allow" };
	}
	// 其他工具（MCP、连接器等）按 annotations 判断，缺省视为可能有副作用
	if (annotations?.readOnlyHint) return { kind: "allow" };
	if (annotations?.destructiveHint === true || annotations?.openWorldHint !== false)
		return { kind: "ask", summary: toolName.startsWith("mcp__") ? `调用 MCP 服务「${toolName.split("__")[1]}」的工具 ${toolName.split("__").slice(2).join("__")}` : `调用工具 ${toolName}`, risk: annotations?.destructiveHint ? "high" : "medium" };
	return { kind: "allow" };
}

export function approvalExtension(host: ApprovalHost) {
	return (pi: ExtensionAPI) => {
		const rejected = new Map<string, number>();
		pi.on("tool_call", async (event) => {
			const input = (event.input ?? {}) as Record<string, unknown>;
			// 硬性保护在一切规则之前：不看 trusted、不记“本任务内都允许”，每次都问
			const g = hardGuard(event.toolName, input, host.workspace, host.guard ?? { target: "host" });
			let guarded = false;
			if (g) {
				const res = await host.request({ toolName: event.toolName, input, summary: `⚠️ 受保护的操作（${g.label}）：${String(input.command ?? input.path ?? "")}`.slice(0, 400), risk: "high" });
				if (!res.approved) return { block: true, reason: `这是受保护的操作（${g.label}），用户没有批准${res.note ? `：${res.note}` : ""}。不要换方式重试。` };
				guarded = true;
			}
			if (host.trusted?.(event.toolName)) return;
			const annotations = pi.getAllTools().find((t) => t.name === event.toolName)?.annotations;
			const d = evaluate(event.toolName, input, annotations, host.workspace, host.hostAccess?.() ?? false);
			if (d.kind === "allow") return;
			if (d.kind === "deny") return { block: true, reason: d.reason };
			if (guarded) return; // 已经明确批准过
			// 拒绝是最终结果：相同调用 30 分钟内直接拒绝，避免换个说法重试
			const fp = `${event.toolName}:${JSON.stringify(input)}`;
			const at = rejected.get(fp);
			if (at && Date.now() - at < 30 * 60_000) return { block: true, reason: "用户已拒绝过该操作，不要重试，请告知用户" };
			const res = await host.request({ toolName: event.toolName, input, summary: d.summary, risk: d.risk });
			if (!res.approved) {
				rejected.set(fp, Date.now());
				return { block: true, reason: `用户拒绝了该操作${res.note ? `：${res.note}` : ""}。不要换方式重试。` };
			}
		});
	};
}
