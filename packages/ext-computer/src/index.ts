/**
 * @pi-assistant/ext-computer —— 让助理操作“它自己的电脑”（或经用户允许操作本机）。
 *
 * 集成方式只用公开接口：`pi.registerMcpServer("computer", { command: <cua-driver mcp> })`。
 * cua-driver 本体是 MIT；会拉取非 MIT 组件的工具（install_extension → cua-perception/AGPL、
 * parse_visual_regions 等）一律隐藏。
 *
 * 目标：
 *  - sandbox（默认）：助理电脑容器里的 Linux 桌面，它自己的电脑，输入动作无需逐个审批；
 *  - host（默认关闭）：用户本机，cua-driver 以 bounded 权限模式运行，所有输入动作都要审批。
 * 一键暂停：host.isPaused() 为真时，所有电脑工具立即被拒绝。
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MCP_SERVER = "computer";
export const MCP_PREFIX = "mcp__computer__";

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
const READ_ONLY = /^(get_|list_|zoom$|check_permissions$|health_report$|verify_state$)/;

export interface ComputerHost {
	target: "sandbox" | "host";
	mcp: { command: string; args: string[]; env?: Record<string, string> };
	isPaused(): boolean;
	screenshot(): Promise<Buffer>;
	/** 请用户接管（扫码 / 验证码）；推送到手机，返回用户的结果说明。 */
	handoff(reason: string, screenshot: Buffer): Promise<string>;
	/** host 目标下的输入动作审批 */
	request(req: { toolName: string; input: Record<string, unknown>; summary: string; risk: "medium" | "high" }): Promise<{ approved: boolean; note?: string }>;
}

export const isComputerTool = (name: string) => name.startsWith(MCP_PREFIX) || name === "computer_screenshot" || name === "request_handoff";

/** 供审批扩展使用：sandbox 目标下的电脑工具由本扩展自己把关。 */
export function trustedComputerTool(target: "sandbox" | "host") {
	return (name: string) => target === "sandbox" && isComputerTool(name);
}

export function computerExtension(host: ComputerHost) {
	return (pi: ExtensionAPI) => {
		pi.registerMcpServer(MCP_SERVER, {
			command: host.mcp.command,
			args: host.mcp.args,
			env: { CUA_DRIVER_TELEMETRY: "0", ...(host.mcp.env ?? {}) },
			exposure: "direct",
			toolExposure: Object.fromEntries(HIDDEN_TOOLS.map((t) => [t, "hidden" as const])),
			description: host.target === "sandbox" ? "助理自己的 Linux 桌面电脑（浏览器、微信等应用）" : "用户本机（受限权限）",
			timeout: 60_000,
		});
		pi.registerTool({
			name: "computer_screenshot",
			label: "看屏幕",
			description: "截取助理电脑的整个屏幕，查看当前画面（打开的窗口、登录二维码、弹窗等）。",
			promptSnippet: "computer_screenshot: 截取助理电脑屏幕",
			parameters: Type.Object({}),
			annotations: { readOnlyHint: true },
			async execute() {
				const png = await host.screenshot();
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
				const r = await host.handoff(p.reason, await host.screenshot());
				return { content: [{ type: "text" as const, text: `用户接管结果：${r}` }], details: undefined };
			},
		});
		pi.on("tool_call", async (event) => {
			if (!isComputerTool(event.toolName)) return;
			if (host.isPaused()) return { block: true, reason: "用户已暂停“操作电脑”。停止所有电脑操作，告诉用户你停在了哪一步。" };
			if (host.target !== "host") return;
			const tool = event.toolName.slice(MCP_PREFIX.length);
			if (!event.toolName.startsWith(MCP_PREFIX) || READ_ONLY.test(tool)) return;
			const input = (event.input ?? {}) as Record<string, unknown>;
			const res = await host.request({ toolName: event.toolName, input, summary: `在你的电脑上执行 ${tool}`, risk: "high" });
			if (!res.approved) return { block: true, reason: `用户拒绝了在本机上的操作${res.note ? `：${res.note}` : ""}` };
		});
	};
}
