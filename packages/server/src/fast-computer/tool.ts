/**
 * 快速操作模型工具层：`fast_pick_action`。
 *
 * 闭环：主模型给出 goal + 目标窗口（可选预构建候选）→ 程序收集当前窗口状态 / 限候选 →
 * 快速模型只选一个候选 id → 程序校验 capture / 候选 / 授权 → 经既有电脑工具（`ctx.executeTool`，走同一套钩子）执行 →
 * 结果回主模型独立核验。失败 / abstain / 低可信 / 超时 / 模型故障 → 明确回主模型。
 *
 * 安全：快速模型看不到 tool/args；候选只允许电脑输入工具白名单；执行经 `ctx.executeTool`，
 * ext-computer 的 guard / 审批 / 暂停 / 凭据 deny 原样生效，不绕过。
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { models } from "../models.ts";
import { recordUsage } from "../usage/index.ts";
import { createChatChooser, createSystemOneChooser, MAX_FAST_CANDIDATES } from "./choosers.ts";
import { fastComputerSettings, selectFastAction, validateCandidates, type FastActionCandidate, type FastActionChooser, type FastComputerSettings } from "./index.ts";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

/** 按设置构建选择器。systemone = 原生 Jev（真 Jev）；chat = OpenAI 兼容替代（非 Jev）。 */
export function buildChooser(s: FastComputerSettings): FastActionChooser | null {
	if (s.kind === "systemone") {
		const apiKey = process.env.TYPESAFE_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "";
		if (!apiKey) return null; // 没 Key 就明确回主模型，不假装可用
		return createSystemOneChooser({ baseUrl: s.baseUrl, model: s.model, apiKey, timeoutMs: s.timeoutMs });
	}
	if (!s.provider || !s.id) return null;
	return createChatChooser({
		provider: s.provider,
		id: s.id,
		timeoutMs: s.timeoutMs,
		complete: (p, m, req) => models.complete(p, m, { messages: req.messages.map((x) => ({ role: "user" as const, text: x.text })), maxTokens: req.maxTokens, temperature: req.temperature, signal: req.signal }),
	});
}

interface CollectedElement {
	element_index?: number;
	role?: string;
	label?: string;
	element_token?: string;
	actions?: string[];
}

/** 从当前窗口状态程序化收集「点击」候选（语义候选 → 预构建动作 ID）。 */
export function clickCandidatesFromWindowState(prefix: string, target: { pid: number; window_id: number }, structured: unknown): FastActionCandidate[] {
	const elements = (structured as { elements?: CollectedElement[] } | null)?.elements ?? [];
	const clickable = elements.filter((e) => e.element_token && (!e.actions || e.actions.includes("press") || /button|checkbox|radio|link|menuitem|tab|row|cell|textfield|combobox/i.test(e.role ?? "")));
	return clickable.slice(0, MAX_FAST_CANDIDATES).map((e) => ({
		id: `el-${e.element_index ?? 0}`,
		label: `${e.role ?? "元素"}${e.label ? `：${e.label}` : ""}`.slice(0, 120),
		tool: `${prefix}click`,
		args: { pid: target.pid, window_id: target.window_id, element_token: e.element_token },
	}));
}

const outcomeText = (r: { result?: { content?: { type: string; text?: string }[] } }) => (r.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");

export interface FastComputerToolOptions {
	agentId: string;
	conversationId?: string | null;
	taskId?: string | null;
}

export function fastComputerExtension(opts: FastComputerToolOptions) {
	return {
		name: "pia-fast-computer",
		factory: (pi: ExtensionAPI) => {
			pi.registerTool({
				name: "fast_pick_action",
				label: "快速操作模型",
				description:
					"当你已经把目标收窄成一组有界候选、但需要在当前窗口里挑一个最合适的控件时用：程序读当前窗口状态生成候选，" +
					"由一个可选快速模型（默认关闭）只挑一个候选 id，然后由程序经既有电脑工具执行。" +
					"快速模型看不到工具名 / 参数 / 坐标，也不能自由调工具；选中不等于授权，执行仍走原有权限与审批。" +
					"没开启快速操作模型、模型不可用、拿不准或超时会明确回到你自己完成，不会无限重试。",
				promptSnippet: "fast_pick_action: 用快速模型在有界候选里挑一个控件（默认关闭）",
				parameters: Type.Object({
					goal: Type.String({ description: "要达成的目标（一句话）" }),
					pid: Type.Integer({ description: "目标窗口所属进程 pid" }),
					window_id: Type.Integer({ description: "目标窗口 id" }),
					prefix: Type.Optional(Type.Union([Type.Literal("hostpc"), Type.Literal("computer")], { description: "电脑目标：hostpc=用户电脑，computer=助理电脑；默认按可用工具判断" })),
					session: Type.Optional(Type.String({ description: "cua session 标签（可选）" })),
				}),
				async execute(_id: string, args: Record<string, unknown>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionToolContext) {
					const s = fastComputerSettings();
					if (!s.enabled) return text("快速操作模型没有开启（设置 › 模型 › 快速操作模型）。请直接用电脑工具自己完成。");
					const goal = String(args.goal ?? "").trim();
					const pid = Number(args.pid);
					const windowId = Number(args.window_id);
					const prefix = resolvePrefix(ctx, args.prefix);
					if (!prefix) return text("没有可用的电脑工具（操作这台电脑 / 助理电脑都没开），无法收集候选。请自己完成。");
					const target = { pid, window_id: windowId };

					const collected = await collectCandidates(ctx, prefix, target);
					if ("error" in collected) return text(`${collected.error} 请自己用电脑工具完成。`);
					const bad = validateCandidates(collected.candidates);
					if (bad) return text(`候选不可用（${bad}）。请自己用电脑工具完成。`);

					const chooser = buildChooser(s);
					if (!chooser) return text(s.kind === "systemone" ? "原生 Jev 没有配置 API Key（TYPESAFE_API_KEY / OPENROUTER_API_KEY），快速路径跳过。请自己完成。" : "快速操作模型没有选好模型，快速路径跳过。请自己完成。");

					const key = `${opts.agentId}:${prefix}:${pid}:${windowId}`;
					const res = await selectFastAction({
						key,
						goal,
						candidates: collected.candidates,
						chooser,
						settings: s,
						signal,
						onUsage: (u) => {
							try {
								recordUsage({ agentId: opts.agentId, provider: u.provider, model: u.model, conversationId: opts.conversationId ?? null, subagentId: opts.taskId ?? null, input: u.input, output: u.output, cacheRead: 0, cacheWrite: 0 });
							} catch (e) {
								console.error("[fast-computer] 记录用量失败", e);
							}
						},
					});

					if (res.kind === "disabled") return text("快速操作模型没有开启。请自己完成。");
					if (res.kind === "fallback") return text(`快速路径跳过（${res.reason}${res.detail ? `：${res.detail}` : ""}）。请自己用电脑工具完成，不要重复调用本工具。`);
					const out = await ctx.executeTool(res.candidate.tool, res.candidate.args, { signal });
					const note = out.isError ? "执行返回错误。" : "已执行。";
					return text(`快速模型选了「${res.candidate.label}」（${res.uncalibrated ? "无原生校准概率，替代模型" : `confidence ${res.confidence ?? "—"}`}）。${note}${outcomeText(out) ? `\n${outcomeText(out).slice(0, 2000)}` : ""}\n请用独立来源核验结果再决定下一步。`);
				},
			});
		},
	};
}

function resolvePrefix(ctx: ExtensionToolContext, requested: unknown): string | null {
	const names = ctx.tools.map((t) => t.name);
	const host = "mcp__hostpc__";
	const sandbox = "mcp__computer__";
	if (requested === "hostpc") return names.some((n) => n.startsWith(host)) ? host : null;
	if (requested === "computer") return names.some((n) => n.startsWith(sandbox)) ? sandbox : null;
	if (names.some((n) => n.startsWith(host))) return host;
	if (names.some((n) => n.startsWith(sandbox))) return sandbox;
	return null;
}

async function collectCandidates(ctx: ExtensionToolContext, prefix: string, target: { pid: number; window_id: number }): Promise<{ candidates: FastActionCandidate[] } | { error: string }> {
	const r = await ctx.executeTool(`${prefix}get_window_state`, { ...target, include_accessibility_tree: true, include_screenshot: false });
	if (r.isError) return { error: `读取窗口状态失败：${outcomeText(r).slice(0, 300)}` };
	const candidates = clickCandidatesFromWindowState(prefix, target, r.result?.structuredContent);
	if (!candidates.length) return { error: "当前窗口没有可点击的候选控件。" };
	return { candidates };
}
